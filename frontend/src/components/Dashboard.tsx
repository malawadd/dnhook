'use client';

import { ConnectButton } from '@rainbow-me/rainbowkit';
import {
  ArrowDownUp,
  CheckCircle2,
  Droplets,
  Pause,
  Play,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import {
  BaseError,
  formatUnits,
  maxUint256,
  parseUnits,
  type Address,
  type Hash,
} from 'viem';
import {
  useAccount,
  useChainId,
  usePublicClient,
  useReadContract,
  useSwitchChain,
  useWriteContract,
} from 'wagmi';
import { sepolia } from 'wagmi/chains';
import { demoErc20Abi, deltaNeutralHookAbi, poolSwapTestAbi } from '@/lib/abis';
import { deployment, isDeploymentReady, poolKey } from '@/lib/deployment';

const MIN_SQRT_PRICE_LIMIT = 4_295_128_740n;
const MAX_SQRT_PRICE_LIMIT = 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_341n;
const Q96 = 2n ** 96n;

type RiskState = {
  poolBaseExposure: bigint;
  reportedHedgeBase: bigint;
  pendingHedgeBase: bigint;
  lastReferencePriceX96: bigint;
  lastReferenceTimestamp: bigint;
  hedgeNonce: bigint;
  paused: boolean;
};

export function Dashboard() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const [swapAmount, setSwapAmount] = useState('1');
  const [referencePrice, setReferencePrice] = useState('2000');
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<Hash | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onSepolia = chainId === sepolia.id;
  const canWrite = isConnected && onSepolia && isDeploymentReady;

  const ownerRead = useReadContract({
    address: deployment.hook,
    abi: deltaNeutralHookAbi,
    functionName: 'owner',
    query: { enabled: isDeploymentReady },
  });
  const keeperRead = useReadContract({
    address: deployment.hook,
    abi: deltaNeutralHookAbi,
    functionName: 'keepers',
    args: [address ?? deployment.hook],
    query: { enabled: isDeploymentReady && Boolean(address) },
  });
  const priceUpdaterRead = useReadContract({
    address: deployment.hook,
    abi: deltaNeutralHookAbi,
    functionName: 'priceUpdaters',
    args: [address ?? deployment.hook],
    query: { enabled: isDeploymentReady && Boolean(address) },
  });
  const riskRead = useReadContract({
    address: deployment.hook,
    abi: deltaNeutralHookAbi,
    functionName: 'getRiskState',
    args: [poolKey],
    query: { enabled: isDeploymentReady },
  });
  const netDeltaRead = useReadContract({
    address: deployment.hook,
    abi: deltaNeutralHookAbi,
    functionName: 'netBaseDelta',
    args: [poolKey],
    query: { enabled: isDeploymentReady },
  });

  const zeroForOnePreviewParams = useMemo(
    () => ({
      zeroForOne: true,
      amountSpecified: -1n,
      sqrtPriceLimitX96: MIN_SQRT_PRICE_LIMIT,
    }),
    [],
  );
  const oneForZeroPreviewParams = useMemo(
    () => ({
      zeroForOne: false,
      amountSpecified: -1n,
      sqrtPriceLimitX96: MAX_SQRT_PRICE_LIMIT,
    }),
    [],
  );

  const zeroForOneFeeRead = useReadContract({
    address: deployment.hook,
    abi: deltaNeutralHookAbi,
    functionName: 'previewFee',
    args: [poolKey, zeroForOnePreviewParams],
    query: { enabled: isDeploymentReady },
  });
  const oneForZeroFeeRead = useReadContract({
    address: deployment.hook,
    abi: deltaNeutralHookAbi,
    functionName: 'previewFee',
    args: [poolKey, oneForZeroPreviewParams],
    query: { enabled: isDeploymentReady },
  });

  const token0SymbolRead = useReadContract({
    address: deployment.currency0,
    abi: demoErc20Abi,
    functionName: 'symbol',
    query: { enabled: isDeploymentReady },
  });
  const token1SymbolRead = useReadContract({
    address: deployment.currency1,
    abi: demoErc20Abi,
    functionName: 'symbol',
    query: { enabled: isDeploymentReady },
  });
  const token0DecimalsRead = useReadContract({
    address: deployment.currency0,
    abi: demoErc20Abi,
    functionName: 'decimals',
    query: { enabled: isDeploymentReady },
  });
  const token1DecimalsRead = useReadContract({
    address: deployment.currency1,
    abi: demoErc20Abi,
    functionName: 'decimals',
    query: { enabled: isDeploymentReady },
  });
  const token0BalanceRead = useReadContract({
    address: deployment.currency0,
    abi: demoErc20Abi,
    functionName: 'balanceOf',
    args: [address ?? deployment.hook],
    query: { enabled: isDeploymentReady && Boolean(address) },
  });
  const token1BalanceRead = useReadContract({
    address: deployment.currency1,
    abi: demoErc20Abi,
    functionName: 'balanceOf',
    args: [address ?? deployment.hook],
    query: { enabled: isDeploymentReady && Boolean(address) },
  });
  const token0AllowanceRead = useReadContract({
    address: deployment.currency0,
    abi: demoErc20Abi,
    functionName: 'allowance',
    args: [address ?? deployment.hook, deployment.poolSwapTest],
    query: { enabled: isDeploymentReady && Boolean(address) },
  });
  const token1AllowanceRead = useReadContract({
    address: deployment.currency1,
    abi: demoErc20Abi,
    functionName: 'allowance',
    args: [address ?? deployment.hook, deployment.poolSwapTest],
    query: { enabled: isDeploymentReady && Boolean(address) },
  });

  const risk = normalizeRiskState(riskRead.data);
  const token0Decimals = Number(token0DecimalsRead.data ?? 18);
  const token1Decimals = Number(token1DecimalsRead.data ?? 18);
  const token0Symbol = token0SymbolRead.data ?? 'TOKEN0';
  const token1Symbol = token1SymbolRead.data ?? 'TOKEN1';
  const owner = ownerRead.data;
  const isOwner = Boolean(owner && address && owner.toLowerCase() === address.toLowerCase());
  const isKeeper = Boolean(keeperRead.data);
  const isPriceUpdater = Boolean(priceUpdaterRead.data);

  const refreshReads = async () => {
    await Promise.allSettled([
      ownerRead.refetch(),
      keeperRead.refetch(),
      priceUpdaterRead.refetch(),
      riskRead.refetch(),
      netDeltaRead.refetch(),
      zeroForOneFeeRead.refetch(),
      oneForZeroFeeRead.refetch(),
      token0SymbolRead.refetch(),
      token1SymbolRead.refetch(),
      token0DecimalsRead.refetch(),
      token1DecimalsRead.refetch(),
      token0BalanceRead.refetch(),
      token1BalanceRead.refetch(),
      token0AllowanceRead.refetch(),
      token1AllowanceRead.refetch(),
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
      writeContractAsync({
        address: token,
        abi: demoErc20Abi,
        functionName: 'faucet',
      }),
    );

  const approve = (token: Address, symbol: string) =>
    submit(`Approve ${symbol}`, () =>
      writeContractAsync({
        address: token,
        abi: demoErc20Abi,
        functionName: 'approve',
        args: [deployment.poolSwapTest, maxUint256],
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
    if (!risk || risk.pendingHedgeBase === 0n) {
      setError('No pending hedge to record.');
      return;
    }
    return submit('Record hedge fill', () =>
      writeContractAsync({
        address: deployment.hook,
        abi: deltaNeutralHookAbi,
        functionName: 'recordHedgeFill',
        args: [poolKey, risk.hedgeNonce, risk.pendingHedgeBase],
      }),
    );
  };

  const setPaused = (paused: boolean) =>
    submit(paused ? 'Pause pool' : 'Unpause pool', () =>
      writeContractAsync({
        address: deployment.hook,
        abi: deltaNeutralHookAbi,
        functionName: 'setPoolPaused',
        args: [poolKey, paused],
      }),
    );

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Uniswap v4 Sepolia</p>
          <h1>Delta Neutral Hook Operator</h1>
        </div>
        <ConnectButton />
      </header>

      {!isDeploymentReady && (
        <section className="banner warning">
          <TriangleAlert size={18} />
          <span>
            No deployment loaded yet. Run `forge script script/DeploySepolia.s.sol:DeploySepolia --rpc-url
            $SEPOLIA_RPC_URL --broadcast --verify` to populate `src/generated/sepolia.json`.
          </span>
        </section>
      )}

      {isConnected && !onSepolia && (
        <section className="banner warning">
          <TriangleAlert size={18} />
          <span>Your wallet is not on Sepolia.</span>
          <button className="button compact" onClick={() => switchChain({ chainId: sepolia.id })}>
            Switch
          </button>
        </section>
      )}

      <section className="grid two">
        <Card title="Deployment" icon={<ShieldCheck size={18} />}>
          <KeyValue label="Hook" value={shortAddress(deployment.hook)} />
          <KeyValue label="Pool ID" value={shortHash(deployment.poolId)} />
          <KeyValue label="PoolManager" value={shortAddress(deployment.poolManager)} />
          <KeyValue label="PoolSwapTest" value={shortAddress(deployment.poolSwapTest)} />
          <KeyValue label="Currency 0" value={`${token0Symbol} ${shortAddress(deployment.currency0)}`} />
          <KeyValue label="Currency 1" value={`${token1Symbol} ${shortAddress(deployment.currency1)}`} />
        </Card>

        <Card title="Wallet Roles" icon={<CheckCircle2 size={18} />}>
          <KeyValue label="Connected" value={address ? shortAddress(address) : 'Not connected'} />
          <KeyValue label="Owner" value={isOwner ? 'Yes' : 'No'} />
          <KeyValue label="Keeper" value={isKeeper ? 'Yes' : 'No'} />
          <KeyValue label="Price updater" value={isPriceUpdater ? 'Yes' : 'No'} />
        </Card>
      </section>

      <section className="grid three">
        <Metric
          label="Pool base exposure"
          value={formatSigned(risk?.poolBaseExposure ?? 0n, 18)}
          sub={deployment.baseIsCurrency0 ? token0Symbol : token1Symbol}
        />
        <Metric
          label="Reported hedge"
          value={formatSigned(risk?.reportedHedgeBase ?? 0n, 18)}
          sub="external hedge"
        />
        <Metric
          label="Pending hedge"
          value={formatSigned(risk?.pendingHedgeBase ?? 0n, 18)}
          sub={`nonce ${risk?.hedgeNonce ?? 0n}`}
          tone={(risk?.pendingHedgeBase ?? 0n) === 0n ? 'good' : 'warn'}
        />
      </section>

      <section className="grid two">
        <Card title="Token Setup" icon={<Droplets size={18} />}>
          <div className="token-row">
            <div>
              <strong>{token0Symbol}</strong>
              <p>{formatToken(token0BalanceRead.data ?? 0n, token0Decimals)}</p>
              <small>Allowance: {formatToken(token0AllowanceRead.data ?? 0n, token0Decimals)}</small>
            </div>
            <div className="button-row">
              <button className="button" disabled={!canWrite || Boolean(busyLabel)} onClick={() => faucet(deployment.currency0, token0Symbol)}>
                <Droplets size={16} /> Faucet
              </button>
              <button className="button" disabled={!canWrite || Boolean(busyLabel)} onClick={() => approve(deployment.currency0, token0Symbol)}>
                <CheckCircle2 size={16} /> Approve
              </button>
            </div>
          </div>

          <div className="token-row">
            <div>
              <strong>{token1Symbol}</strong>
              <p>{formatToken(token1BalanceRead.data ?? 0n, token1Decimals)}</p>
              <small>Allowance: {formatToken(token1AllowanceRead.data ?? 0n, token1Decimals)}</small>
            </div>
            <div className="button-row">
              <button className="button" disabled={!canWrite || Boolean(busyLabel)} onClick={() => faucet(deployment.currency1, token1Symbol)}>
                <Droplets size={16} /> Faucet
              </button>
              <button className="button" disabled={!canWrite || Boolean(busyLabel)} onClick={() => approve(deployment.currency1, token1Symbol)}>
                <CheckCircle2 size={16} /> Approve
              </button>
            </div>
          </div>
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

      <section className="grid two">
        <Card title="Reference Price" icon={<RefreshCw size={18} />}>
          <label className="field">
            Reference price
            <input value={referencePrice} onChange={(event) => setReferencePrice(event.target.value)} inputMode="decimal" />
          </label>
          <KeyValue label="Last X96" value={String(risk?.lastReferencePriceX96 ?? 0n)} />
          <KeyValue label="Last update" value={timestampLabel(risk?.lastReferenceTimestamp ?? 0n)} />
          <button className="button" disabled={!canWrite || !isPriceUpdater || Boolean(busyLabel)} onClick={updateReferencePrice}>
            <RefreshCw size={16} /> Update price
          </button>
        </Card>

        <Card title="Risk Controls" icon={<ShieldCheck size={18} />}>
          <KeyValue label="Net delta" value={formatSigned((netDeltaRead.data as bigint | undefined) ?? 0n, 18)} />
          <KeyValue label="Paused" value={risk?.paused ? 'Yes' : 'No'} />
          <div className="button-row">
            <button className="button" disabled={!canWrite || !isKeeper || (risk?.pendingHedgeBase ?? 0n) === 0n || Boolean(busyLabel)} onClick={recordHedgeFill}>
              <ShieldCheck size={16} /> Record hedge fill
            </button>
            <button className="button" disabled={!canWrite || !isOwner || Boolean(busyLabel)} onClick={() => setPaused(!risk?.paused)}>
              {risk?.paused ? <Play size={16} /> : <Pause size={16} />}
              {risk?.paused ? 'Unpause' : 'Pause'}
            </button>
          </div>
        </Card>
      </section>

      {(busyLabel || lastTx || error) && (
        <section className={`banner ${error ? 'error' : 'info'}`}>
          {busyLabel ? <RefreshCw className="spin" size={18} /> : error ? <TriangleAlert size={18} /> : <CheckCircle2 size={18} />}
          <span>{busyLabel ?? error ?? `Confirmed ${shortHash(lastTx ?? '0x')}`}</span>
        </section>
      )}
    </main>
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

function normalizeRiskState(data: unknown): RiskState | null {
  if (!data) return null;
  const value = data as Partial<RiskState> & Record<number, unknown>;
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

function coerceBigInt(value: unknown) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
    return BigInt(value);
  }
  return 0n;
}

function decimalToQ96(value: string) {
  const scaled = parseUnits(value || '0', 6);
  return (scaled * Q96) / 1_000_000n;
}

function formatSigned(value: bigint, decimals: number) {
  const sign = value < 0n ? '-' : value > 0n ? '+' : '';
  const abs = value < 0n ? -value : value;
  return `${sign}${formatToken(abs, decimals)}`;
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

function timestampLabel(timestamp: bigint) {
  if (timestamp === 0n) return '-';
  return new Date(Number(timestamp) * 1000).toLocaleString();
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
