# Frontend Delta Neutral Demo Plan

## Summary
Turn the current operator UI into a delta-neutral story dashboard: show how swaps create base exposure, how the hook computes net delta, when it requests a hedge, and how a keeper fill brings the pool back toward neutral. The app should feel like a live risk cockpit for the Uniswap v4 hook, not just raw contract controls.

## Key UI Changes
- Add a top-level Delta Equation panel: `poolBaseExposure + reportedHedgeBase = netBaseDelta`.
- Show `pendingHedgeBase = -netBaseDelta` once `abs(netBaseDelta) >= hedgeThresholdBase`.
- Label signs clearly as long base, short base, or neutral.
- Add a Delta Neutral Status: neutral, inside band, hedge pending, or defensive.
- Add a Hedge Lifecycle timeline: swap, compute delta, emit hedge intent, keeper fill, return toward neutral.
- Add Swap Impact Preview cards showing whether each direction increases or reduces base exposure, the preview fee, and whether the swap is discounted, bumped, normal, or blocked.
- Add Risk Guardrails: hedge threshold, max unhedged base, net delta as a share of limits, price freshness, paused/stale/blocked indicators.
- Add a Hedge Intent Feed from recent `HedgeIntent` logs.
- Add a Guided Demo Checklist: faucet, approve, swap, observe pending hedge, record hedge fill, confirm net delta reduction.

## Computation Model
- Add pure frontend helpers for:
  - `netBaseDelta = poolBaseExposure + reportedHedgeBase`
  - `desiredHedgeDelta = abs(netBaseDelta) >= hedgeThresholdBase ? -netBaseDelta : 0`
  - `swapDirection = zeroForOne === baseIsCurrency0 ? +1 : -1`
  - `exposureIncreasing = netDelta !== 0 && sign(netDelta) === sign(swapDirection)`
  - fee classification from deployed params: target, bump, discount, min, max.
- Use deployment params already present in `src/generated/sepolia.json`.
- Keep the wording precise: this is a demo keeper-recorded hedge, not an automatically executed external hedge.

## Visual Design
- Keep the existing dark operational style.
- Use compact panels, progress bars, status chips, and timeline rows rather than marketing content.
- Make neutral, inside band, pending, and blocked states visible without requiring the user to read every number.
- Preserve the existing faucet, approval, swap, reference price, hedge fill, and pause controls.

## Test Plan
- Add unit tests for the pure risk math helpers.
- Run `npm run build` to verify TypeScript and Next.js.
- Manually confirm that swaps change the equation, threshold-crossing creates a pending hedge, keeper fills reduce net delta, preview fees explain directionality, and `HedgeIntent` logs appear in the feed.

## Assumptions
- The frontend remains a Sepolia demo/operator UI, not a production trading terminal.
- The hook remains responsible for accounting and fee policy.
- Keepers remain responsible for reporting external hedge fills.
- The app explains actual contract math from hook state and deployment config, not unsupported off-chain PnL or hedge execution.
