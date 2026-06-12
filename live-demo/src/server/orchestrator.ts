import {
  formatEther,
  formatUnits,
  maxUint256,
  parseUnits,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { demoErc20Abi, demoHedgeAdapterAbi, poolManagerSwapEvent, poolSwapTestAbi, productionHookAbi } from './abi.js';
import { configView, poolKeyFromDeployment, type Deployment, type LiveDemoConfig, type PoolKey } from './config.js';
import { makePublicClient, makeWalletClient, makeWritePublicClient } from './clients.js';
import { loadOrCreateTraders, readTraders, rotateTraders, type StoredTrader } from './walletStore.js';
import { EventBus } from './eventBus.js';
import { collectLogsInChunks, initialBackfillFromBlock, nextBlockAfterFailedRange } from './logRanges.js';
import { PendingNonceGapError, TxCoordinator } from './txCoordinator.js';
import { TraderRpcRouter } from './rpcRouter.js';
import {
  bigintToDecimal,
  boundedRandomAmount,
  chooseHealthLabel,
  tickToBaseQuotePrice,
  ZERO_HASH,
} from '../shared/math.js';
import type { ForkShowcaseStatus, LiveSnapshot, TraderView } from '../shared/types.js';

const MIN_SQRT_PRICE_LIMIT = 4_295_128_740n;
const MAX_SQRT_PRICE_LIMIT = 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_341n;
const TOKEN_READY_BALANCE = parseUnits('20', 18);
const APPROVAL_FLOOR = parseUnits('1000000', 18);
const ZERO_BYTES = `0x${'0'.repeat(64)}` as Hex;

type RuntimeTrader = StoredTrader & {
  swapsSubmitted: number;
  swapsConfirmed: number;
  swapsFailed: number;
  ready: boolean;
  busy: boolean;
  setupStatus: 'setup' | 'ready' | 'blocked' | 'trading';
  latestNonce: number;
  pendingNonce: number;
  rpcLabel: string;
  rpcCoolingDown: boolean;
  rpcCooldownMs: number;
  lastRpcError?: string;
  nativeBalanceWei?: bigint;
  token0Balance?: bigint;
  token1Balance?: bigint;
  lastBalanceRefreshAt: number;
  lastTx?: Hex;
  lastError?: string;
};

type ProductionRiskState = {
  poolBaseExposure: bigint;
  hedgePositionBase: bigint;
  targetHedgeBase: bigint;
  pendingOrderBase: bigint;
  netBaseDelta: bigint;
  realizedPnlUsd: bigint;
  unrealizedPnlUsd: bigint;
  collateralUsd: bigint;
  initialCollateralUsd: bigint;
  lastMarkPrice: bigint;
  lastSnapshotTimestamp: bigint;
  pendingOrderReadyAt: bigint;
  lastRebalanceTimestamp: bigint;
  lpBaseDeposited: bigint;
  lpBaseWithdrawn: bigint;
  lpBaseFeesAccrued: bigint;
  pendingOrderId: Hex;
  adapterHealthy: boolean;
  healthMode: number;
};

type ProductionPoolConfig = {
  hedgeThresholdBase: bigint;
};

type LatestPoolPrice = {
  tick: number | null;
  priceUsd: number | null;
  lastScannedBlock: bigint | null;
};

export class LiveDemoOrchestrator {
  readonly publicClient;
  readonly writePublicClient;
  readonly deployer;
  readonly txCoordinator;
  readonly traderRpcRouter;
  readonly poolKey;
  #traders: RuntimeTrader[] = [];
  #tradingTimers: NodeJS.Timeout[] = [];
  #keeperTimer?: NodeJS.Timeout;
  #snapshotTimer?: NodeJS.Timeout;
  #setupPromise?: Promise<void>;
  #startedAt?: number;
  #lastTxAt = 0;
  #txSubmitted = 0;
  #txConfirmed = 0;
  #txFailed = 0;
  #poolPrice: LatestPoolPrice = { tick: null, priceUsd: null, lastScannedBlock: null };
  #forkShowcase: ForkShowcaseStatus = stoppedShowcase();
  #forkShowcaseTimers = new Set<NodeJS.Timeout>();
  #forkShowcasePromise?: Promise<void>;
  #forkShowcaseStopping = false;
  #forkShowcaseConsecutiveErrors = 0;

  constructor(
    readonly config: LiveDemoConfig,
    readonly deployment: Deployment,
    readonly events: EventBus,
  ) {
    this.publicClient = makePublicClient(config.rpcUrls);
    this.writePublicClient = makeWritePublicClient(config.writeRpcUrl);
    this.deployer = makeWalletClient(config.privateKey, config.writeRpcUrl);
    this.txCoordinator = new TxCoordinator(this.writePublicClient, {
      replacementFeeBumpBps: config.replacementFeeBumpBps,
      nonceConfirmTimeoutMs: config.nonceConfirmTimeoutMs,
      onEvent: (kind, message, extra) => this.events.emit(kind, message, extra),
    });
    this.traderRpcRouter = new TraderRpcRouter(config.writeRpcUrls, {
      replacementFeeBumpBps: config.replacementFeeBumpBps,
      nonceConfirmTimeoutMs: config.nonceConfirmTimeoutMs,
      cooldownMs: config.rpcCooldownMs,
      retryAttempts: config.rpcRetryAttempts,
      onEvent: (kind, message, extra) => this.events.emit(kind, message, extra),
    });
    this.poolKey = poolKeyFromDeployment(deployment);
  }

  async prepareWallets() {
    this.#traders = loadOrCreateTraders(this.config).map((trader) => this.#runtimeTrader(trader));
    this.events.emit('wallet', `Prepared ${this.#traders.length} trader wallets.`);
    await this.refreshSnapshot();
    return this.snapshot();
  }

  async rotateWallets() {
    this.stopTrading();
    this.#traders = rotateTraders(this.config).map((trader) => this.#runtimeTrader(trader));
    this.events.emit('wallet', `Rotated trader fleet and archived the previous state file.`);
    await this.refreshAllNonces();
    return this.snapshot();
  }

  async refreshAllNonces() {
    this.ensureTradersLoaded();
    await Promise.all(this.#traders.map((trader) => this.refreshTraderNonce(trader)));
    this.events.emit('wallet', 'Refreshed trader nonces.');
    return this.snapshot();
  }

  async fundWallets() {
    this.ensureTradersLoaded();
    const needs = await Promise.all(
      this.#traders.map(async (trader) => ({
        trader,
        balance: await this.publicClient.getBalance({ address: trader.address }),
      })),
    );
    const totalNeeded = needs.reduce((sum, item) => sum + positive(this.config.traderFundingWei - item.balance), 0n);
    const gasReserve = parseUnits('0.02', 18);
    const deployerBalance = await this.publicClient.getBalance({ address: this.deployer.account.address });
    if (deployerBalance < totalNeeded + gasReserve) {
      throw new Error(
        `Insufficient deployer balance. Need ${formatEther(totalNeeded + gasReserve)} ETH including reserve; have ${formatEther(
          deployerBalance,
        )} ETH.`,
      );
    }

    for (const item of needs) {
      const topUp = positive(this.config.traderFundingWei - item.balance);
      if (topUp === 0n) continue;
      const hash = await this.txCoordinator.send(this.deployer.account.address, `fund trader ${item.trader.id}`, (attempt) =>
        this.deployer.walletClient.sendTransaction({
          to: item.trader.address,
          value: topUp,
          nonce: attempt.nonce,
          ...feeFields(attempt),
        }),
      );
      this.noteConfirmedTx();
      this.events.emit('funding', `Funding trader ${item.trader.id} with ${formatEther(topUp)} ETH.`, {
        txHash: hash,
        trader: item.trader.address,
      });
    }

    await this.refreshSnapshot();
    return this.snapshot();
  }

  async topUpForkBalancesForShowcase() {
    if (this.config.mode !== 'fork') return;
    this.ensureTradersLoaded();
    const deployerTarget = parseUnits('100', 18);
    const traderTarget = this.config.traderFundingWei + parseUnits('0.05', 18);
    await this.setAnvilBalance(this.deployer.account.address, deployerTarget);
    await Promise.all(this.#traders.map((trader) => this.setAnvilBalance(trader.address, traderTarget)));
    for (const trader of this.#traders) {
      trader.nativeBalanceWei = traderTarget;
      trader.lastBalanceRefreshAt = Date.now();
    }
    this.events.emit(
      'funding',
      `Fork showcase topped up local Anvil balances: deployer ${formatEther(deployerTarget)} ETH, traders ${formatEther(traderTarget)} ETH each.`,
    );
  }

  async startTrading() {
    this.ensureTradersLoaded();
    if (this.#tradingTimers.length > 0) return this.snapshot();
    this.#startedAt = Date.now();
    if (!this.#setupPromise) {
      this.#setupPromise = this.ensureAllTraderTokensReady().finally(() => {
        this.#setupPromise = undefined;
      });
    }
    await this.#setupPromise;

    const cadence = Math.max(this.config.swapIntervalMs * this.#traders.length, this.config.minTxIntervalMs * this.#traders.length);
    const activeTraders = this.#traders.filter((trader) => trader.setupStatus === 'ready');
    activeTraders.forEach((trader, index) => {
      const firstDelay = Math.floor((cadence / this.#traders.length) * index);
      const timer = setTimeout(() => this.traderLoop(trader, cadence), firstDelay);
      this.#tradingTimers.push(timer);
    });

    this.events.emit('info', `Started ${activeTraders.length}/${this.#traders.length} trader loops at ~${Math.round(cadence / Math.max(1, activeTraders.length))}ms aggregate cadence.`);
    return this.snapshot();
  }

  stopTrading() {
    for (const timer of this.#tradingTimers) clearTimeout(timer);
    this.#tradingTimers = [];
    this.events.emit('info', 'Trading loops stopped.');
    return this.snapshot();
  }

  async startKeeper() {
    if (this.#keeperTimer) return this.snapshot();
    await this.runKeeperTick();
    this.#keeperTimer = setInterval(() => {
      this.runKeeperTick().catch((error) => this.events.emit('error', cleanError(error)));
    }, this.config.keeperIntervalMs);
    this.events.emit('keeper', 'Keeper loop started.');
    return this.snapshot();
  }

  stopKeeper() {
    if (this.#keeperTimer) clearInterval(this.#keeperTimer);
    this.#keeperTimer = undefined;
    this.events.emit('keeper', 'Keeper loop stopped.');
    return this.snapshot();
  }

  stopAll() {
    this.stopForkShowcaseLoops();
    this.stopTrading();
    this.stopKeeper();
    this.events.emit('info', 'All live demo loops stopped.');
    return this.snapshot();
  }

  async startForkShowcase() {
    if (this.#forkShowcase.status === 'setup' || this.#forkShowcase.status === 'running' || this.#forkShowcase.status === 'recovering') {
      return this.snapshot();
    }
    if (this.config.mode !== 'fork') throw new Error('Fork showcase requires LIVE_MODE=fork. Start with npm run dev:fork.');
    if (!isLocalRpc(this.config.writeRpcUrl) || !this.config.rpcUrls.every(isLocalRpc)) {
      throw new Error('Fork showcase only runs against a local Anvil RPC.');
    }

    this.#forkShowcaseStopping = false;
    this.#forkShowcaseConsecutiveErrors = 0;
    this.#forkShowcase = {
      ...stoppedShowcase(),
      status: 'setup',
      phase: 'setup',
      startedAt: Date.now(),
      lastAction: 'Starting fork showcase',
    };
    this.events.emit('state', 'Fork showcase starting.');
    this.#forkShowcasePromise = this.runForkShowcase().catch((error) => {
      this.stopForkShowcaseLoops();
      this.#forkShowcase.status = 'failed';
      this.#forkShowcase.phase = 'failed';
      this.#forkShowcase.error = cleanError(error);
      this.#forkShowcase.lastAction = this.#forkShowcase.error;
      this.events.emit('error', `Fork showcase failed: ${this.#forkShowcase.error}`);
    });
    return this.snapshot();
  }

  async stopForkShowcase() {
    this.#forkShowcaseStopping = true;
    this.#forkShowcase.status = 'stopping';
    this.#forkShowcase.phase = 'stopping';
    this.#forkShowcase.lastAction = 'Stopping fork showcase';
    this.stopForkShowcaseLoops();
    this.stopTrading();
    this.stopKeeper();
    this.#forkShowcase.status = 'stopped';
    this.#forkShowcase.phase = 'stopped';
    this.#forkShowcase.lastAction = 'Fork showcase stopped';
    this.events.emit('state', 'Fork showcase stopped.');
    return this.snapshot();
  }

  async forkShowcaseSnapshot() {
    return this.forkShowcaseStatus();
  }

  async triggerDefensiveScenario() {
    const hash = await this.txCoordinator.send(this.deployer.account.address, 'adapter.setHealthy(false)', (attempt) =>
      this.deployer.walletClient.writeContract({
        address: this.deployment.hedgeAdapter,
        abi: demoHedgeAdapterAbi,
        functionName: 'setHealthy',
        args: [this.deployment.poolId, false],
        gas: 300_000n,
        nonce: attempt.nonce,
        ...feeFields(attempt),
      }),
    );
    this.noteConfirmedTx();
    this.events.emit('scenario', 'Adapter set unhealthy. The hook should move defensive after sync.', { txHash: hash });
    await this.syncSnapshot();
    return this.snapshot();
  }

  async recoverScenario() {
    const hash = await this.txCoordinator.send(this.deployer.account.address, 'adapter.resetDemoSnapshot', (attempt) =>
      this.deployer.walletClient.writeContract({
        address: this.deployment.hedgeAdapter,
        abi: demoHedgeAdapterAbi,
        functionName: 'resetDemoSnapshot',
        args: [this.deployment.poolId, parseUnits('2000', 18), parseUnits('100000', 18)],
        gas: 300_000n,
        nonce: attempt.nonce,
        ...feeFields(attempt),
      }),
    );
    this.noteConfirmedTx();
    this.events.emit('scenario', 'Adapter snapshot recovered to healthy collateral and mark price.', { txHash: hash });
    await this.syncSnapshot();
    return this.snapshot();
  }

  startSnapshotLoop() {
    if (this.#snapshotTimer) return;
    this.#snapshotTimer = setInterval(() => {
      this.refreshSnapshot().catch((error) => this.events.emit('error', cleanError(error)));
    }, 2500);
  }

  async refreshSnapshot() {
    const snapshot = await this.snapshot();
    this.events.snapshot(snapshot);
    return snapshot;
  }

  async snapshot(): Promise<LiveSnapshot> {
    if (this.#traders.length === 0) {
      this.#traders = readTraders(this.config).map((trader) => this.#runtimeTrader(trader));
    }

    const [blockNumber, risk, poolConfig] = await Promise.all([
      this.publicClient.getBlockNumber(),
      this.readRiskState(),
      this.readPoolConfig(),
    ]);
    await this.updatePoolPrice(blockNumber);
    const traders = await this.traderViews();
    const status = chooseHealthLabel({
      netBaseDelta: risk.netBaseDelta,
      hedgeThresholdBase: poolConfig.hedgeThresholdBase,
      pendingOrderBase: risk.pendingOrderBase,
      pendingOrderId: risk.pendingOrderId,
      adapterHealthy: risk.adapterHealthy,
      healthMode: risk.healthMode,
    });

    return {
      timestamp: Date.now(),
      blockNumber: blockNumber.toString(),
      status,
      runningTrading: this.#tradingTimers.length > 0,
      runningKeeper: Boolean(this.#keeperTimer),
      poolPriceUsd: this.#poolPrice.priceUsd,
      tick: this.#poolPrice.tick,
      lastMarkPriceUsd: bigintToDecimal(risk.lastMarkPrice, 18, 2),
      poolBaseExposure: bigintToDecimal(risk.poolBaseExposure),
      hedgePositionBase: bigintToDecimal(risk.hedgePositionBase),
      netBaseDelta: bigintToDecimal(risk.netBaseDelta),
      pendingOrderBase: bigintToDecimal(risk.pendingOrderBase),
      targetHedgeBase: bigintToDecimal(risk.targetHedgeBase),
      collateralUsd: bigintToDecimal(risk.collateralUsd, 18, 2),
      realizedPnlUsd: bigintToDecimal(risk.realizedPnlUsd, 18, 2),
      unrealizedPnlUsd: bigintToDecimal(risk.unrealizedPnlUsd, 18, 2),
      pendingOrderId: risk.pendingOrderId,
      pendingOrderReadyAt: risk.pendingOrderReadyAt.toString(),
      adapterHealthy: risk.adapterHealthy,
      healthMode: risk.healthMode,
      lpBaseDeposited: bigintToDecimal(risk.lpBaseDeposited),
      lpBaseWithdrawn: bigintToDecimal(risk.lpBaseWithdrawn),
      lpBaseFeesAccrued: bigintToDecimal(risk.lpBaseFeesAccrued),
      txSubmitted: this.#txSubmitted,
      txConfirmed: this.#txConfirmed,
      txFailed: this.#txFailed,
      rpcHealth: this.traderRpcRouter.health(),
      forkShowcase: this.forkShowcaseStatus(),
      traders,
      config: configView(this.config, this.deployment),
    };
  }

  async runKeeperTick() {
    const keeperAllowed = await this.publicClient.readContract({
      address: this.deployment.hook,
      abi: productionHookAbi,
      functionName: 'keepers',
      args: [this.deployer.account.address],
    });
    if (!keeperAllowed) {
      this.events.emit('keeper', 'Deployer is not authorized as keeper.');
      return;
    }

    await this.syncSnapshot();
    const [risk, config] = await Promise.all([this.readRiskState(), this.readPoolConfig()]);
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (risk.pendingOrderId !== ZERO_HASH || risk.pendingOrderBase !== 0n) {
      if (risk.pendingOrderReadyAt !== 0n && now >= risk.pendingOrderReadyAt) {
        const hash = await this.txCoordinator.send(this.deployer.account.address, 'hook.settleHedgeOrder', (attempt) =>
          this.deployer.walletClient.writeContract({
            address: this.deployment.hook,
            abi: productionHookAbi,
            functionName: 'settleHedgeOrder',
            args: [this.poolKey],
            gas: 1_000_000n,
            nonce: attempt.nonce,
            ...feeFields(attempt),
          }),
        );
        this.noteConfirmedTx();
        this.events.emit('keeper', `Settling hedge order ${risk.pendingOrderId.slice(0, 10)}...`, { txHash: hash });
      } else {
        this.events.emit('keeper', 'Pending hedge order is not ready yet.');
      }
      return;
    }

    if (abs(risk.netBaseDelta) < config.hedgeThresholdBase) {
      this.events.emit('keeper', `Net delta ${bigintToDecimal(risk.netBaseDelta)} is inside threshold.`);
      return;
    }
    if (risk.lastMarkPrice === 0n) {
      this.events.emit('keeper', 'Skipping rebalance because mark price is zero.');
      return;
    }

    const hedgeDelta = -risk.netBaseDelta;
    const acceptablePrice = computeAcceptablePrice(risk.lastMarkPrice, hedgeDelta, this.config.maxHedgeSlippageBps);
    const hash = await this.txCoordinator.send(this.deployer.account.address, 'hook.rebalance', (attempt) =>
      this.deployer.walletClient.writeContract({
        address: this.deployment.hook,
        abi: productionHookAbi,
        functionName: 'rebalance',
        args: [this.poolKey, acceptablePrice],
        gas: 1_000_000n,
        nonce: attempt.nonce,
        ...feeFields(attempt),
      }),
    );
    this.noteConfirmedTx();
    this.events.emit('keeper', `Committed hedge for ${bigintToDecimal(hedgeDelta)} base.`, { txHash: hash });
  }

  private async runForkShowcase() {
    await this.showcaseSetup();
    await this.startTrading();
    await this.startKeeper();
    this.#forkShowcase.status = 'running';
    this.#forkShowcase.phase = 'running';

    while (!this.#forkShowcaseStopping) {
      try {
        await this.runForkShowcaseCycle();
        this.#forkShowcaseConsecutiveErrors = 0;
      } catch (error) {
        this.#forkShowcaseConsecutiveErrors++;
        this.#forkShowcase.error = cleanError(error);
        this.#forkShowcase.lastAction = `Showcase loop error: ${this.#forkShowcase.error}`;
        this.events.emit('warning', this.#forkShowcase.lastAction);
        if (this.#forkShowcaseConsecutiveErrors >= this.config.forkMaxConsecutiveErrors) throw error;
        await this.showcaseDelay(this.config.forkBackoffMs);
      }
    }
  }

  private async showcaseSetup() {
    this.setShowcasePhase('setup', 'Preparing fork traders and adapter baseline');
    await this.prepareWallets();
    await this.topUpForkBalancesForShowcase();
    await this.fundWallets();
    await this.recoverShowcaseBaseline();
    await this.syncSnapshot();
    await this.showcaseDelay(500);
  }

  private async runForkShowcaseCycle() {
    this.#forkShowcase.loop++;
    this.#forkShowcase.checks = freshShowcaseChecks();
    const priceDirection = this.#forkShowcase.loop % 2 === 0 ? 1n : -1n;
    const shockMark = this.config.showcaseMarkPriceStart + priceDirection * this.config.showcaseMarkPriceStep;

    this.setShowcasePhase('build exposure', 'Waiting for trader flow to build pool exposure');
    await this.waitForExposure();
    this.#forkShowcase.checks.exposureBuilt = true;

    this.setShowcasePhase('hedge', 'Programming settlement economics and running keeper');
    await this.setNextShowcaseSettlement(shockMark);
    await this.waitForNeutralized();
    this.#forkShowcase.checks.hedgeSettled = true;
    this.#forkShowcase.checks.netDeltaNearNeutral = true;

    this.setShowcasePhase('PnL shock', 'Applying realized and unrealized hedge losses');
    await this.setShowcasePnl(-this.config.showcaseRealizedLossUsd, -this.config.showcaseUnrealizedLossUsd);
    await this.syncSnapshot();
    this.#forkShowcase.checks.pnlApplied = true;

    this.setShowcasePhase('collateral pressure', 'Lowering collateral to force defensive health');
    await this.setShowcaseCollateral(this.config.showcaseLowCollateralUsd);
    await this.syncSnapshot();
    this.#forkShowcase.checks.collateralChanged = true;

    this.setShowcasePhase('defensive', 'Confirming defensive mode blocks worsening flow');
    await this.expectDefensiveWorseningSwapBlocked();
    this.#forkShowcase.checks.defensiveBlockObserved = true;

    this.setShowcasePhase('reducing flow', 'Sending one exposure-reducing swap while defensive');
    await this.executeReducingSwap();

    this.setShowcasePhase('recovery', 'Recovering adapter and returning toward neutral');
    this.#forkShowcase.status = 'recovering';
    await this.recoverShowcaseBaseline();
    await this.syncSnapshot();
    await this.waitForNeutralized();
    this.#forkShowcase.checks.recoveryComplete = true;
    this.#forkShowcase.status = 'running';

    this.setShowcasePhase('loop delay', 'Cycle complete; continuing showcase');
    await this.showcaseDelay(this.config.showcasePhaseDelayMs);
  }

  private async waitForExposure() {
    const deadline = Date.now() + this.config.showcasePhaseDelayMs * 6;
    while (!this.#forkShowcaseStopping && Date.now() < deadline) {
      const risk = await this.readRiskState();
      if (abs(risk.poolBaseExposure) >= this.config.showcaseExposureTargetBase || abs(risk.netBaseDelta) >= this.config.showcaseExposureTargetBase) return;
      const trader = this.firstReadyTrader();
      if (trader) await this.executeRandomSwap(trader).catch((error) => this.events.emit('warning', `Showcase exposure swap failed: ${cleanError(error)}`));
      await this.showcaseDelay(1000);
    }
    throw new Error('Fork showcase could not build enough pool exposure.');
  }

  private async waitForNeutralized() {
    const deadline = Date.now() + this.config.showcasePhaseDelayMs * 8;
    while (!this.#forkShowcaseStopping && Date.now() < deadline) {
      await this.runKeeperTick();
      const risk = await this.readRiskState();
      if (risk.pendingOrderId === ZERO_BYTES && risk.pendingOrderBase === 0n && abs(risk.netBaseDelta) <= this.config.showcaseNetDeltaTargetBase) {
        return;
      }
      await this.showcaseDelay(1000);
    }
    throw new Error('Fork showcase keeper did not return net delta near neutral in time.');
  }

  private async expectDefensiveWorseningSwapBlocked() {
    const risk = await this.readRiskState();
    const worseningZeroForOne = risk.netBaseDelta >= 0n ? Boolean(this.deployment.baseIsCurrency0) : !this.deployment.baseIsCurrency0;
    try {
      await this.executeShowcaseSwap(worseningZeroForOne, parseUnits('0.1', 18), 'defensive worsening probe');
    } catch (error) {
      this.events.emit('scenario', `Defensive worsening swap blocked as expected: ${cleanError(error)}`);
      return;
    }
    throw new Error('Expected exposure-worsening swap to be blocked in defensive mode.');
  }

  private async executeReducingSwap() {
    const risk = await this.readRiskState();
    const worseningZeroForOne = risk.netBaseDelta >= 0n ? Boolean(this.deployment.baseIsCurrency0) : !this.deployment.baseIsCurrency0;
    await this.executeShowcaseSwap(!worseningZeroForOne, parseUnits('0.1', 18), 'defensive reducing swap');
  }

  private async executeShowcaseSwap(zeroForOne: boolean, amount: bigint, label: string) {
    const trader = this.firstReadyTrader();
    if (!trader) throw new Error('No ready fork trader is available for showcase swap.');
    await this.waitForRateSlot();
    const { hash, rpcLabel } = await this.traderRpcRouter.sendTrader({
      traderId: trader.id,
      address: trader.address,
      privateKey: trader.privateKey,
      label,
      send: ({ walletClient, attempt }) =>
        walletClient.writeContract({
          address: this.deployment.poolSwapTest,
          abi: poolSwapTestAbi,
          functionName: 'swap',
          args: [
            this.poolKey,
            {
              zeroForOne,
              amountSpecified: -amount,
              sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE_LIMIT : MAX_SQRT_PRICE_LIMIT,
            },
            { takeClaims: false, settleUsingBurn: false },
            '0x',
          ],
          gas: 1_000_000n,
          nonce: attempt.nonce,
          ...feeFields(attempt),
        }),
    });
    trader.lastTx = hash;
    this.updateTraderRpcStatus(trader);
    this.noteConfirmedTx();
    this.setShowcaseTx(hash, `${label} via ${rpcLabel}`);
    return hash;
  }

  private async setNextShowcaseSettlement(markPrice: bigint) {
    const hash = await this.txCoordinator.send(this.deployer.account.address, 'adapter.setNextSettlement', (attempt) =>
      this.deployer.walletClient.writeContract({
        address: this.deployment.hedgeAdapter,
        abi: demoHedgeAdapterAbi,
        functionName: 'setNextSettlement',
        args: [this.deployment.poolId, 0n, -this.config.showcaseRealizedLossUsd, markPrice],
        gas: 300_000n,
        nonce: attempt.nonce,
        ...feeFields(attempt),
      }),
    );
    this.noteConfirmedTx();
    this.setShowcaseTx(hash, `Programmed next settlement at ${bigintToDecimal(markPrice, 18, 2)}`);
  }

  private async setShowcasePnl(realizedPnlUsd: bigint, unrealizedPnlUsd: bigint) {
    const hash = await this.txCoordinator.send(this.deployer.account.address, 'adapter.setPnl', (attempt) =>
      this.deployer.walletClient.writeContract({
        address: this.deployment.hedgeAdapter,
        abi: demoHedgeAdapterAbi,
        functionName: 'setPnl',
        args: [this.deployment.poolId, realizedPnlUsd, unrealizedPnlUsd],
        gas: 300_000n,
        nonce: attempt.nonce,
        ...feeFields(attempt),
      }),
    );
    this.noteConfirmedTx();
    this.setShowcaseTx(hash, 'Applied showcase hedge PnL');
  }

  private async setShowcaseCollateral(collateralUsd: bigint) {
    const hash = await this.txCoordinator.send(this.deployer.account.address, 'adapter.setCollateralUsd', (attempt) =>
      this.deployer.walletClient.writeContract({
        address: this.deployment.hedgeAdapter,
        abi: demoHedgeAdapterAbi,
        functionName: 'setCollateralUsd',
        args: [this.deployment.poolId, collateralUsd],
        gas: 300_000n,
        nonce: attempt.nonce,
        ...feeFields(attempt),
      }),
    );
    this.noteConfirmedTx();
    this.setShowcaseTx(hash, `Set showcase collateral to ${bigintToDecimal(collateralUsd, 18, 2)}`);
  }

  private async recoverShowcaseBaseline() {
    const hash = await this.txCoordinator.send(this.deployer.account.address, 'adapter.resetDemoSnapshot', (attempt) =>
      this.deployer.walletClient.writeContract({
        address: this.deployment.hedgeAdapter,
        abi: demoHedgeAdapterAbi,
        functionName: 'resetDemoSnapshot',
        args: [this.deployment.poolId, this.config.showcaseMarkPriceStart, parseUnits('100000', 18)],
        gas: 300_000n,
        nonce: attempt.nonce,
        ...feeFields(attempt),
      }),
    );
    this.noteConfirmedTx();
    this.setShowcaseTx(hash, 'Recovered showcase adapter baseline');
  }

  private firstReadyTrader() {
    return this.#traders.find((trader) => trader.ready && trader.setupStatus !== 'blocked') ?? this.#traders[0];
  }

  private setShowcasePhase(phase: string, action: string) {
    this.#forkShowcase.phase = phase;
    this.#forkShowcase.lastAction = action;
    this.events.emit('state', `Fork showcase: ${action}`);
  }

  private setShowcaseTx(hash: Hex, action: string) {
    this.#forkShowcase.lastTx = hash;
    this.#forkShowcase.lastAction = action;
    this.events.emit('state', `Fork showcase: ${action}`, { txHash: hash });
  }

  private async showcaseDelay(ms: number) {
    if (ms <= 0 || this.#forkShowcaseStopping) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.#forkShowcaseTimers.delete(timer);
        resolve();
      }, ms);
      this.#forkShowcaseTimers.add(timer);
    });
  }

  private stopForkShowcaseLoops() {
    this.#forkShowcaseStopping = true;
    for (const timer of this.#forkShowcaseTimers) clearTimeout(timer);
    this.#forkShowcaseTimers.clear();
  }

  private forkShowcaseStatus(): ForkShowcaseStatus {
    return {
      ...this.#forkShowcase,
      elapsedMs: this.#forkShowcase.startedAt ? Date.now() - this.#forkShowcase.startedAt : 0,
      checks: { ...this.#forkShowcase.checks },
    };
  }

  private async traderLoop(trader: RuntimeTrader, cadence: number) {
    if (this.#tradingTimers.length === 0) return;
    try {
      if (this.runtimeExpired()) {
        this.stopTrading();
        return;
      }
      if (!trader.busy) await this.executeRandomSwap(trader);
    } catch (error) {
      trader.swapsFailed++;
      trader.lastError = cleanError(error);
      this.noteFailed();
      this.events.emit('error', `Trader ${trader.id} swap failed: ${trader.lastError}`, { trader: trader.address });
    } finally {
      if (this.#tradingTimers.length > 0) {
        const delay = cadence + Math.floor(Math.random() * this.config.swapIntervalMs);
        const timer = setTimeout(() => this.traderLoop(trader, cadence), delay);
        this.#tradingTimers.push(timer);
      }
    }
  }

  private async executeRandomSwap(trader: RuntimeTrader) {
    await this.waitForRateSlot();
    trader.busy = true;
    try {
      trader.setupStatus = 'trading';
      const zeroForOne = Math.random() > 0.5;
      const amount = boundedRandomAmount(this.config.minSwapAmount, this.config.maxSwapAmount);
      const { hash, rpcLabel } = await this.traderRpcRouter.sendTrader({
        traderId: trader.id,
        address: trader.address,
        privateKey: trader.privateKey,
        label: `trader ${trader.id} swap`,
        send: ({ walletClient, attempt }) =>
        walletClient.writeContract({
          address: this.deployment.poolSwapTest,
          abi: poolSwapTestAbi,
          functionName: 'swap',
          args: [
            this.poolKey,
            {
              zeroForOne,
              amountSpecified: -amount,
              sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE_LIMIT : MAX_SQRT_PRICE_LIMIT,
            },
            { takeClaims: false, settleUsingBurn: false },
            '0x',
          ],
          gas: 1_000_000n,
          nonce: attempt.nonce,
          ...feeFields(attempt),
        }),
      });

      trader.swapsSubmitted++;
      trader.lastTx = hash;
      this.updateTraderRpcStatus(trader);
      this.noteConfirmedTx();
      this.events.emit('swap', `Trader ${trader.id} submitted ${zeroForOne ? 'USDC -> WETH' : 'WETH -> USDC'} swap via ${rpcLabel}.`, {
        txHash: hash,
        trader: trader.address,
      });
      trader.swapsConfirmed++;
      trader.lastError = undefined;
      this.events.emit('swap', `Trader ${trader.id} swap confirmed.`, { txHash: hash, trader: trader.address });
    } finally {
      trader.busy = false;
      if (trader.setupStatus === 'trading') trader.setupStatus = 'ready';
    }
  }

  private async ensureAllTraderTokensReady() {
    for (const trader of this.#traders) {
      trader.setupStatus = 'setup';
      try {
        await this.refreshTraderNonce(trader);
        await this.ensureTokenReady(trader, this.deployment.currency0);
        await this.ensureTokenReady(trader, this.deployment.currency1);
        await this.refreshTraderNonce(trader);
        trader.ready = true;
        trader.setupStatus = 'ready';
        trader.lastError = undefined;
        this.events.emit('token', `Trader ${trader.id} has faucet balances and swap approvals.`, { trader: trader.address });
      } catch (error) {
        trader.ready = false;
        trader.setupStatus = 'blocked';
        trader.lastError = cleanError(error);
        this.events.emit('warning', `Trader ${trader.id} paused during setup: ${trader.lastError}`, { trader: trader.address });
      }
    }
  }

  private async ensureTokenReady(trader: RuntimeTrader, token: Address) {
    const balance = await this.publicClient.readContract({
      address: token,
      abi: demoErc20Abi,
      functionName: 'balanceOf',
      args: [trader.address],
    });
    if (balance < TOKEN_READY_BALANCE) {
      const { hash, rpcLabel } = await this.traderRpcRouter.sendTrader({
        traderId: trader.id,
        address: trader.address,
        privateKey: trader.privateKey,
        label: `trader ${trader.id} faucet`,
        send: ({ walletClient, attempt }) =>
        walletClient.writeContract({
          address: token,
          abi: demoErc20Abi,
          functionName: 'faucet',
          gas: 200_000n,
          nonce: attempt.nonce,
          ...feeFields(attempt),
        }),
      });
      this.events.emit('token', `Trader ${trader.id} faucet confirmed via ${rpcLabel}.`, { trader: trader.address, txHash: hash });
      this.updateTraderRpcStatus(trader);
      this.noteConfirmedTx();
    }

    const allowance = await this.readAllowance(trader.address, token);
    if (allowance < APPROVAL_FLOOR) {
      try {
        const { hash, rpcLabel } = await this.traderRpcRouter.sendTrader({
          traderId: trader.id,
          address: trader.address,
          privateKey: trader.privateKey,
          label: `trader ${trader.id} approve`,
          send: ({ walletClient, attempt }) =>
          walletClient.writeContract({
            address: token,
            abi: demoErc20Abi,
            functionName: 'approve',
            args: [this.deployment.poolSwapTest, maxUint256],
            gas: 200_000n,
            nonce: attempt.nonce,
            ...feeFields(attempt),
          }),
        });
        this.updateTraderRpcStatus(trader);
        this.noteConfirmedTx();
        this.events.emit('token', `Trader ${trader.id} approval confirmed via ${rpcLabel}.`, { trader: trader.address, txHash: hash });
      } catch (error) {
        if (error instanceof PendingNonceGapError) {
          this.events.emit('warning', `Trader ${trader.id} has a pending nonce gap; re-checking allowance.`, {
            trader: trader.address,
          });
        }
        const latestAllowance = await this.readAllowance(trader.address, token);
        if (latestAllowance >= APPROVAL_FLOOR) {
          this.events.emit('token', `Trader ${trader.id} approval already satisfied after retry check.`, { trader: trader.address });
          return;
        }
        throw error;
      }
    } else {
      this.events.emit('token', `Trader ${trader.id} approval already satisfied.`, { trader: trader.address });
    }
  }

  private async readAllowance(owner: Address, token: Address) {
    return this.publicClient.readContract({
      address: token,
      abi: demoErc20Abi,
      functionName: 'allowance',
      args: [owner, this.deployment.poolSwapTest],
    });
  }

  private async syncSnapshot() {
    const hash = await this.txCoordinator.send(this.deployer.account.address, 'hook.syncHedgeSnapshot', (attempt) =>
      this.deployer.walletClient.writeContract({
        address: this.deployment.hook,
        abi: productionHookAbi,
        functionName: 'syncHedgeSnapshot',
        args: [this.poolKey],
        gas: 500_000n,
        nonce: attempt.nonce,
        ...feeFields(attempt),
      }),
    );
    this.noteConfirmedTx();
    this.events.emit('keeper', 'Synced hedge snapshot.', { txHash: hash });
  }

  private async readRiskState(): Promise<ProductionRiskState> {
    const value = await this.publicClient.readContract({
      address: this.deployment.hook,
      abi: productionHookAbi,
      functionName: 'getRiskState',
      args: [this.poolKey],
    });
    return value as ProductionRiskState;
  }

  private async readPoolConfig(): Promise<ProductionPoolConfig> {
    const value = await this.publicClient.readContract({
      address: this.deployment.hook,
      abi: productionHookAbi,
      functionName: 'getPoolConfig',
      args: [this.poolKey],
    });
    return { hedgeThresholdBase: value.hedgeThresholdBase };
  }

  private async traderViews(): Promise<TraderView[]> {
    return Promise.all(
      this.#traders.map(async (trader) => {
        const { nativeBalance, token0Balance, token1Balance } = await this.refreshTraderBalances(trader);
        await this.refreshTraderNonce(trader).catch(() => undefined);
        this.updateTraderRpcStatus(trader);
        return {
          id: trader.id,
          address: trader.address,
          setupStatus: trader.setupStatus,
          latestNonce: trader.latestNonce,
          pendingNonce: trader.pendingNonce,
          rpcLabel: trader.rpcLabel,
          rpcCoolingDown: trader.rpcCoolingDown,
          lastRpcError: trader.lastRpcError,
          nativeBalanceEth: formatEther(nativeBalance),
          token0Balance: formatUnits(token0Balance, 18),
          token1Balance: formatUnits(token1Balance, 18),
          funded: nativeBalance >= this.config.traderFundingWei,
          ready: trader.ready,
          swapsSubmitted: trader.swapsSubmitted,
          swapsConfirmed: trader.swapsConfirmed,
          swapsFailed: trader.swapsFailed,
          lastTx: trader.lastTx,
          lastError: trader.lastError,
        };
      }),
    );
  }

  private async updatePoolPrice(toBlock: bigint) {
    const fromBlock = this.#poolPrice.lastScannedBlock
      ? this.#poolPrice.lastScannedBlock + 1n
      : initialBackfillFromBlock(toBlock, this.config.priceBackfillBlocks);
    if (fromBlock > toBlock) return;
    const logs = await collectLogsInChunks({
      fromBlock,
      toBlock,
      maxSpan: this.config.getLogsBlockSpan,
      getLogs: (range) =>
        this.publicClient.getLogs({
          address: this.deployment.poolManager,
          event: poolManagerSwapEvent,
          args: { id: this.deployment.poolId },
          fromBlock: range.fromBlock,
          toBlock: range.toBlock,
        }),
      onChunkError: (range, error) => {
        this.#poolPrice.lastScannedBlock = nextBlockAfterFailedRange(range) - 1n;
        this.events.emit(
          'warning',
          `Pool price log scan skipped blocks ${range.fromBlock}-${range.toBlock}: ${cleanError(error)}. Using adapter mark fallback.`,
        );
      },
    });
    this.#poolPrice.lastScannedBlock = toBlock;
    const last = logs.at(-1);
    if (!last) return;
    const tick = Number(last.args.tick);
    this.#poolPrice.tick = tick;
    this.#poolPrice.priceUsd = tickToBaseQuotePrice(tick, this.deployment.baseIsCurrency0);
  }

  private async setAnvilBalance(address: Address, balance: bigint) {
    await (this.publicClient as unknown as {
      request(args: { method: string; params: [Address, Hex] }): Promise<unknown>;
    }).request({
      method: 'anvil_setBalance',
      params: [address, `0x${balance.toString(16)}` as Hex],
    });
  }

  private async waitForRateSlot() {
    const wait = this.config.minTxIntervalMs - (Date.now() - this.#lastTxAt);
    if (wait > 0) await sleep(wait);
    this.#lastTxAt = Date.now();
  }

  private runtimeExpired() {
    if (!this.#startedAt) return false;
    return Date.now() - this.#startedAt > this.config.maxRuntimeMinutes * 60_000;
  }

  private ensureTradersLoaded() {
    if (this.#traders.length === 0) this.#traders = readTraders(this.config).map((trader) => this.#runtimeTrader(trader));
    if (this.#traders.length === 0) throw new Error('Prepare wallets before running the live demo.');
  }

  #runtimeTrader(trader: StoredTrader): RuntimeTrader {
    const account = privateKeyToAccount(trader.privateKey);
    return {
      ...trader,
      address: account.address,
      swapsSubmitted: 0,
      swapsConfirmed: 0,
      swapsFailed: 0,
      ready: false,
      busy: false,
      setupStatus: 'setup',
      latestNonce: 0,
      pendingNonce: 0,
      rpcLabel: 'rpc-?',
      rpcCoolingDown: false,
      rpcCooldownMs: 0,
      lastBalanceRefreshAt: 0,
    };
  }

  private async refreshTraderNonce(trader: RuntimeTrader) {
    const snapshot = await this.traderRpcRouter.nonces(trader.address, trader.id);
    trader.latestNonce = snapshot.latestNonce;
    trader.pendingNonce = snapshot.pendingNonce;
  }

  private async refreshTraderBalances(trader: RuntimeTrader) {
    const cached =
      trader.nativeBalanceWei !== undefined && trader.token0Balance !== undefined && trader.token1Balance !== undefined;
    if (cached && Date.now() - trader.lastBalanceRefreshAt < this.config.traderBalanceRefreshMs) {
      return {
        nativeBalance: trader.nativeBalanceWei!,
        token0Balance: trader.token0Balance!,
        token1Balance: trader.token1Balance!,
      };
    }

    try {
      const [nativeBalance, token0Balance, token1Balance] = await Promise.all([
        this.publicClient.getBalance({ address: trader.address }),
        this.publicClient.readContract({
          address: this.deployment.currency0,
          abi: demoErc20Abi,
          functionName: 'balanceOf',
          args: [trader.address],
        }),
        this.publicClient.readContract({
          address: this.deployment.currency1,
          abi: demoErc20Abi,
          functionName: 'balanceOf',
          args: [trader.address],
        }),
      ]);
      trader.nativeBalanceWei = nativeBalance;
      trader.token0Balance = token0Balance;
      trader.token1Balance = token1Balance;
      trader.lastBalanceRefreshAt = Date.now();
      return { nativeBalance, token0Balance, token1Balance };
    } catch (error) {
      this.events.emit('warning', `Trader ${trader.id} balance refresh failed: ${cleanError(error)}.`);
      return {
        nativeBalance: trader.nativeBalanceWei ?? 0n,
        token0Balance: trader.token0Balance ?? 0n,
        token1Balance: trader.token1Balance ?? 0n,
      };
    }
  }

  private updateTraderRpcStatus(trader: RuntimeTrader) {
    const status = this.traderRpcRouter.traderStatus(trader.address, trader.id);
    trader.rpcLabel = status.label;
    trader.rpcCoolingDown = status.coolingDown;
    trader.rpcCooldownMs = status.cooldownMs;
    trader.lastRpcError = status.lastError;
  }

  private noteConfirmedTx() {
    this.#txSubmitted++;
    this.#txConfirmed++;
  }

  private noteFailed() {
    this.#txFailed++;
  }
}

function computeAcceptablePrice(markPrice: bigint, hedgeBaseDelta: bigint, slippageBps: bigint) {
  if (hedgeBaseDelta > 0n) return (markPrice * (10_000n + slippageBps)) / 10_000n;
  return (markPrice * (10_000n - slippageBps)) / 10_000n;
}

function feeFields(attempt: { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }) {
  return {
    ...(attempt.maxFeePerGas !== undefined ? { maxFeePerGas: attempt.maxFeePerGas } : {}),
    ...(attempt.maxPriorityFeePerGas !== undefined ? { maxPriorityFeePerGas: attempt.maxPriorityFeePerGas } : {}),
  };
}

function positive(value: bigint) {
  return value > 0n ? value : 0n;
}

function abs(value: bigint) {
  return value < 0n ? -value : value;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanError(error: unknown) {
  if (error instanceof Error) return error.message.split('\n')[0] || error.message;
  return String(error);
}

function stoppedShowcase(): ForkShowcaseStatus {
  return {
    status: 'stopped',
    phase: 'stopped',
    loop: 0,
    startedAt: null,
    elapsedMs: 0,
    lastAction: 'Fork showcase is stopped',
    checks: freshShowcaseChecks(),
  };
}

function freshShowcaseChecks(): ForkShowcaseStatus['checks'] {
  return {
    exposureBuilt: false,
    hedgeSettled: false,
    netDeltaNearNeutral: false,
    pnlApplied: false,
    collateralChanged: false,
    defensiveBlockObserved: false,
    recoveryComplete: false,
  };
}

function isLocalRpc(url: string) {
  return url.includes('127.0.0.1') || url.includes('localhost');
}
