# Delta Neutral Hook

Standalone Uniswap v4 hook prototype for a delta-neutral market-making pool.

The hook does not call an off-chain exchange. Instead, it keeps the pool's on-chain
inventory accounting, adjusts dynamic LP fees according to unhedged exposure, emits
hedge intents, and accepts keeper-reported hedge fills.

## Core Flow

1. Swaps change the pool's base-token inventory.
2. `afterSwap` updates pool exposure and computes net delta:
   `poolBaseExposure + reportedHedgeBase`.
3. If net delta exceeds the configured threshold, the hook emits `HedgeIntent`.
4. A keeper executes the hedge externally and calls `recordHedgeFill`.
5. While exposure is pending, `beforeSwap` makes exposure-increasing flow more
   expensive and exposure-reducing flow cheaper.

This keeps the hook itself focused on the hook-related design while allowing a
hybrid keeper to complete the actual perp/order execution.

## Sepolia Deployment

```bash
cp .env.example .env
# Fill PRIVATE_KEY and SEPOLIA_RPC_URL

forge script script/DeploySepolia.s.sol:DeploySepolia \
  --rpc-url $SEPOLIA_RPC_URL \
  --broadcast \
  --verify
```

The script targets Ethereum Sepolia and uses the official Uniswap v4 test
deployments:

- PoolManager: `0xE03A1074c86CFeDd5C142C4F04F1a1536e203543`
- PoolSwapTest: `0x9b6b46e2c869aa39918db7f52f5557fe577b6eee`
- PoolModifyLiquidityTest: `0x0c478023803a644c94c4ce1c1e7b9a087e411b0a`

It deploys the hook, two demo ERC20s, initializes a dynamic-fee v4 pool,
configures the hook, seeds initial liquidity, and writes:

- `deployments/sepolia.json`
- `frontend/src/generated/sepolia.json`

## Frontend

```bash
cd frontend
cp .env.example .env.local
# Fill NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
npm install
npm run dev
```

The app is a RainbowKit/wagmi operator dashboard for faucet minting, token
approval, demo swaps, reference-price updates, hedge-fill reporting, and pause
controls.
