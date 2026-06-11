import { createPublicClient, createWalletClient, http, type Address, type Hash } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { deltaNeutralHookAbi } from './abi.js';
import { loadDeployment, poolKeyFromDeployment, type PoolKey } from './deployment.js';
import { loadKeeperConfig } from './env.js';
import { decideHedgeFill, formatDeltaEquation, normalizeRiskState, type RiskState } from './risk.js';

type Clients = ReturnType<typeof createClients>;

const once = process.argv.includes('--once');

async function main() {
  const config = loadKeeperConfig();
  const deployment = loadDeployment();
  const poolKey = poolKeyFromDeployment(deployment);
  const clients = createClients(config.rpcUrl, config.privateKey);

  console.log(`Delta keeper ${config.dryRun ? '(dry run) ' : ''}for ${deployment.network}`);
  console.log(`Keeper address: ${clients.account.address}`);
  console.log(`Hook: ${deployment.hook}`);
  console.log(`Pool: ${deployment.poolId}`);

  if (once) {
    await runKeeperOnce({ clients, hook: deployment.hook, poolKey, dryRun: config.dryRun });
    return;
  }

  while (true) {
    await runKeeperOnce({ clients, hook: deployment.hook, poolKey, dryRun: config.dryRun }).catch((error) => {
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
}): Promise<Hash | null> {
  const keeperAllowed = await input.clients.publicClient.readContract({
    address: input.hook,
    abi: deltaNeutralHookAbi,
    functionName: 'keepers',
    args: [input.clients.account.address],
  });

  const observed = await readRiskSnapshot(input.clients, input.hook, input.poolKey);
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

  const latest = await readRiskSnapshot(input.clients, input.hook, input.poolKey);
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
    abi: deltaNeutralHookAbi,
    functionName: 'recordHedgeFill',
    args: [input.poolKey, decision.nonce, decision.hedgeBaseDelta],
  });

  console.log(`Submitted recordHedgeFill: ${hash}`);
  await input.clients.publicClient.waitForTransactionReceipt({ hash });

  const after = await readRiskSnapshot(input.clients, input.hook, input.poolKey);
  logSnapshot('after', after.state, after.netDelta);

  return hash;
}

function createClients(rpcUrl: string, privateKey: `0x${string}`) {
  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({
    chain: sepolia,
    transport: http(rpcUrl),
  });
  const walletClient = createWalletClient({
    account,
    chain: sepolia,
    transport: http(rpcUrl),
  });
  return { account, publicClient, walletClient };
}

async function readRiskSnapshot(clients: Clients, hook: Address, poolKey: PoolKey) {
  const [rawState, netDelta] = await Promise.all([
    clients.publicClient.readContract({
      address: hook,
      abi: deltaNeutralHookAbi,
      functionName: 'getRiskState',
      args: [poolKey],
    }),
    clients.publicClient.readContract({
      address: hook,
      abi: deltaNeutralHookAbi,
      functionName: 'netBaseDelta',
      args: [poolKey],
    }),
  ]);

  return {
    state: normalizeRiskState(rawState),
    netDelta,
  };
}

function logSnapshot(label: string, state: RiskState, netDelta: bigint) {
  console.log(`[${label}] ${formatDeltaEquation(state, netDelta)}`);
  console.log(
    `[${label}] pending=${state.pendingHedgeBase.toString()} nonce=${state.hedgeNonce.toString()} paused=${state.paused}`,
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
