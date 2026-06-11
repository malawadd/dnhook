# Delta Neutral Hook

Delta Neutral Hook is a Uniswap v4 Hookathon capstone project exploring how a
market-making pool can account for inventory risk on-chain, expose hedge intent
to an external keeper, and use dynamic fees to guide order flow while the system
returns toward delta neutrality.

The project is intentionally deployed in a Sepolia demonstration environment
with mock assets and test routers, but the design question is broader: what
parts of a delta-neutral market maker belong inside a v4 hook, and what parts
should remain in off-chain execution infrastructure?

## Motivation

Traditional market makers are constantly managing inventory. If a pool becomes
long or short the base asset after swaps, its LPs are exposed to directional
price movement. A delta-neutral strategy tries to offset that exposure with an
external hedge, such as a perp, CEX, or lending-market position.

Uniswap v4 hooks make this design space interesting because a hook can sit
directly on the pool lifecycle. It can observe swaps, update risk accounting,
alter fees, and emit machine-readable intent without taking custody of an
external hedge venue. This project uses that hook surface to model a hybrid
on-chain/off-chain market maker:

- The hook owns pool inventory accounting and fee policy.
- The keeper owns external hedge execution or, in this capstone environment,
  simulated hedge reporting.
- The frontend makes the accounting loop visible for operators and reviewers.

## What The Hook Does

The hook tracks three core quantities for each configured pool:

```text
poolBaseExposure + reportedHedgeBase = netBaseDelta
```

- `poolBaseExposure`: base-asset exposure created by swaps through the v4 pool.
- `reportedHedgeBase`: hedge exposure reported by authorized keepers.
- `netBaseDelta`: remaining unhedged base exposure.
- `pendingHedgeBase`: the hedge delta the hook wants the keeper to fill.

When swaps move the pool away from neutral, `afterSwap` updates the pool's base
exposure. If the absolute net delta crosses `hedgeThresholdBase`, the hook emits
`HedgeIntent` and stores the target hedge:

```text
pendingHedgeBase = -netBaseDelta
```

That means a long base inventory requests a short hedge, and a short base
inventory requests a long hedge.

## Dynamic Fee Policy

The hook also changes swap fees based on whether a trade improves or worsens the
pool's current exposure.

- If a swap increases existing unhedged exposure, the hook applies an inventory
  fee bump.
- If a swap reduces existing exposure, the hook applies a fee discount.
- If exposure exceeds `maxUnhedgedBase`, exposure-increasing flow is blocked.
- If the reference price is stale or the pool is paused, fee preview and swaps
  fail defensively.

The goal is not to guarantee perfect neutrality on every block. The goal is to
combine accounting, incentives, and keeper execution so the pool has an explicit
risk loop instead of passive inventory drift.

## Architecture

```text
User swap
   |
   v
Uniswap v4 PoolManager
   |
   | beforeSwap: compute dynamic fee / block unsafe flow
   v
DeltaNeutralHook
   |
   | afterSwap: update poolBaseExposure
   |           compute netBaseDelta
   |           emit HedgeIntent if threshold crossed
   v
Keeper
   |
   | execute or simulate external hedge
   | call recordHedgeFill
   v
DeltaNeutralHook
   |
   | update reportedHedgeBase
   | clear or update pending hedge
   v
Frontend operator dashboard
```

The hook deliberately does not call an exchange, perp protocol, or oracle inside
swap execution. That separation is part of the design: the hook remains a
deterministic accounting and policy layer, while keepers handle venue-specific
hedging.

## Hook Surface

The hook uses these v4 permissions:

- `beforeInitialize`: require a dynamic-fee pool.
- `beforeSwap`: return an override fee based on current exposure.
- `afterSwap`: update base exposure and synchronize hedge intent.

Main contract entry points:

- `configurePool`: owner configures base token orientation, fee bounds, stale
  price window, hedge threshold, and max unhedged exposure.
- `updateReferencePrice`: price updater posts a reference price used for
  freshness checks and emitted hedge context.
- `getRiskState`: reads pool exposure, reported hedge, pending hedge, reference
  price, nonce, and pause state.
- `netBaseDelta`: returns `poolBaseExposure + reportedHedgeBase`.
- `previewFee`: shows the fee a swap direction would receive right now.
- `recordHedgeFill`: keeper reports the hedge delta that was filled externally.
- `setPoolPaused`: owner pause control for the configured pool.

## Keeper Loop

The TypeScript keeper is included so reviewers can see the full delta-neutral
accounting loop, not just the hook in isolation.

In this capstone deployment, the keeper simulates the external hedge by reading
`pendingHedgeBase` and reporting that exact fill back to the hook:

```text
recordHedgeFill(poolKey, hedgeNonce, pendingHedgeBase)
```

This is not presented as a production hedging engine. It is the minimum honest
keeper needed to demonstrate the mechanism:

1. A swap creates pool exposure.
2. The hook emits a hedge target.
3. The keeper records the corresponding hedge fill.
4. `reportedHedgeBase` changes.
5. `netBaseDelta` returns toward zero.

A production version could replace the simulated fill with a real perp/CEX trade
before calling `recordHedgeFill`.

## Frontend

The frontend is a RainbowKit and wagmi operator dashboard. It is intentionally
self-contained under `frontend/` so it can be deployed as its own Vercel project.

It currently supports:

- wallet connection on Ethereum Sepolia
- deployment and pool-key display
- mock token faucet and approvals
- swap simulation through Sepolia `PoolSwapTest`
- risk reads from the hook
- reference price updates
- keeper hedge-fill reporting
- pool pause/unpause controls

The dashboard is meant to show the live state transitions behind the strategy:
pool exposure, reported hedge, pending hedge, net delta, dynamic fee preview, and
authorized roles.

## Sepolia Deployment

The current Sepolia deployment uses official Uniswap v4 test infrastructure and
mock ERC20 assets for a repeatable capstone demo.

- PoolManager: `0xE03A1074c86CFeDd5C142C4F04F1a1536e203543`
- PoolSwapTest: `0x9B6b46e2c869aa39918Db7f52f5557FE577B6eEe`
- PoolModifyLiquidityTest: `0x0C478023803a644c94c4CE1C1e7b9A087e411B0A`
- Hook: `0x7973Cc2DCC1d6003eD8ed9374e5AA7cF5deeA0c0`
- dWETH: `0xc228690aD6a65182C8CFbDC422c92039C8975ABe`
- dUSDC: `0xF952fCC11cd07528D2093852ed37b5868cc2A469`
- Pool ID:
  `0x06ab8729fca805161a8bf832999b9342ca9c0d835a942817ebde97282d3e9908`

Deployment artifacts are written to:

- `deployments/sepolia.json`
- `frontend/src/generated/sepolia.json`

## Running The Contracts

```bash
cp .env.example .env
# Fill PRIVATE_KEY, SEPOLIA_RPC_URL, and optionally ETHERSCAN_API_KEY

forge test

forge script script/DeploySepolia.s.sol:DeploySepolia \
  --rpc-url $SEPOLIA_RPC_URL \
  --broadcast \
  --verify
```

The deploy script:

1. Mines a hook address with the required v4 permission flags.
2. Deploys the hook with the deployer as owner, keeper, and price updater.
3. Deploys mock dWETH and dUSDC.
4. Initializes a dynamic-fee v4 pool.
5. Configures risk and fee parameters.
6. Posts the initial reference price.
7. Seeds initial liquidity.
8. Writes deployment JSON for scripts and frontend.

## Running The Keeper

```bash
cd keeper
npm install

# Run one keeper tick
npm run once

# Poll continuously
npm run dev

# Inspect the action without sending a transaction
DRY_RUN=true npm run once
```

On PowerShell:

```powershell
$env:DRY_RUN='true'; npm run once
```

The keeper loads `../.env` by default and also supports a keeper-local `.env`.
Use `KEEPER_PRIVATE_KEY` for a dedicated keeper wallet, or omit it to fall back
to `PRIVATE_KEY`. The wallet must be authorized by `keepers(address)` on the hook
before it can record fills.

## Running The Frontend

```bash
cd frontend
cp .env.example .env.local
# Fill NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID and NEXT_PUBLIC_SEPOLIA_RPC_URL
npm install
npm run dev
```

For Vercel, set the project root to `frontend/` and configure the same public
environment variables.

## Suggested Review Flow

1. Open the frontend on Sepolia.
2. Faucet and approve both mock tokens.
3. Execute a swap that creates base exposure.
4. Observe `poolBaseExposure`, `netBaseDelta`, and `pendingHedgeBase`.
5. Run the keeper in dry-run mode to inspect the intended hedge fill.
6. Run the keeper once without dry-run to record the fill.
7. Refresh the frontend and observe `reportedHedgeBase` and reduced net delta.
8. Compare both swap directions in `previewFee` to see how the hook prices flow
   that increases or reduces exposure.

## Limitations And Next Steps

This project is a research capstone, so several production pieces are
intentionally left as future work:

- replace simulated keeper fills with real external hedge execution
- connect reference price updates to a robust oracle or keeper network
- add richer event history to the frontend
- support multiple pools from one keeper process
- model partial hedge fills and hedge slippage
- add operator alerting for stale price, blocked flow, and excessive exposure
- harden access control and operational runbooks for production deployment

The important part of this implementation is the boundary: the hook turns v4
pool flow into explicit inventory accounting and hedge intent, while the keeper
turns that intent into reported hedge state. That boundary is the core design
exercise of the project.
