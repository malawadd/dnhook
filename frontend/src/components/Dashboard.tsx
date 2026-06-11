'use client';

import { ConnectButton } from '@rainbow-me/rainbowkit';
import {
  Activity,
  ArrowDownUp,
  CheckCircle2,
  FlaskConical,
  Gauge,
  Pause,
  Play,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  TriangleAlert,
  Wallet,
} from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { BaseError, formatUnits, maxUint256, parseUnits, type Address, type Hash } from 'viem';
import {
  useAccount,
  useChainId,
  usePublicClient,
  useReadContract,
  useSwitchChain,
  useWriteContract,
} from 'wagmi';
import {
  deltaNeutralHookAbi,
  demoErc20Abi,
  demoHedgeAdapterAbi,
  poolSwapTestAbi,
  productionHookAbi,
  productionLiquidityRouterAbi,
} from '@/lib/abis';
import { deploymentReady, modeConfigs, poolKeyFor, type DemoMode } from '@/lib/deployment';

const MIN_SQRT_PRICE_LIMIT = 4_295_128_740n;
const MAX_SQRT_PRICE_LIMIT = 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_341n;
const Q96 = 2n ** 96n;
const SALT_ZERO = `0x${'0'.repeat(64)}` as const;

type CapstoneRiskState = {
  poolBaseExposure: bigint;
  reportedHedgeBase: bigint;
  pendingHedgeBase: bigint;
  lastReferencePriceX96: bigint;
  lastReferenceTimestamp: bigint;
  hedgeNonce: bigint;
  paused: boolean;
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
  pendingOrderId: `0x${string}`;
  adapterHealthy: boolean;
  healthMode: number;
};

type ProductionPoolConfig = {
  hedgeThresholdBase: bigint;
  maxResidualDeltaBase: bigint;
  maxSnapshotAge: bigint;
  minCollateralUsd: bigint;
  minCollateralRatioBps: bigint;
  maxLeverageBps: bigint;
  maxLossBps: bigint;
};

export function Dashboard() {
  const [mode, setMode] = useState<DemoMode>('capstone');
  const [swapAmount, setSwapAmount] = useState('1');
  const [referencePrice, setReferencePrice] = useState('2000');
  const [acceptablePrice, setAcceptablePrice] = useState('2000');
  const [liquidityAmount, setLiquidityAmount] = useState('10');
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<Hash | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const active = modeConfigs[mode];
  const deployment = active.deployment;
  const poolKey = useMemo(() => poolKeyFor(deployment), [deployment]);
  const ready = deploymentReady(deployment);
  const onTargetNetwork = chainId === active.chainId;
  const canWrite = isConnected && onTargetNetwork && ready;
  const isProduction = mode === 'production';
  const hookAbi = isProduction ? productionHookAbi : deltaNeutralHookAbi;
  const spender = isProduction ? deployment.poolSwapTest : deployment.poolSwapTest;
  const liquidityRouter = deployment.liquidityRouter ?? deployment.poolModifyLiquidityTest ?? deployment.poolSwapTest;
  const strategyId = deployment.poolId;

  const ownerRead = useReadContract({
    address: deployment.hook,
    abi: hookAbi,
    functionName: 'owner',
    query: { enabled: ready },
  });
  const keeperRead = useReadContract({
    address: deployment.hook,
    abi: hookAbi,
    functionName: 'keepers',
    args: [address ?? deployment.hook],
    query: { enabled: ready && Boolean(address) },
  });
  const capstonePriceUpdaterRead = useReadContract({
    address: deployment.hook,
    abi: deltaNeutralHookAbi,
    functionName: 'priceUpdaters',
    args: [address ?? deployment.hook],
    query: { enabled: ready && !isProduction && Boolean(address) },
  });
  const strategyManagerRead = useReadContract({
    address: deployment.hook,
    abi: productionHookAbi,
    functionName: 'strategyManager',
    query: { enabled: ready && isProduction },
  });
  const liquidityManagerRead = useReadContract({
    address: deployment.hook,
    abi: productionHookAbi,
    functionName: 'liquidityManagers',
    args: [liquidityRouter],
    query: { enabled: ready && isProduction },
  });
  const adapterOperatorRead = useReadContract({
    address: deployment.hedgeAdapter,
    abi: demoHedgeAdapterAbi,
    functionName: 'operators',
    args: [address ?? deployment.hook],
    query: { enabled: ready && isProduction && Boolean(address) && Boolean(deployment.hedgeAdapter) },
  });
  const routerOperatorRead = useReadContract({
    address: liquidityRouter,
    abi: productionLiquidityRouterAbi,
    functionName: 'operators',
    args: [address ?? deployment.hook],
    query: { enabled: ready && isProduction && Boolean(address) },
  });

  const capstoneRiskRead = useReadContract({
    address: deployment.hook,
    abi: deltaNeutralHookAbi,
    functionName: 'getRiskState',
    args: [poolKey],
    query: { enabled: ready && !isProduction },
  });
  const productionRiskRead = useReadContract({
    address: deployment.hook,
    abi: productionHookAbi,
    functionName: 'getRiskState',
    args: [poolKey],
    query: { enabled: ready && isProduction },
  });
  const productionConfigRead = useReadContract({
    address: deployment.hook,
    abi: productionHookAbi,
    functionName: 'getPoolConfig',
    args: [poolKey],
    query: { enabled: ready && isProduction },
  });
  const netDeltaRead = useReadContract({
    address: deployment.hook,
    abi: hookAbi,
    functionName: 'netBaseDelta',
    args: [poolKey],
    query: { enabled: ready },
  });

  const zeroForOnePreviewParams = useMemo(
    () => ({ zeroForOne: true, amountSpecified: -1n, sqrtPriceLimitX96: MIN_SQRT_PRICE_LIMIT }),
    [],
  );
  const oneForZeroPreviewParams = useMemo(
    () => ({ zeroForOne: false, amountSpecified: -1n, sqrtPriceLimitX96: MAX_SQRT_PRICE_LIMIT }),
    [],
  );
  const zeroForOneFeeRead = useReadContract({
    address: deployment.hook,
    abi: hookAbi,
    functionName: 'previewFee',
    args: [poolKey, zeroForOnePreviewParams],
    query: { enabled: ready },
  });
  const oneForZeroFeeRead = useReadContract({
    address: deployment.hook,
    abi: hookAbi,
    functionName: 'previewFee',
    args: [poolKey, oneForZeroPreviewParams],
    query: { enabled: ready },
  });

  const token0SymbolRead = useReadContract({
    address: deployment.currency0,
    abi: demoErc20Abi,
    functionName: 'symbol',
    query: { enabled: ready },
  });
  const token1SymbolRead = useReadContract({
    address: deployment.currency1,
    abi: demoErc20Abi,
    functionName: 'symbol',
    query: { enabled: ready },
  });
  const token0DecimalsRead = useReadContract({
    address: deployment.currency0,
    abi: demoErc20Abi,
    functionName: 'decimals',
    query: { enabled: ready },
  });
  const token1DecimalsRead = useReadContract({
    address: deployment.currency1,
    abi: demoErc20Abi,
    functionName: 'decimals',
    query: { enabled: ready },
  });
  const token0BalanceRead = useReadContract({
    address: deployment.currency0,
    abi: demoErc20Abi,
    functionName: 'balanceOf',
    args: [address ?? deployment.hook],
    query: { enabled: ready && Boolean(address) },
  });
  const token1BalanceRead = useReadContract({
    address: deployment.currency1,
    abi: demoErc20Abi,
    functionName: 'balanceOf',
    args: [address ?? deployment.hook],
    query: { enabled: ready && Boolean(address) },
  });
  const token0SwapAllowanceRead = useReadContract({
    address: deployment.currency0,
    abi: demoErc20Abi,
    functionName: 'allowance',
    args: [address ?? deployment.hook, spender],
    query: { enabled: ready && Boolean(address) },
  });
  const token1SwapAllowanceRead = useReadContract({
    address: deployment.currency1,
    abi: demoErc20Abi,
    functionName: 'allowance',
    args: [address ?? deployment.hook, spender],
    query: { enabled: ready && Boolean(address) },
  });

  const capstoneRisk = normalizeCapstoneRiskState(capstoneRiskRead.data);
  const productionRisk = normalizeProductionRiskState(productionRiskRead.data);
  const productionConfig = normalizeProductionConfig(productionConfigRead.data);
  const token0Decimals = Number(token0DecimalsRead.data ?? 18);
  const token1Decimals = Number(token1DecimalsRead.data ?? 18);
  const token0Symbol = token0SymbolRead.data ?? 'TOKEN0';
  const token1Symbol = token1SymbolRead.data ?? 'TOKEN1';
  const baseSymbol = deployment.baseIsCurrency0 ? token0Symbol : token1Symbol;
  const owner = ownerRead.data;
  const strategyManager = strategyManagerRead.data;
  const isOwner = Boolean(owner && address && owner.toLowerCase() === address.toLowerCase());
  const isStrategyManager = Boolean(
    strategyManager && address && strategyManager.toLowerCase() === address.toLowerCase(),
  );
  const isKeeper = Boolean(keeperRead.data);
  const isPriceUpdater = Boolean(capstonePriceUpdaterRead.data);
  const isAdapterOperator = Boolean(adapterOperatorRead.data || isOwner || isStrategyManager);
  const isRouterOperator = Boolean(routerOperatorRead.data || isOwner || isStrategyManager);
  const isPoolPaused = isProduction ? productionRisk?.healthMode === 4 : Boolean(capstoneRisk?.paused);

  const refreshReads = async () => {
    await Promise.allSettled([
      ownerRead.refetch(),
      keeperRead.refetch(),
      capstonePriceUpdaterRead.refetch(),
      strategyManagerRead.refetch(),
      liquidityManagerRead.refetch(),
      adapterOperatorRead.refetch(),
      routerOperatorRead.refetch(),
      capstoneRiskRead.refetch(),
      productionRiskRead.refetch(),
      productionConfigRead.refetch(),
      netDeltaRead.refetch(),
      zeroForOneFeeRead.refetch(),
      oneForZeroFeeRead.refetch(),
      token0SymbolRead.refetch(),
      token1SymbolRead.refetch(),
      token0DecimalsRead.refetch(),
      token1DecimalsRead.refetch(),
      token0BalanceRead.refetch(),
      token1BalanceRead.refetch(),
      token0SwapAllowanceRead.refetch(),
      token1SwapAllowanceRead.refetch(),
    ]);
  };

  const submit = async (label: string, action: () => Promise<Hash>) => {
    if (!publicClient) return;
    setBusyLabel(label);
    setError(null);
    try {
      const hash = await action();
      setLastTx(hash);
      await publicClient.waitForTransactionReceipt({ hash });
      await refreshReads();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusyLabel(null);
    }
  };

  const faucet = (token: Address, symbol: string) =>
    submit(`Faucet ${symbol}`, () =>
      writeContractAsync({ address: token, abi: demoErc20Abi, functionName: 'faucet' }),
    );

  const approve = (token: Address, symbol: string, target: Address, label = 'Approve') =>
    submit(`${label} ${symbol}`, () =>
      writeContractAsync({
        address: token,
        abi: demoErc20Abi,
        functionName: 'approve',
        args: [target, maxUint256],
      }),
    );

  const swap = (zeroForOne: boolean) =>
    submit(zeroForOne ? `${token0Symbol} -> ${token1Symbol}` : `${token1Symbol} -> ${token0Symbol}`, () => {
      const decimals = zeroForOne ? token0Decimals : token1Decimals;
      const amountIn = parseUnits(swapAmount || '0', decimals);
      if (amountIn <= 0n) throw new Error('Enter a positive swap amount.');
      return writeContractAsync({
        address: deployment.poolSwapTest,
        abi: poolSwapTestAbi,
        functionName: 'swap',
        args: [
          poolKey,
          {
            zeroForOne,
            amountSpecified: -amountIn,
            sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE_LIMIT : MAX_SQRT_PRICE_LIMIT,
          },
          { takeClaims: false, settleUsingBurn: false },
          '0x',
        ],
      });
    });

  const updateReferencePrice = () =>
    submit('Update reference price', () =>
      writeContractAsync({
        address: deployment.hook,
        abi: deltaNeutralHookAbi,
        functionName: 'updateReferencePrice',
        args: [poolKey, decimalToQ96(referencePrice)],
      }),
    );

  const recordHedgeFill = () => {
    if (!capstoneRisk || capstoneRisk.pendingHedgeBase === 0n) {
      setError('No pending hedge to record.');
      return;
    }
    return submit('Record hedge fill', () =>
      writeContractAsync({
        address: deployment.hook,
        abi: deltaNeutralHookAbi,
        functionName: 'recordHedgeFill',
        args: [poolKey, capstoneRisk.hedgeNonce, capstoneRisk.pendingHedgeBase],
      }),
    );
  };

  const setPaused = (paused: boolean) =>
    submit(paused ? 'Pause pool' : 'Unpause pool', () =>
      writeContractAsync({
        address: deployment.hook,
        abi: hookAbi,
        functionName: 'setPoolPaused',
        args: [poolKey, paused],
      }),
    );

  const productionAction = (label: string, functionName: 'syncHedgeSnapshot' | 'settleHedgeOrder') =>
    submit(label, () =>
      writeContractAsync({
        address: deployment.hook,
        abi: productionHookAbi,
        functionName,
        args: [poolKey],
      }),
    );

  const rebalance = () =>
    submit('Rebalance hedge', () =>
      writeContractAsync({
        address: deployment.hook,
        abi: productionHookAbi,
        functionName: 'rebalance',
        args: [poolKey, parseUnits(acceptablePrice || '0', 18)],
      }),
    );

  const modifyStrategyLiquidity = (adding: boolean) =>
    submit(adding ? 'Add strategy liquidity' : 'Remove strategy liquidity', () => {
      const amount = parseUnits(liquidityAmount || '0', 18);
      if (amount <= 0n) throw new Error('Enter a positive liquidity amount.');
      return writeContractAsync({
        address: liquidityRouter,
        abi: productionLiquidityRouterAbi,
        functionName: 'modifyLiquidity',
        args: [
          poolKey,
          { tickLower: -600, tickUpper: 600, liquidityDelta: adding ? amount : -amount, salt: SALT_ZERO },
          '0x',
        ],
      });
    });

  const adapterAction = (
    label: string,
    functionName: 'setHealthy' | 'setCollateralUsd' | 'setPnl' | 'makeSnapshotStale' | 'resetDemoSnapshot' | 'setNextSettlement',
    args: readonly unknown[],
  ) => {
    const adapter = deployment.hedgeAdapter;
    if (!adapter) {
      setError('No demo hedge adapter is loaded.');
      return;
    }
    return submit(label, () =>
      writeContractAsync({
        address: adapter,
        abi: demoHedgeAdapterAbi,
        functionName,
        args,
      } as never),
    );
  };

  const resetCollateral = parseUnits('100000', 18);
  const collateralRequirement = productionRisk && productionConfig
    ? requiredCollateralUsd(productionRisk.hedgePositionBase, productionRisk.lastMarkPrice, productionConfig)
    : 0n;

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">{active.chainName}</p>
          <h1>Delta Neutral Hook Operator</h1>
        </div>
        <ConnectButton />
      </header>

      <section className="modebar">
        {Object.values(modeConfigs).map((config) => (
          <button
            key={config.mode}
            className={`mode-button ${mode === config.mode ? 'active' : ''}`}
            onClick={() => setMode(config.mode)}
          >
            {config.label}
          </button>
        ))}
      </section>

      {!ready && (
        <section className="banner warning">
          <TriangleAlert size={18} />
          <span>
            {isProduction
              ? 'Production Base Sepolia deployment is not loaded yet.'
              : 'Capstone Sepolia deployment is not loaded yet.'}
          </span>
        </section>
      )}

      {isConnected && !onTargetNetwork && (
        <section className="banner warning">
          <TriangleAlert size={18} />
          <span>Your wallet is not on {active.chainName}.</span>
          <button className="button compact" onClick={() => switchChain({ chainId: active.chainId })}>
            Switch
          </button>
        </section>
      )}

      <section className="grid two">
        <Card title="Deployment" icon={<ShieldCheck size={18} />}>
          <KeyValue label="Hook" value={shortAddress(deployment.hook)} />
          <KeyValue label="Pool ID" value={shortHash(deployment.poolId)} />
          <KeyValue label="PoolManager" value={shortAddress(deployment.poolManager)} />
          <KeyValue label="Swap router" value={shortAddress(deployment.poolSwapTest)} />
          {isProduction && <KeyValue label="Liquidity router" value={shortAddress(liquidityRouter)} />}
          {isProduction && <KeyValue label="Hedge adapter" value={shortAddress(deployment.hedgeAdapter ?? '')} />}
          <KeyValue label="Currency 0" value={`${token0Symbol} ${shortAddress(deployment.currency0)}`} />
          <KeyValue label="Currency 1" value={`${token1Symbol} ${shortAddress(deployment.currency1)}`} />
        </Card>

        <Card title="Wallet Roles" icon={<Wallet size={18} />}>
          <KeyValue label="Connected" value={address ? shortAddress(address) : 'Not connected'} />
          <KeyValue label="Owner" value={isOwner ? 'Yes' : 'No'} />
          <KeyValue label="Keeper" value={isKeeper ? 'Yes' : 'No'} />
          {isProduction ? (
            <>
              <KeyValue label="Strategy manager" value={isStrategyManager ? 'Yes' : 'No'} />
              <KeyValue label="Router operator" value={isRouterOperator ? 'Yes' : 'No'} />
              <KeyValue label="Adapter operator" value={isAdapterOperator ? 'Yes' : 'No'} />
              <KeyValue label="Router whitelisted" value={liquidityManagerRead.data ? 'Yes' : 'No'} />
            </>
          ) : (
            <KeyValue label="Price updater" value={isPriceUpdater ? 'Yes' : 'No'} />
          )}
        </Card>
      </section>

      {isProduction ? (
        <ProductionRiskPanel
          risk={productionRisk}
          config={productionConfig}
          baseSymbol={baseSymbol}
          collateralRequirement={collateralRequirement}
        />
      ) : (
        <CapstoneRiskPanel risk={capstoneRisk} netDelta={(netDeltaRead.data as bigint | undefined) ?? 0n} baseSymbol={baseSymbol} />
      )}

      <section className="grid two">
        <Card title="Token Setup" icon={<CheckCircle2 size={18} />}>
          <TokenRow
            symbol={token0Symbol}
            balance={token0BalanceRead.data ?? 0n}
            allowance={token0SwapAllowanceRead.data ?? 0n}
            decimals={token0Decimals}
            canWrite={canWrite}
            busy={Boolean(busyLabel)}
            onFaucet={() => faucet(deployment.currency0, token0Symbol)}
            onApprove={() => approve(deployment.currency0, token0Symbol, spender)}
          />
          <TokenRow
            symbol={token1Symbol}
            balance={token1BalanceRead.data ?? 0n}
            allowance={token1SwapAllowanceRead.data ?? 0n}
            decimals={token1Decimals}
            canWrite={canWrite}
            busy={Boolean(busyLabel)}
            onFaucet={() => faucet(deployment.currency1, token1Symbol)}
            onApprove={() => approve(deployment.currency1, token1Symbol, spender)}
          />
        </Card>

        <Card title="Swap Simulator" icon={<ArrowDownUp size={18} />}>
          <label className="field">
            Amount
            <input value={swapAmount} onChange={(event) => setSwapAmount(event.target.value)} inputMode="decimal" />
          </label>
          <div className="button-row">
            <button className="button primary" disabled={!canWrite || Boolean(busyLabel)} onClick={() => swap(true)}>
              <ArrowDownUp size={16} /> {token0Symbol} to {token1Symbol}
            </button>
            <button className="button primary" disabled={!canWrite || Boolean(busyLabel)} onClick={() => swap(false)}>
              <ArrowDownUp size={16} /> {token1Symbol} to {token0Symbol}
            </button>
          </div>
          <div className="fee-grid">
            <KeyValue label={`${token0Symbol} -> ${token1Symbol} fee`} value={feeLabel(zeroForOneFeeRead.data, zeroForOneFeeRead.error)} />
            <KeyValue label={`${token1Symbol} -> ${token0Symbol} fee`} value={feeLabel(oneForZeroFeeRead.data, oneForZeroFeeRead.error)} />
          </div>
        </Card>
      </section>

      {isProduction ? (
        <section className="grid two">
          <Card title="Keeper Controls" icon={<Activity size={18} />}>
            <label className="field">
              Acceptable hedge price
              <input value={acceptablePrice} onChange={(event) => setAcceptablePrice(event.target.value)} inputMode="decimal" />
            </label>
            <div className="button-row">
              <button className="button" disabled={!canWrite || !isKeeper || Boolean(busyLabel)} onClick={() => productionAction('Sync snapshot', 'syncHedgeSnapshot')}>
                <RefreshCw size={16} /> Sync
              </button>
              <button className="button" disabled={!canWrite || !isKeeper || Boolean(busyLabel)} onClick={rebalance}>
                <Gauge size={16} /> Rebalance
              </button>
              <button className="button" disabled={!canWrite || !isKeeper || Boolean(busyLabel)} onClick={() => productionAction('Settle hedge order', 'settleHedgeOrder')}>
                <ShieldCheck size={16} /> Settle
              </button>
              <button className="button" disabled={!canWrite || !(isOwner || isStrategyManager) || Boolean(busyLabel)} onClick={() => setPaused(!isPoolPaused)}>
                {isPoolPaused ? <Play size={16} /> : <Pause size={16} />}
                {isPoolPaused ? 'Unpause' : 'Pause'}
              </button>
            </div>
          </Card>

          <Card title="Strategy Liquidity" icon={<SlidersHorizontal size={18} />}>
            <label className="field">
              Liquidity delta
              <input value={liquidityAmount} onChange={(event) => setLiquidityAmount(event.target.value)} inputMode="decimal" />
            </label>
            <div className="button-row">
              <button className="button" disabled={!canWrite || Boolean(busyLabel)} onClick={() => approve(deployment.currency0, token0Symbol, liquidityRouter, 'Approve LP')}>
                <CheckCircle2 size={16} /> Approve {token0Symbol}
              </button>
              <button className="button" disabled={!canWrite || Boolean(busyLabel)} onClick={() => approve(deployment.currency1, token1Symbol, liquidityRouter, 'Approve LP')}>
                <CheckCircle2 size={16} /> Approve {token1Symbol}
              </button>
              <button className="button primary" disabled={!canWrite || !isRouterOperator || Boolean(busyLabel)} onClick={() => modifyStrategyLiquidity(true)}>
                Add
              </button>
              <button className="button" disabled={!canWrite || !isRouterOperator || Boolean(busyLabel)} onClick={() => modifyStrategyLiquidity(false)}>
                Remove
              </button>
            </div>
          </Card>
        </section>
      ) : (
        <section className="grid two">
          <Card title="Reference Price" icon={<RefreshCw size={18} />}>
            <label className="field">
              Reference price
              <input value={referencePrice} onChange={(event) => setReferencePrice(event.target.value)} inputMode="decimal" />
            </label>
            <KeyValue label="Last X96" value={String(capstoneRisk?.lastReferencePriceX96 ?? 0n)} />
            <KeyValue label="Last update" value={timestampLabel(capstoneRisk?.lastReferenceTimestamp ?? 0n)} />
            <button className="button" disabled={!canWrite || !isPriceUpdater || Boolean(busyLabel)} onClick={updateReferencePrice}>
              <RefreshCw size={16} /> Update price
            </button>
          </Card>

          <Card title="Risk Controls" icon={<ShieldCheck size={18} />}>
            <KeyValue label="Net delta" value={formatSigned((netDeltaRead.data as bigint | undefined) ?? 0n, 18)} />
            <KeyValue label="Paused" value={capstoneRisk?.paused ? 'Yes' : 'No'} />
            <div className="button-row">
              <button className="button" disabled={!canWrite || !isKeeper || (capstoneRisk?.pendingHedgeBase ?? 0n) === 0n || Boolean(busyLabel)} onClick={recordHedgeFill}>
                <ShieldCheck size={16} /> Record hedge fill
              </button>
              <button className="button" disabled={!canWrite || !isOwner || Boolean(busyLabel)} onClick={() => setPaused(!capstoneRisk?.paused)}>
                {capstoneRisk?.paused ? <Play size={16} /> : <Pause size={16} />}
                {capstoneRisk?.paused ? 'Unpause' : 'Pause'}
              </button>
            </div>
          </Card>
        </section>
      )}

      {isProduction && (
        <section className="grid two">
          <Card title="Advanced Lab" icon={<FlaskConical size={18} />}>
            <div className="button-row">
              <button className="button" disabled={!canWrite || !isAdapterOperator || Boolean(busyLabel)} onClick={() => adapterAction('Adapter unhealthy', 'setHealthy', [strategyId, false])}>
                Unhealthy
              </button>
              <button className="button" disabled={!canWrite || !isAdapterOperator || Boolean(busyLabel)} onClick={() => adapterAction('Stale snapshot', 'makeSnapshotStale', [strategyId, BigInt(Number(productionConfig?.maxSnapshotAge ?? 300n) + 60)])}>
                Stale snapshot
              </button>
              <button className="button" disabled={!canWrite || !isAdapterOperator || Boolean(busyLabel)} onClick={() => adapterAction('Low collateral', 'setCollateralUsd', [strategyId, parseUnits('1', 18)])}>
                Low collateral
              </button>
              <button className="button" disabled={!canWrite || !isAdapterOperator || Boolean(busyLabel)} onClick={() => adapterAction('Loss scenario', 'setPnl', [strategyId, -parseUnits('25000', 18), 0n])}>
                Loss
              </button>
              <button className="button" disabled={!canWrite || !isAdapterOperator || Boolean(busyLabel)} onClick={() => adapterAction('Partial fill plan', 'setNextSettlement', [strategyId, (productionRisk?.pendingOrderBase ?? 0n) / 2n, 0n, parseUnits('2000', 18)])}>
                Partial fill
              </button>
              <button className="button primary" disabled={!canWrite || !isAdapterOperator || Boolean(busyLabel)} onClick={() => adapterAction('Reset snapshot', 'resetDemoSnapshot', [strategyId, parseUnits('2000', 18), resetCollateral])}>
                Reset
              </button>
            </div>
          </Card>

          <Card title="Weakness Window" icon={<TriangleAlert size={18} />}>
            <KeyValue label="Adapter healthy" value={productionRisk?.adapterHealthy ? 'Yes' : 'No'} />
            <KeyValue label="Snapshot age" value={snapshotAgeLabel(productionRisk?.lastSnapshotTimestamp ?? 0n)} />
            <KeyValue label="Pending ready" value={timestampLabel(productionRisk?.pendingOrderReadyAt ?? 0n)} />
            <KeyValue label="Exposure-worsening side" value={worseningSide(deployment.baseIsCurrency0, productionRisk?.netBaseDelta ?? 0n, token0Symbol, token1Symbol)} />
          </Card>
        </section>
      )}

      {(busyLabel || lastTx || error) && (
        <section className={`banner ${error ? 'error' : 'info'}`}>
          {busyLabel ? <RefreshCw className="spin" size={18} /> : error ? <TriangleAlert size={18} /> : <CheckCircle2 size={18} />}
          <span>{busyLabel ?? error ?? `Confirmed ${shortHash(lastTx ?? '0x')}`}</span>
        </section>
      )}
    </main>
  );
}

function CapstoneRiskPanel({ risk, netDelta, baseSymbol }: { risk: CapstoneRiskState | null; netDelta: bigint; baseSymbol: string }) {
  return (
    <section className="grid three">
      <Metric label="Pool base exposure" value={formatSigned(risk?.poolBaseExposure ?? 0n, 18)} sub={baseSymbol} />
      <Metric label="Reported hedge" value={formatSigned(risk?.reportedHedgeBase ?? 0n, 18)} sub="external hedge" />
      <Metric
        label="Pending hedge"
        value={formatSigned(risk?.pendingHedgeBase ?? 0n, 18)}
        sub={`net ${formatSigned(netDelta, 18)}`}
        tone={(risk?.pendingHedgeBase ?? 0n) === 0n ? 'good' : 'warn'}
      />
    </section>
  );
}

function ProductionRiskPanel({
  risk,
  config,
  baseSymbol,
  collateralRequirement,
}: {
  risk: ProductionRiskState | null;
  config: ProductionPoolConfig | null;
  baseSymbol: string;
  collateralRequirement: bigint;
}) {
  return (
    <>
      <section className="grid three">
        <Metric label="Net delta" value={formatSigned(risk?.netBaseDelta ?? 0n, 18)} sub={`${baseSymbol} after hedge`} tone={(risk?.netBaseDelta ?? 0n) === 0n ? 'good' : 'warn'} />
        <Metric label="Health mode" value={healthModeLabel(risk?.healthMode ?? 0)} sub={risk?.adapterHealthy ? 'adapter healthy' : 'adapter unhealthy'} tone={(risk?.healthMode ?? 0) <= 1 ? 'good' : 'warn'} />
        <Metric label="Collateral" value={formatUsd(risk?.collateralUsd ?? 0n)} sub={`required ${formatUsd(collateralRequirement)}`} />
      </section>
      <section className="grid two">
        <Card title="Delta Equation" icon={<Activity size={18} />}>
          <KeyValue label="Pool exposure" value={formatSigned(risk?.poolBaseExposure ?? 0n, 18)} />
          <KeyValue label="Hedge position" value={formatSigned(risk?.hedgePositionBase ?? 0n, 18)} />
          <KeyValue label="Net base delta" value={formatSigned(risk?.netBaseDelta ?? 0n, 18)} />
          <KeyValue label="Target hedge" value={formatSigned(risk?.targetHedgeBase ?? 0n, 18)} />
          <KeyValue label="Threshold" value={formatToken(config?.hedgeThresholdBase ?? 0n, 18)} />
        </Card>
        <Card title="LP Inventory And Hedge" icon={<Gauge size={18} />}>
          <KeyValue label="LP base deposited" value={formatToken(risk?.lpBaseDeposited ?? 0n, 18)} />
          <KeyValue label="LP base withdrawn" value={formatToken(risk?.lpBaseWithdrawn ?? 0n, 18)} />
          <KeyValue label="LP base fees" value={formatToken(risk?.lpBaseFeesAccrued ?? 0n, 18)} />
          <KeyValue label="Pending order" value={shortHash(risk?.pendingOrderId ?? '0x')} />
          <KeyValue label="Pending base" value={formatSigned(risk?.pendingOrderBase ?? 0n, 18)} />
        </Card>
      </section>
      <section className="grid two">
        <Card title="PnL And Price" icon={<SlidersHorizontal size={18} />}>
          <KeyValue label="Mark price" value={formatUsd(risk?.lastMarkPrice ?? 0n)} />
          <KeyValue label="Realized PnL" value={formatSignedUsd(risk?.realizedPnlUsd ?? 0n)} />
          <KeyValue label="Unrealized PnL" value={formatSignedUsd(risk?.unrealizedPnlUsd ?? 0n)} />
          <KeyValue label="Snapshot" value={timestampLabel(risk?.lastSnapshotTimestamp ?? 0n)} />
        </Card>
        <Card title="Risk Bounds" icon={<ShieldCheck size={18} />}>
          <KeyValue label="Min collateral" value={formatUsd(config?.minCollateralUsd ?? 0n)} />
          <KeyValue label="Min collateral ratio" value={`${Number(config?.minCollateralRatioBps ?? 0n) / 100}%`} />
          <KeyValue label="Max leverage" value={`${Number(config?.maxLeverageBps ?? 0n) / 100}%`} />
          <KeyValue label="Max loss" value={`${Number(config?.maxLossBps ?? 0n) / 100}%`} />
        </Card>
      </section>
    </>
  );
}

function TokenRow({
  symbol,
  balance,
  allowance,
  decimals,
  canWrite,
  busy,
  onFaucet,
  onApprove,
}: {
  symbol: string;
  balance: bigint;
  allowance: bigint;
  decimals: number;
  canWrite: boolean;
  busy: boolean;
  onFaucet: () => void;
  onApprove: () => void;
}) {
  return (
    <div className="token-row">
      <div>
        <strong>{symbol}</strong>
        <p>{formatToken(balance, decimals)}</p>
        <small>Swap allowance: {formatToken(allowance, decimals)}</small>
      </div>
      <div className="button-row">
        <button className="button" disabled={!canWrite || busy} onClick={onFaucet}>
          Faucet
        </button>
        <button className="button" disabled={!canWrite || busy} onClick={onApprove}>
          Approve
        </button>
      </div>
    </div>
  );
}

function Card({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      <div className="card-title">
        {icon}
        <h2>{title}</h2>
      </div>
      {children}
    </section>
  );
}

function Metric({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: 'good' | 'warn' }) {
  return (
    <section className={`metric ${tone ?? ''}`}>
      <p>{label}</p>
      <strong>{value}</strong>
      <span>{sub}</span>
    </section>
  );
}

function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="kv">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function normalizeCapstoneRiskState(data: unknown): CapstoneRiskState | null {
  if (!data) return null;
  const value = data as Partial<CapstoneRiskState> & Record<number, unknown>;
  return {
    poolBaseExposure: coerceBigInt(value.poolBaseExposure ?? value[0]),
    reportedHedgeBase: coerceBigInt(value.reportedHedgeBase ?? value[1]),
    pendingHedgeBase: coerceBigInt(value.pendingHedgeBase ?? value[2]),
    lastReferencePriceX96: coerceBigInt(value.lastReferencePriceX96 ?? value[3]),
    lastReferenceTimestamp: coerceBigInt(value.lastReferenceTimestamp ?? value[4]),
    hedgeNonce: coerceBigInt(value.hedgeNonce ?? value[5]),
    paused: Boolean(value.paused ?? value[6] ?? false),
  };
}

function normalizeProductionRiskState(data: unknown): ProductionRiskState | null {
  if (!data) return null;
  const value = data as Partial<ProductionRiskState> & Record<number, unknown>;
  return {
    poolBaseExposure: coerceBigInt(value.poolBaseExposure ?? value[0]),
    hedgePositionBase: coerceBigInt(value.hedgePositionBase ?? value[1]),
    targetHedgeBase: coerceBigInt(value.targetHedgeBase ?? value[2]),
    pendingOrderBase: coerceBigInt(value.pendingOrderBase ?? value[3]),
    netBaseDelta: coerceBigInt(value.netBaseDelta ?? value[4]),
    realizedPnlUsd: coerceBigInt(value.realizedPnlUsd ?? value[5]),
    unrealizedPnlUsd: coerceBigInt(value.unrealizedPnlUsd ?? value[6]),
    collateralUsd: coerceBigInt(value.collateralUsd ?? value[7]),
    initialCollateralUsd: coerceBigInt(value.initialCollateralUsd ?? value[8]),
    lastMarkPrice: coerceBigInt(value.lastMarkPrice ?? value[9]),
    lastSnapshotTimestamp: coerceBigInt(value.lastSnapshotTimestamp ?? value[10]),
    pendingOrderReadyAt: coerceBigInt(value.pendingOrderReadyAt ?? value[11]),
    lastRebalanceTimestamp: coerceBigInt(value.lastRebalanceTimestamp ?? value[12]),
    lpBaseDeposited: coerceBigInt(value.lpBaseDeposited ?? value[13]),
    lpBaseWithdrawn: coerceBigInt(value.lpBaseWithdrawn ?? value[14]),
    lpBaseFeesAccrued: coerceBigInt(value.lpBaseFeesAccrued ?? value[15]),
    pendingOrderId: ((value.pendingOrderId ?? value[16] ?? '0x') as `0x${string}`),
    adapterHealthy: Boolean(value.adapterHealthy ?? value[17] ?? false),
    healthMode: Number(value.healthMode ?? value[18] ?? 0),
  };
}

function normalizeProductionConfig(data: unknown): ProductionPoolConfig | null {
  if (!data) return null;
  const value = data as Partial<ProductionPoolConfig> & Record<number, unknown>;
  return {
    hedgeThresholdBase: coerceBigInt(value.hedgeThresholdBase ?? value[7]),
    maxResidualDeltaBase: coerceBigInt(value.maxResidualDeltaBase ?? value[8]),
    maxSnapshotAge: coerceBigInt(value.maxSnapshotAge ?? value[10]),
    minCollateralUsd: coerceBigInt(value.minCollateralUsd ?? value[11]),
    minCollateralRatioBps: coerceBigInt(value.minCollateralRatioBps ?? value[12]),
    maxLeverageBps: coerceBigInt(value.maxLeverageBps ?? value[13]),
    maxLossBps: coerceBigInt(value.maxLossBps ?? value[14]),
  };
}

function coerceBigInt(value: unknown) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return BigInt(value);
  return 0n;
}

function decimalToQ96(value: string) {
  const scaled = parseUnits(value || '0', 6);
  return (scaled * Q96) / 1_000_000n;
}

function requiredCollateralUsd(positionBase: bigint, markPrice: bigint, config: ProductionPoolConfig) {
  const notional = (abs(positionBase) * markPrice) / 10n ** 18n;
  const ratio = (notional * config.minCollateralRatioBps) / 10_000n;
  const leverage = config.maxLeverageBps === 0n ? 0n : (notional * 10_000n) / config.maxLeverageBps;
  return [config.minCollateralUsd, ratio, leverage].reduce((max, value) => (value > max ? value : max), 0n);
}

function abs(value: bigint) {
  return value < 0n ? -value : value;
}

function formatSigned(value: bigint, decimals: number) {
  const sign = value < 0n ? '-' : value > 0n ? '+' : '';
  return `${sign}${formatToken(abs(value), decimals)}`;
}

function formatSignedUsd(value: bigint) {
  const sign = value < 0n ? '-' : value > 0n ? '+' : '';
  return `${sign}${formatUsd(abs(value))}`;
}

function formatUsd(value: bigint) {
  return `$${formatToken(value, 18)}`;
}

function formatToken(value: bigint, decimals: number) {
  const formatted = formatUnits(value, decimals);
  const [whole, fraction = ''] = formatted.split('.');
  const trimmed = fraction.slice(0, 4).replace(/0+$/, '');
  return trimmed ? `${whole}.${trimmed}` : whole;
}

function feeLabel(value: unknown, error: unknown) {
  if (error) return 'blocked';
  if (value === undefined) return '-';
  return `${(Number(value) / 10_000).toFixed(4)}%`;
}

function healthModeLabel(value: number) {
  return ['Healthy', 'Needs rebalance', 'Pending order', 'Defensive', 'Paused'][value] ?? 'Unknown';
}

function timestampLabel(timestamp: bigint) {
  if (timestamp === 0n) return '-';
  return new Date(Number(timestamp) * 1000).toLocaleString();
}

function snapshotAgeLabel(timestamp: bigint) {
  if (timestamp === 0n) return '-';
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - Number(timestamp));
  return `${seconds}s`;
}

function worseningSide(baseIsCurrency0: boolean, netDelta: bigint, token0: string, token1: string) {
  if (netDelta === 0n) return 'none';
  const baseIncreasing = baseIsCurrency0 ? `${token0} -> ${token1}` : `${token1} -> ${token0}`;
  const baseReducing = baseIsCurrency0 ? `${token1} -> ${token0}` : `${token0} -> ${token1}`;
  return netDelta > 0n ? baseIncreasing : baseReducing;
}

function shortAddress(value: string) {
  if (!value || value.length < 12) return value || '-';
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function shortHash(value: string) {
  if (!value || value.length < 14) return value || '-';
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function errorMessage(error: unknown) {
  if (error instanceof BaseError) return error.shortMessage || error.message;
  if (error instanceof Error) return error.message;
  return 'Transaction failed.';
}
