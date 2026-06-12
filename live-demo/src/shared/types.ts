export type HealthLabel = 'Neutral' | 'Flow building exposure' | 'Rebalance needed' | 'Order pending' | 'Hedge settled' | 'Defensive';

export type LiveConfigView = {
  mode: 'base-sepolia' | 'fork';
  chainId: number;
  network: string;
  hook: string;
  hedgeAdapter: string;
  poolId: string;
  traderCount: number;
  traderFundingEth: string;
  swapIntervalMs: number;
  keeperIntervalMs: number;
  maxTxPerMinute: number;
  maxRuntimeMinutes: number;
  writeRpcCount: number;
};

export type ForkShowcaseStatus = {
  status: 'setup' | 'running' | 'recovering' | 'stopping' | 'stopped' | 'failed';
  phase: string;
  loop: number;
  startedAt: number | null;
  elapsedMs: number;
  lastAction: string;
  lastTx?: string;
  error?: string;
  checks: {
    exposureBuilt: boolean;
    hedgeSettled: boolean;
    netDeltaNearNeutral: boolean;
    pnlApplied: boolean;
    collateralChanged: boolean;
    defensiveBlockObserved: boolean;
    recoveryComplete: boolean;
  };
};

export type RpcHealthView = {
  label: string;
  active: boolean;
  coolingDown: boolean;
  cooldownMs: number;
  failures: number;
  retries: number;
};

export type TraderView = {
  id: number;
  address: string;
  setupStatus: 'setup' | 'ready' | 'blocked' | 'trading';
  latestNonce: number;
  pendingNonce: number;
  rpcLabel: string;
  rpcCoolingDown: boolean;
  lastRpcError?: string;
  nativeBalanceEth: string;
  token0Balance: string;
  token1Balance: string;
  funded: boolean;
  ready: boolean;
  swapsSubmitted: number;
  swapsConfirmed: number;
  swapsFailed: number;
  lastTx?: string;
  lastError?: string;
};

export type LiveSnapshot = {
  timestamp: number;
  blockNumber: string;
  status: HealthLabel;
  runningTrading: boolean;
  runningKeeper: boolean;
  poolPriceUsd: number | null;
  tick: number | null;
  lastMarkPriceUsd: string;
  poolBaseExposure: string;
  hedgePositionBase: string;
  netBaseDelta: string;
  pendingOrderBase: string;
  targetHedgeBase: string;
  collateralUsd: string;
  realizedPnlUsd: string;
  unrealizedPnlUsd: string;
  pendingOrderId: string;
  pendingOrderReadyAt: string;
  adapterHealthy: boolean;
  healthMode: number;
  lpBaseDeposited: string;
  lpBaseWithdrawn: string;
  lpBaseFeesAccrued: string;
  txSubmitted: number;
  txConfirmed: number;
  txFailed: number;
  rpcHealth: RpcHealthView[];
  forkShowcase: ForkShowcaseStatus;
  traders: TraderView[];
  config: LiveConfigView;
};

export type LiveEventKind =
  | 'info'
  | 'warning'
  | 'error'
  | 'wallet'
  | 'funding'
  | 'token'
  | 'swap'
  | 'keeper'
  | 'scenario'
  | 'state';

export type LiveEvent = {
  id: number;
  timestamp: number;
  kind: LiveEventKind;
  message: string;
  txHash?: string;
  trader?: string;
};
