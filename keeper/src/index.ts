import { createPublicClient, createWalletClient, http, type Address, type Hash } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia, sepolia } from 'viem/chains';
import { capstoneHookAbi, productionHookAbi } from './abi.js';
import { loadDeployment, poolKeyFromDeployment, type HookMode, type PoolKey } from './deployment.js';
import { loadKeeperConfig } from './env.js';
import {
  decideHedgeFill,
  decideProductionAction,
  formatDeltaEquation,
  normalizeProductionPoolConfig,
  normalizeProductionRiskState,
  normalizeRiskState,
  type ProductionRiskState,
  type RiskState,
} from './risk.js';

type Clients = ReturnType<typeof createClients>;

const once = process.argv.includes('--once');

async function main() {
  const config = loadKeeperConfig();
  const deployment = loadDeployment(config.mode);
  const poolKey = poolKeyFromDeployment(deployment);
  const clients = createClients(config.rpcUrl, config.privateKey, config.mode);

  console.log(`Delta keeper ${config.dryRun ? '(dry run) ' : ''}for ${deployment.network} in ${config.mode} mode`);
  console.log(`Keeper address: ${clients.account.address}`);
  console.log(`Hook: ${deployment.hook}`);
  console.log(`Pool: ${deployment.poolId}`);

  const runInput = {
    clients,
    hook: deployment.hook,
    poolKey,
    dryRun: config.dryRun,
    mode: config.mode,
    maxHedgeSlippageBps: config.maxHedgeSlippageBps,
  };

  if (once) {
    await runKeeperOnce(runInput);
    return;
  }

  while (true) {
    await runKeeperOnce(runInput).catch((error) => {
      console.error(`Keeper tick failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    await sleep(config.pollIntervalMs);
  }
}

export async function runKeeperOnce(input: {
  clients: Clients;
  hook: Address;
  poolKey: PoolKey;
  dryRun: boolean;
  mode: HookMode;
  maxHedgeSlippageBps: bigint;
}): Promise<Hash | null> {
  if (input.mode === 'production') {
    return runProductionKeeperOnce(input);
  }
  return runCapstoneKeeperOnce(input);
}

async function runCapstoneKeeperOnce(input: {
  clients: Clients;
  hook: Address;
  poolKey: PoolKey;
  dryRun: boolean;
}): Promise<Hash | null> {
  const keeperAllowed = await input.clients.publicClient.readContract({
    address: input.hook,
    abi: capstoneHookAbi,
    functionName: 'keepers',
    args: [input.clients.account.address],
  });

  const observed = await readCapstoneRiskSnapshot(input.clients, input.hook, input.poolKey);
  logSnapshot('before', observed.state, observed.netDelta);

  if (observed.state.pendingHedgeBase === 0n || !keeperAllowed) {
    const decision = decideHedgeFill({
      keeperAllowed,
      dryRun: input.dryRun,
      observed: observed.state,
      latest: observed.state,
    });
    console.log(decision.message);
    return null;
  }

  const latest = await readCapstoneRiskSnapshot(input.clients, input.hook, input.poolKey);
  const decision = decideHedgeFill({
    keeperAllowed,
    dryRun: input.dryRun,
    observed: observed.state,
    latest: latest.state,
  });

  console.log(decision.message);
  if (decision.kind === 'skip' || decision.kind === 'dry-run') {
    if (decision.kind === 'dry-run') {
      console.log(`Would fill nonce ${decision.nonce} with ${decision.hedgeBaseDelta.toString()} base units.`);
    }
    return null;
  }

  const hash = await input.clients.walletClient.writeContract({
    address: input.hook,
    abi: capstoneHookAbi,
    functionName: 'recordHedgeFill',
    args: [input.poolKey, decision.nonce, decision.hedgeBaseDelta],
  });

  console.log(`Submitted recordHedgeFill: ${hash}`);
  await input.clients.publicClient.waitForTransactionReceipt({ hash });

  const after = await readCapstoneRiskSnapshot(input.clients, input.hook, input.poolKey);
  logSnapshot('after', after.state, after.netDelta);

  return hash;
}

async function runProductionKeeperOnce(input: {
  clients: Clients;
  hook: Address;
  poolKey: PoolKey;
  dryRun: boolean;
  maxHedgeSlippageBps: bigint;
}): Promise<Hash | null> {
  const keeperAllowed = await input.clients.publicClient.readContract({
    address: input.hook,
    abi: productionHookAbi,
    functionName: 'keepers',
    args: [input.clients.account.address],
  });

  if (input.dryRun) {
    console.log('Dry run: keeper would sync production hedge snapshot first.');
  } else if (keeperAllowed) {
    const syncHash = await input.clients.walletClient.writeContract({
      address: input.hook,
      abi: productionHookAbi,
      functionName: 'syncHedgeSnapshot',
      args: [input.poolKey],
    });
    console.log(`Submitted syncHedgeSnapshot: ${syncHash}`);
    await input.clients.publicClient.waitForTransactionReceipt({ hash: syncHash });
  }

  const [{ state, config }, block] = await Promise.all([
    readProductionSnapshot(input.clients, input.hook, input.poolKey),
    input.clients.publicClient.getBlock(),
  ]);
  logProductionSnapshot(state);

  const decision = decideProductionAction({
    keeperAllowed,
    state,
    config,
    now: block.timestamp,
    maxHedgeSlippageBps: input.maxHedgeSlippageBps,
  });
  console.log(decision.message);

  if (decision.kind === 'skip') return null;

  if (input.dryRun) {
    if (decision.kind === 'settle') console.log(`Would settle order ${decision.orderId}.`);
    if (decision.kind === 'rebalance') {
      console.log(
        `Would rebalance ${decision.hedgeBaseDelta.toString()} base units at acceptable price ${decision.acceptablePrice.toString()}.`,
      );
    }
    return null;
  }

  if (decision.kind === 'settle') {
    const hash = await input.clients.walletClient.writeContract({
      address: input.hook,
      abi: productionHookAbi,
      functionName: 'settleHedgeOrder',
      args: [input.poolKey],
    });
    console.log(`Submitted settleHedgeOrder: ${hash}`);
    await input.clients.publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  if (decision.kind === 'rebalance') {
    const hash = await input.clients.walletClient.writeContract({
      address: input.hook,
      abi: productionHookAbi,
      functionName: 'rebalance',
      args: [input.poolKey, decision.acceptablePrice],
    });
    console.log(`Submitted rebalance: ${hash}`);
    await input.clients.publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  return null;
}

function createClients(rpcUrl: string, privateKey: `0x${string}`, mode: HookMode) {
  const account = privateKeyToAccount(privateKey);
  const chain = mode === 'production' ? baseSepolia : sepolia;
  const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl),
  });
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(rpcUrl),
  });
  return { account, publicClient, walletClient };
}

async function readCapstoneRiskSnapshot(clients: Clients, hook: Address, poolKey: PoolKey) {
  const [rawState, netDelta] = await Promise.all([
    clients.publicClient.readContract({
      address: hook,
      abi: capstoneHookAbi,
      functionName: 'getRiskState',
      args: [poolKey],
    }),
    clients.publicClient.readContract({
      address: hook,
      abi: capstoneHookAbi,
      functionName: 'netBaseDelta',
      args: [poolKey],
    }),
  ]);

  return {
    state: normalizeRiskState(rawState),
    netDelta,
  };
}

async function readProductionSnapshot(clients: Clients, hook: Address, poolKey: PoolKey) {
  const [rawState, rawConfig] = await Promise.all([
    clients.publicClient.readContract({
      address: hook,
      abi: productionHookAbi,
      functionName: 'getRiskState',
      args: [poolKey],
    }),
    clients.publicClient.readContract({
      address: hook,
      abi: productionHookAbi,
      functionName: 'getPoolConfig',
      args: [poolKey],
    }),
  ]);

  return {
    state: normalizeProductionRiskState(rawState),
    config: normalizeProductionPoolConfig(rawConfig),
  };
}

function logSnapshot(label: string, state: RiskState, netDelta: bigint) {
  console.log(`[${label}] ${formatDeltaEquation(state, netDelta)}`);
  console.log(
    `[${label}] pending=${state.pendingHedgeBase.toString()} nonce=${state.hedgeNonce.toString()} paused=${state.paused}`,
  );
}

function logProductionSnapshot(state: ProductionRiskState) {
  console.log(
    `[production] ${formatDeltaEquation(
      {
        poolBaseExposure: state.poolBaseExposure,
        reportedHedgeBase: state.hedgePositionBase,
        pendingHedgeBase: state.pendingOrderBase,
        lastReferencePriceX96: 0n,
        lastReferenceTimestamp: state.lastSnapshotTimestamp,
        hedgeNonce: 0n,
        paused: state.healthMode === 4,
      },
      state.netBaseDelta,
    )}`,
  );
  console.log(
    `[production] pendingOrder=${state.pendingOrderId} pendingBase=${state.pendingOrderBase.toString()} mark=${state.lastMarkPrice.toString()} health=${state.healthMode}`,
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
