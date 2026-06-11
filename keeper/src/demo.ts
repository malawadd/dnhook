import { createPublicClient, createWalletClient, formatUnits, http, maxUint256, parseUnits, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import {
  demoErc20Abi,
  demoHedgeAdapterAbi,
  poolSwapTestAbi,
  productionHookAbi,
  productionLiquidityRouterAbi,
} from './abi.js';
import { loadDeployment, poolKeyFromDeployment } from './deployment.js';
import { loadKeeperConfig } from './env.js';
import {
  computeAcceptablePrice,
  normalizeProductionPoolConfig,
  normalizeProductionRiskState,
  type ProductionRiskState,
} from './risk.js';

const MIN_SQRT_PRICE_LIMIT = 4_295_128_740n;
const MAX_SQRT_PRICE_LIMIT = 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_341n;
const SALT_ZERO = `0x${'0'.repeat(64)}` as const;
const scenario = (process.argv[2] ?? 'full') as 'happy' | 'defensive' | 'full';

process.env.HOOK_MODE = 'production';

async function main() {
  const config = loadKeeperConfig();
  const deployment = loadDeployment('production');
  assertProductionDeployment(deployment);

  const account = privateKeyToAccount(config.privateKey);
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(config.rpcUrl) });
  const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(config.rpcUrl) });
  const poolKey = poolKeyFromDeployment(deployment);

  console.log(`Production demo scenario: ${scenario}`);
  console.log(`Operator: ${account.address}`);
  console.log(`Hook: ${deployment.hook}`);
  console.log(`Pool: ${deployment.poolId}`);

  const keeperAllowed = await publicClient.readContract({
    address: deployment.hook,
    abi: productionHookAbi,
    functionName: 'keepers',
    args: [account.address],
  });
  if (!keeperAllowed) throw new Error('Operator is not a keeper on the production hook.');

  await ensureTokenReady('currency0', deployment.currency0, deployment.poolSwapTest, publicClient, walletClient, account.address);
  await ensureTokenReady('currency1', deployment.currency1, deployment.poolSwapTest, publicClient, walletClient, account.address);
  await ensureTokenReady('currency0 LP', deployment.currency0, deployment.liquidityRouter, publicClient, walletClient, account.address);
  await ensureTokenReady('currency1 LP', deployment.currency1, deployment.liquidityRouter, publicClient, walletClient, account.address);

  if (scenario === 'happy' || scenario === 'full') {
    await happyPath(deployment, poolKey, publicClient, walletClient);
  }
  if (scenario === 'defensive' || scenario === 'full') {
    await defensivePath(deployment, poolKey, publicClient, walletClient);
  }
}

async function happyPath(deployment: ReturnType<typeof loadDeployment>, poolKey: ReturnType<typeof poolKeyFromDeployment>, publicClient: any, walletClient: any) {
  console.log('\n== Happy path: exposure -> hedge request -> settlement ==');
  await syncSnapshot(deployment.hook, poolKey, publicClient, walletClient);
  await settleOrRebalanceIfNeeded(deployment, poolKey, publicClient, walletClient);

  await addLiquidity(deployment, poolKey, publicClient, walletClient, parseUnits('1', 18));
  await swap(deployment, poolKey, publicClient, walletClient, deployment.baseIsCurrency0, parseUnits('2', 18));

  const before = await readProductionState(deployment.hook, poolKey, publicClient);
  logState('before hedge', before);
  await settleOrRebalanceIfNeeded(deployment, poolKey, publicClient, walletClient, before);
  const after = await readProductionState(deployment.hook, poolKey, publicClient);
  logState('after hedge', after);
}

async function defensivePath(deployment: ReturnType<typeof loadDeployment>, poolKey: ReturnType<typeof poolKeyFromDeployment>, publicClient: any, walletClient: any) {
  console.log('\n== Defensive path: unhealthy adapter blocks worsening flow ==');
  await addLiquidity(deployment, poolKey, publicClient, walletClient, parseUnits('1', 18));
  const exposed = await readProductionState(deployment.hook, poolKey, publicClient);
  logState('exposed', exposed);

  await writeAndWait(
    publicClient,
    walletClient.writeContract({
      address: deployment.hedgeAdapter,
      abi: demoHedgeAdapterAbi,
      functionName: 'setHealthy',
      args: [deployment.poolId, false],
      gas: 300_000n,
    }),
    'adapter.setHealthy(false)',
  );
  await syncSnapshot(deployment.hook, poolKey, publicClient, walletClient);

  const worseningZeroForOne =
    exposed.state.netBaseDelta >= 0n ? Boolean(deployment.baseIsCurrency0) : !deployment.baseIsCurrency0;
  await expectSwapRevert(deployment, poolKey, publicClient, walletClient, worseningZeroForOne);
  await swap(deployment, poolKey, publicClient, walletClient, !worseningZeroForOne, parseUnits('0.1', 18));

  await writeAndWait(
    publicClient,
    walletClient.writeContract({
      address: deployment.hedgeAdapter,
      abi: demoHedgeAdapterAbi,
      functionName: 'resetDemoSnapshot',
      args: [deployment.poolId, parseUnits('2000', 18), parseUnits('100000', 18)],
      gas: 300_000n,
    }),
    'adapter.resetDemoSnapshot',
  );
  await syncSnapshot(deployment.hook, poolKey, publicClient, walletClient);
  const recoveredBeforeHedge = await readProductionState(deployment.hook, poolKey, publicClient);
  await settleOrRebalanceIfNeeded(deployment, poolKey, publicClient, walletClient, recoveredBeforeHedge);
  const recovered = await readProductionState(deployment.hook, poolKey, publicClient);
  logState('recovered', recovered);
}

async function settleOrRebalanceIfNeeded(
  deployment: ReturnType<typeof loadDeployment>,
  poolKey: ReturnType<typeof poolKeyFromDeployment>,
  publicClient: any,
  walletClient: any,
  observed?: Awaited<ReturnType<typeof readProductionState>>,
) {
  const { state, config } = observed ?? (await readProductionState(deployment.hook, poolKey, publicClient));
  if (state.pendingOrderId !== `0x${'0'.repeat(64)}` || state.pendingOrderBase !== 0n) {
    await settleWithRetry(deployment.hook, poolKey, publicClient, walletClient);
    return;
  }
  if (abs(state.netBaseDelta) < config.hedgeThresholdBase) {
    console.log('No rebalance needed: net delta is inside threshold.');
    return;
  }

  const hedgeDelta = -state.netBaseDelta;
  const acceptablePrice = computeAcceptablePrice(state.lastMarkPrice, hedgeDelta, 100n);
  await writeAndWait(
    publicClient,
    walletClient.writeContract({
        address: deployment.hook,
        abi: productionHookAbi,
        functionName: 'rebalance',
        args: [poolKey, acceptablePrice],
        gas: 1_000_000n,
    }),
    'hook.rebalance',
  );
  await waitForPendingOrder(deployment.hook, poolKey, publicClient);
  await settleWithRetry(deployment.hook, poolKey, publicClient, walletClient);
}

async function waitForPendingOrder(hook: Address, poolKey: ReturnType<typeof poolKeyFromDeployment>, publicClient: any) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const { state } = await readProductionState(hook, poolKey, publicClient);
    if (state.pendingOrderId !== `0x${'0'.repeat(64)}` || state.pendingOrderBase !== 0n) return;
    await sleep(1500);
  }
}

async function settleWithRetry(
  hook: Address,
  poolKey: ReturnType<typeof poolKeyFromDeployment>,
  publicClient: any,
  walletClient: any,
) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await writeAndWait(
        publicClient,
        walletClient.writeContract({
          address: hook,
          abi: productionHookAbi,
          functionName: 'settleHedgeOrder',
          args: [poolKey],
          gas: 1_000_000n,
        }),
        'hook.settleHedgeOrder',
      );
      await waitForNoPendingOrder(hook, poolKey, publicClient);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('0x336d828f') && !message.includes('NoPendingOrder')) throw error;
      await sleep(2500);
    }
  }
  throw new Error('Pending order was not visible to the RPC in time for settlement.');
}

async function waitForNoPendingOrder(hook: Address, poolKey: ReturnType<typeof poolKeyFromDeployment>, publicClient: any) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const { state } = await readProductionState(hook, poolKey, publicClient);
    if (state.pendingOrderId === `0x${'0'.repeat(64)}` && state.pendingOrderBase === 0n) return;
    await sleep(1500);
  }
}

async function syncSnapshot(hook: Address, poolKey: ReturnType<typeof poolKeyFromDeployment>, publicClient: any, walletClient: any) {
  await writeAndWait(
    publicClient,
    walletClient.writeContract({
      address: hook,
      abi: productionHookAbi,
      functionName: 'syncHedgeSnapshot',
      args: [poolKey],
      gas: 500_000n,
    }),
    'hook.syncHedgeSnapshot',
  );
}

async function addLiquidity(deployment: ReturnType<typeof loadDeployment>, poolKey: ReturnType<typeof poolKeyFromDeployment>, publicClient: any, walletClient: any, amount: bigint) {
  await writeAndWait(
    publicClient,
    walletClient.writeContract({
      address: deployment.liquidityRouter,
      abi: productionLiquidityRouterAbi,
      functionName: 'modifyLiquidity',
      args: [poolKey, { tickLower: -600, tickUpper: 600, liquidityDelta: amount, salt: SALT_ZERO }, '0x'],
      gas: 1_500_000n,
    }),
    `liquidity.add(${formatUnits(amount, 18)})`,
  );
}

async function swap(deployment: ReturnType<typeof loadDeployment>, poolKey: ReturnType<typeof poolKeyFromDeployment>, publicClient: any, walletClient: any, zeroForOne: boolean, amount: bigint) {
  await writeAndWait(
    publicClient,
    walletClient.writeContract({
      address: deployment.poolSwapTest,
      abi: poolSwapTestAbi,
      functionName: 'swap',
      args: [
        poolKey,
        {
          zeroForOne,
          amountSpecified: -amount,
          sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE_LIMIT : MAX_SQRT_PRICE_LIMIT,
        },
        { takeClaims: false, settleUsingBurn: false },
        '0x',
      ],
      gas: 1_000_000n,
    }),
    `swap(${zeroForOne ? '0->1' : '1->0'}, ${formatUnits(amount, 18)})`,
  );
}

async function expectSwapRevert(deployment: ReturnType<typeof loadDeployment>, poolKey: ReturnType<typeof poolKeyFromDeployment>, publicClient: any, walletClient: any, zeroForOne: boolean) {
  try {
    await swap(deployment, poolKey, publicClient, walletClient, zeroForOne, parseUnits('0.1', 18));
    console.log('Expected defensive swap to revert, but it succeeded.');
  } catch (error) {
    console.log(`Defensive block observed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
  }
}

async function ensureTokenReady(label: string, token: Address, spender: Address, publicClient: any, walletClient: any, owner: Address) {
  const balance = await publicClient.readContract({
    address: token,
    abi: demoErc20Abi,
    functionName: 'balanceOf',
    args: [owner],
  });
  if (balance < parseUnits('500', 18)) {
    await writeAndWait(
      publicClient,
      walletClient.writeContract({ address: token, abi: demoErc20Abi, functionName: 'faucet', gas: 200_000n }),
      `${label}.faucet`,
    );
  }

  const allowance = await publicClient.readContract({
    address: token,
    abi: demoErc20Abi,
    functionName: 'allowance',
    args: [owner, spender],
  });
  if (allowance < parseUnits('500', 18)) {
    await writeAndWait(
      publicClient,
      walletClient.writeContract({
        address: token,
        abi: demoErc20Abi,
        functionName: 'approve',
        args: [spender, maxUint256],
        gas: 200_000n,
      }),
      `${label}.approve`,
    );
  }
}

async function readProductionState(hook: Address, poolKey: ReturnType<typeof poolKeyFromDeployment>, publicClient: any) {
  const [rawState, rawConfig] = await Promise.all([
    publicClient.readContract({ address: hook, abi: productionHookAbi, functionName: 'getRiskState', args: [poolKey] }),
    publicClient.readContract({ address: hook, abi: productionHookAbi, functionName: 'getPoolConfig', args: [poolKey] }),
  ]);
  return {
    state: normalizeProductionRiskState(rawState),
    config: normalizeProductionPoolConfig(rawConfig),
  };
}

async function writeAndWait(publicClient: any, hashPromise: Promise<`0x${string}`>, label: string) {
  const hash = await hashPromise;
  console.log(`${label}: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    throw new Error(`${label} reverted: ${hash}`);
  }
}

function logState(label: string, snapshot: { state: ProductionRiskState }) {
  const state = snapshot.state;
  console.log(
    `[${label}] pool=${state.poolBaseExposure.toString()} hedge=${state.hedgePositionBase.toString()} net=${state.netBaseDelta.toString()} pending=${state.pendingOrderBase.toString()} health=${state.healthMode}`,
  );
}

function assertProductionDeployment(deployment: ReturnType<typeof loadDeployment>): asserts deployment is ReturnType<typeof loadDeployment> & {
  hedgeAdapter: Address;
  poolSwapTest: Address;
  liquidityRouter: Address;
} {
  if (!deployment.hedgeAdapter || !deployment.poolSwapTest || !deployment.liquidityRouter) {
    throw new Error('Production deployment artifact is missing hedgeAdapter, poolSwapTest, or liquidityRouter.');
  }
}

function abs(value: bigint) {
  return value < 0n ? -value : value;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
