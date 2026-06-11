import { createPublicClient, createWalletClient, http, parseUnits, type Hash } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { demoHedgeAdapterAbi, productionHookAbi } from './abi.js';
import { loadDeployment, poolKeyFromDeployment } from './deployment.js';
import { loadKeeperConfig } from './env.js';

process.env.HOOK_MODE = 'production';

async function main() {
  if (process.env.DEMO_ADAPTER_RECOVERY !== 'true') {
    throw new Error('Set DEMO_ADAPTER_RECOVERY=true to run the controlled demo adapter recovery command.');
  }

  const config = loadKeeperConfig();
  const deployment = loadDeployment('production');
  const poolKey = poolKeyFromDeployment(deployment);
  if (!deployment.hedgeAdapter) throw new Error('Production deployment is missing hedgeAdapter.');

  const account = privateKeyToAccount(config.privateKey);
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(config.rpcUrl) });
  const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(config.rpcUrl) });

  console.log(`Recovering demo adapter snapshot for ${deployment.network}`);
  console.log(`Operator: ${account.address}`);
  console.log(`Hook: ${deployment.hook}`);
  console.log(`Adapter: ${deployment.hedgeAdapter}`);
  console.log(`Pool: ${deployment.poolId}`);

  const resetHash = await walletClient.writeContract({
    address: deployment.hedgeAdapter,
    abi: demoHedgeAdapterAbi,
    functionName: 'resetDemoSnapshot',
    args: [deployment.poolId, parseUnits('2000', 18), parseUnits('100000', 18)],
    gas: 300_000n,
  });
  console.log(`Submitted resetDemoSnapshot: ${resetHash}`);
  await waitForSuccess(publicClient, resetHash, 'resetDemoSnapshot');

  const syncHash = await walletClient.writeContract({
    address: deployment.hook,
    abi: productionHookAbi,
    functionName: 'syncHedgeSnapshot',
    args: [poolKey],
    gas: 500_000n,
  });
  console.log(`Submitted syncHedgeSnapshot: ${syncHash}`);
  await waitForSuccess(publicClient, syncHash, 'syncHedgeSnapshot');
  console.log('Demo adapter snapshot recovered and synced.');
}

async function waitForSuccess(publicClient: { waitForTransactionReceipt: (args: { hash: Hash }) => Promise<{ status: 'success' | 'reverted' }> }, hash: Hash, label: string) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${label} reverted: ${hash}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
