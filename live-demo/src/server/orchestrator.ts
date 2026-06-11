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
import {
  bigintToDecimal,
  boundedRandomAmount,
  chooseHealthLabel,
  tickToBaseQuotePrice,
  ZERO_HASH,
} from '../shared/math.js';
import type { LiveSnapshot, TraderView } from '../shared/types.js';

const MIN_SQRT_PRICE_LIMIT = 4_295_128_740n;
const MAX_SQRT_PRICE_LIMIT = 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_341n;
const TOKEN_READY_BALANCE = parseUnits('20', 18);
const APPROVAL_FLOOR = parseUnits('1000000', 18);

type RuntimeTrader = StoredTrader & {
  swapsSubmitted: number;
  swapsConfirmed: number;
  swapsFailed: number;
  ready: boolean;
  busy: boolean;
  setupStatus: 'setup' | 'ready' | 'blocked' | 'trading';
  latestNonce: number;
  pendingNonce: number;
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
    this.stopTrading();
    this.stopKeeper();
    this.events.emit('info', 'All live demo loops stopped.');
    return this.snapshot();
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
      const { walletClient } = makeWalletClient(trader.privateKey, this.config.writeRpcUrl);
      const zeroForOne = Math.random() > 0.5;
      const amount = boundedRandomAmount(this.config.minSwapAmount, this.config.maxSwapAmount);
      const hash = await this.txCoordinator.send(trader.address, `trader ${trader.id} swap`, (attempt) =>
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
      );

      trader.swapsSubmitted++;
      trader.lastTx = hash;
      this.noteConfirmedTx();
      this.events.emit('swap', `Trader ${trader.id} submitted ${zeroForOne ? 'USDC -> WETH' : 'WETH -> USDC'} swap.`, {
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
    const { walletClient } = makeWalletClient(trader.privateKey, this.config.writeRpcUrl);
    const balance = await this.publicClient.readContract({
      address: token,
      abi: demoErc20Abi,
      functionName: 'balanceOf',
      args: [trader.address],
    });
    if (balance < TOKEN_READY_BALANCE) {
      const hash = await this.txCoordinator.send(trader.address, `trader ${trader.id} faucet`, (attempt) =>
        walletClient.writeContract({
          address: token,
          abi: demoErc20Abi,
          functionName: 'faucet',
          gas: 200_000n,
          nonce: attempt.nonce,
          ...feeFields(attempt),
        }),
      );
      this.noteConfirmedTx();
    }

    const allowance = await this.readAllowance(trader.address, token);
    if (allowance < APPROVAL_FLOOR) {
      try {
        const hash = await this.txCoordinator.send(trader.address, `trader ${trader.id} approve`, (attempt) =>
          walletClient.writeContract({
            address: token,
            abi: demoErc20Abi,
            functionName: 'approve',
            args: [this.deployment.poolSwapTest, maxUint256],
            gas: 200_000n,
            nonce: attempt.nonce,
            ...feeFields(attempt),
          }),
        );
        this.noteConfirmedTx();
        this.events.emit('token', `Trader ${trader.id} approval confirmed.`, { trader: trader.address, txHash: hash });
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
        await this.refreshTraderNonce(trader).catch(() => undefined);
        return {
          id: trader.id,
          address: trader.address,
          setupStatus: trader.setupStatus,
          latestNonce: trader.latestNonce,
          pendingNonce: trader.pendingNonce,
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
    };
  }

  private async refreshTraderNonce(trader: RuntimeTrader) {
    const snapshot = await this.txCoordinator.nonces(trader.address);
    trader.latestNonce = snapshot.latestNonce;
    trader.pendingNonce = snapshot.pendingNonce;
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
