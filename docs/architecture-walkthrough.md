# Delta-Neutral Hook — Architecture Walkthrough

> A step-by-step visual tour from the original `DeltaNeutralHook` through to `ProductionDeltaNeutralHook`, showing exactly what was added, upgraded, and why.

---

## Part 1 — `DeltaNeutralHook` (v1)

### Step 1 · High-Level Actor Map

Who talks to the hook, and how.

```mermaid
graph TD
    subgraph External Actors
        Owner["👤 Owner"]
        Keeper["🤖 Keeper / Off-chain Bot"]
        PriceUpdater["📡 Price Updater"]
        Trader["🔄 Trader"]
        LP["💧 Liquidity Provider"]
    end

    subgraph Uniswap v4
        PM["IPoolManager"]
    end

    subgraph DeltaNeutralHook
        Hook["DeltaNeutralHook"]
    end

    Owner -->|"configurePool / setKeeper / setPriceUpdater / pause"| Hook
    PriceUpdater -->|"updateReferencePrice()"| Hook
    Keeper -->|"recordHedgeFill()"| Hook
    Trader -->|"swap"| PM
    LP -->|"addLiquidity / removeLiquidity"| PM
    PM -->|"beforeSwap / afterSwap"| Hook
    Hook -.->|"emits HedgeIntent (off-chain reads)"| Keeper
```

---

### Step 2 · Data Model

The two core structs that live in storage for each pool.

```mermaid
classDiagram
    class PoolConfig {
        +bool configured
        +bool baseIsCurrency0
        +uint24 minFeePips
        +uint24 targetFeePips
        +uint24 maxFeePips
        +uint24 inventoryFeeBumpPips
        +uint24 inventoryFeeDiscountPips
        +uint256 maxPriceAge
        +uint256 hedgeThresholdBase
        +uint256 maxUnhedgedBase
    }

    class PoolRiskState {
        +int256 poolBaseExposure
        +int256 reportedHedgeBase
        +int256 pendingHedgeBase
        +uint256 lastReferencePriceX96
        +uint256 lastReferenceTimestamp
        +uint256 hedgeNonce
        +bool paused
    }

    PoolConfig "1" --> "1" PoolRiskState : keyed by PoolId
```

---

### Step 3 · Hook Permissions

Which Uniswap v4 callback slots this contract occupies.

```mermaid
graph LR
    subgraph Hook Callbacks ["Hook Callbacks — Active = ✅  Inactive = ❌"]
        BI["✅ beforeInitialize\n(enforce dynamic fee)"]
        AI["❌ afterInitialize"]
        BAL["❌ beforeAddLiquidity"]
        AAL["❌ afterAddLiquidity"]
        BRL["❌ beforeRemoveLiquidity"]
        ARL["❌ afterRemoveLiquidity"]
        BS["✅ beforeSwap\n(compute & return fee)"]
        AS["✅ afterSwap\n(track exposure + hedge intent)"]
        BD["❌ beforeDonate"]
        AD["❌ afterDonate"]
    end
```

> **Key observation:** liquidity callbacks are stubs — the hook does *not* track who adds or removes liquidity.

---

### Step 4 · Swap Flow

The full path from a trader's swap to the hedge signal.

```mermaid
sequenceDiagram
    participant Trader
    participant PoolManager
    participant Hook as DeltaNeutralHook
    participant Keeper as Off-chain Keeper

    Trader->>PoolManager: swap(...)
    PoolManager->>Hook: beforeSwap(key, params)
    Note over Hook: _computeFee()<br/>• check paused<br/>• check price freshness<br/>• check maxUnhedgedBase<br/>• bias fee ±inventoryPips
    Hook-->>PoolManager: (selector, ZERO_DELTA, feePips | OVERRIDE_FEE_FLAG)

    PoolManager->>Hook: afterSwap(key, delta)
    Note over Hook: state.poolBaseExposure -= baseCallerDelta<br/>_syncHedgeIntent()
    alt netDelta ≥ hedgeThresholdBase
        Hook-->>Keeper: emit HedgeIntent(nonce, netDelta, hedgeDeltaBase, price)
    end
    Hook-->>PoolManager: (selector, 0)

    Keeper->>Hook: recordHedgeFill(key, nonce, hedgeBaseDelta)
    Note over Hook: state.reportedHedgeBase += hedgeBaseDelta<br/>emit HedgeFillRecorded<br/>_syncHedgeIntent() again
```

---

### Step 5 · Dynamic Fee Logic

How the fee pivots around `targetFeePips` based on inventory direction.

```mermaid
flowchart TD
    A[Start: fee = targetFeePips] --> B{netBaseDelta == 0?}
    B -->|yes| Z[return targetFeePips]
    B -->|no| C{Does this swap\nINcrease exposure?}
    C -->|yes| D["fee = min(fee + inventoryFeeBumpPips, maxFeePips)\n⬆ charge more to discourage"]
    C -->|no| E["fee = max(fee − inventoryFeeDiscountPips, minFeePips)\n⬇ discount to incentivise re-balance"]
    D --> F[clamp to min/max]
    E --> F
    F --> Z2[return fee]

    G{maxUnhedgedBase exceeded\nAND exposure increasing?} -->|yes| ERR["❌ revert UnhedgedExposureTooLarge"]
    A --> G
```

---

### Step 6 · Hedge Intent Lifecycle (v1)

The complete loop from swap → keeper fill → acknowledgement.

```mermaid
stateDiagram-v2
    [*] --> Balanced : poolBaseExposure == 0

    Balanced --> Exposed : swap accumulates\npoolBaseExposure

    Exposed --> HedgeSignalled : |netDelta| ≥ hedgeThresholdBase\nemit HedgeIntent(nonce)

    HedgeSignalled --> PartiallyFilled : keeper calls recordHedgeFill()\nreportedHedgeBase increases

    PartiallyFilled --> Balanced : netDelta back < threshold\npendingHedgeBase = 0

    PartiallyFilled --> HedgeSignalled : netDelta still ≥ threshold\nnew nonce emitted

    note right of HedgeSignalled
        pendingHedgeBase = -netDelta
        hedgeNonce++
        Keeper reads event off-chain
        and executes on a perp venue
    end note
```

---

## Part 2 — Upgrade Gap

### Step 7 · What Changed Between v1 → Production

```mermaid
graph LR
    subgraph v1 DeltaNeutralHook
        V1A["Simple bool paused"]
        V1B["reportedHedgeBase\n(keeper self-reports)"]
        V1C["No LP tracking"]
        V1D["No collateral awareness"]
        V1E["External price feed\n(manual push)"]
        V1F["Keepers + PriceUpdaters\nonly role model"]
        V1G["Hedge = fire-and-forget\nevent → keeper"]
    end

    subgraph Production ProductionDeltaNeutralHook
        PA["HealthMode enum\n(5 states)"]
        PB["IHedgeAdapter\n(on-chain adapter)"]
        PC["LP inventory accounting\n(deposited/withdrawn/fees)"]
        PD["Collateral checks\n(ratio, leverage, maxLoss)"]
        PE["Adapter snapshot\n(adapter pulls its own price)"]
        PF["Owner + StrategyManager\n+ Keepers + LiquidityManagers"]
        PG["commitHedge → pendingOrder\n→ settleHedgeOrder lifecycle"]
    end

    V1A -->|upgraded to| PA
    V1B -->|upgraded to| PB
    V1C -->|upgraded to| PC
    V1D -->|upgraded to| PD
    V1E -->|upgraded to| PE
    V1F -->|upgraded to| PF
    V1G -->|upgraded to| PG
```

---

## Part 3 — `ProductionDeltaNeutralHook` (v2)

### Step 8 · High-Level Actor Map

```mermaid
graph TD
    subgraph External Actors
        Owner["👤 Owner"]
        StratMgr["🏦 StrategyManager"]
        Keeper["🤖 Keeper"]
        LiqMgr["💧 LiquidityManager"]
        Trader["🔄 Trader"]
    end

    subgraph Uniswap v4
        PM["IPoolManager"]
    end

    subgraph ProductionDeltaNeutralHook
        Hook["ProductionDeltaNeutralHook"]
    end

    subgraph External Infrastructure
        Adapter["IHedgeAdapter\n(e.g. SynthetixV3)"]
        CollToken["ERC-20 Collateral Token"]
    end

    Owner -->|"configurePool / setHedgeAdapter / pause"| Hook
    StratMgr -->|"depositCollateral / withdrawCollateral\nrebalance / settleHedgeOrder"| Hook
    Keeper -->|"rebalance / settleHedgeOrder\nsyncHedgeSnapshot / emergencyDeRisk"| Hook
    LiqMgr -->|"addLiquidity / removeLiquidity"| PM
    Trader -->|"swap"| PM
    PM -->|"beforeSwap / afterSwap\nbeforeAddLiquidity / afterAddLiquidity\nbeforeRemoveLiquidity / afterRemoveLiquidity"| Hook
    Hook -->|"commitHedge / settleHedge\ngetSnapshot / depositCollateral"| Adapter
    Hook -->|"transferFrom / approve"| CollToken
```

---

### Step 9 · Extended Data Model

New fields added on top of v1's config + risk state.

```mermaid
classDiagram
    class PoolConfig {
        +bool configured
        +bool baseIsCurrency0
        +uint24 minFeePips / targetFeePips / maxFeePips
        +uint24 inventoryFeeBumpPips / inventoryFeeDiscountPips
        +uint256 hedgeThresholdBase
        +uint256 maxResidualDeltaBase  ⬅ NEW
        +uint256 maxPendingOrderAge    ⬅ NEW
        +uint256 maxSnapshotAge        ⬅ NEW
        +uint256 minCollateralUsd      ⬅ NEW
        +uint256 minCollateralRatioBps ⬅ NEW
        +uint256 maxLeverageBps        ⬅ NEW
        +uint256 maxLossBps            ⬅ NEW
    }

    class StrategyRiskState {
        +int256 poolBaseExposure
        +int256 hedgePositionBase      ⬅ replaces reportedHedgeBase
        +int256 targetHedgeBase        ⬅ NEW
        +int256 pendingOrderBase       ⬅ NEW
        +int256 netBaseDelta           ⬅ NEW (cached)
        +int256 realizedPnlUsd         ⬅ NEW
        +int256 unrealizedPnlUsd       ⬅ NEW
        +uint256 collateralUsd         ⬅ NEW
        +uint256 initialCollateralUsd  ⬅ NEW
        +uint256 lastMarkPrice         ⬅ NEW
        +uint256 lastSnapshotTimestamp ⬅ NEW
        +uint256 pendingOrderReadyAt   ⬅ NEW
        +uint256 lastRebalanceTimestamp⬅ NEW
        +uint256 lpBaseDeposited       ⬅ NEW
        +uint256 lpBaseWithdrawn       ⬅ NEW
        +uint256 lpBaseFeesAccrued     ⬅ NEW
        +bytes32 pendingOrderId        ⬅ NEW
        +bool adapterHealthy           ⬅ NEW
        +HealthMode healthMode         ⬅ NEW
    }

    PoolConfig "1" --> "1" StrategyRiskState : keyed by PoolId
```

---

### Step 10 · Hook Permissions

All six swap + liquidity callbacks are now active.

```mermaid
graph LR
    subgraph Hook Callbacks ["Hook Callbacks — Active = ✅  Inactive = ❌"]
        BI["✅ beforeInitialize\n(enforce dynamic fee)"]
        AI["❌ afterInitialize"]
        BAL["✅ beforeAddLiquidity\n(gate: onlyLiquidityManager)"]
        AAL["✅ afterAddLiquidity\n(_accountLiquidityDelta)"]
        BRL["✅ beforeRemoveLiquidity\n(gate: onlyLiquidityManager)"]
        ARL["✅ afterRemoveLiquidity\n(_accountLiquidityDelta)"]
        BS["✅ beforeSwap\n(_applyHealth + compute fee)"]
        AS["✅ afterSwap\n(track exposure + requestRebalance)"]
        BD["❌ beforeDonate"]
        AD["❌ afterDonate"]
    end
```

---

### Step 11 · HealthMode State Machine

The core upgrade: a five-state finite state machine that governs the pool's behaviour.

```mermaid
stateDiagram-v2
    [*] --> Healthy : configurePool()

    Healthy --> NeedsRebalance : |netBaseDelta| > maxResidualDeltaBase\n(after swap or liquidity change)

    NeedsRebalance --> PendingOrder : keeper / manager calls rebalance()\ncommitHedge → orderId saved

    PendingOrder --> Healthy : settleHedgeOrder() succeeds\nnetBaseDelta back within threshold

    PendingOrder --> Defensive : order is stale > maxPendingOrderAge\nOR adapter unhealthy snapshot

    Healthy --> Defensive : adapterHealthy = false\nOR snapshot stale\nOR collateral below ratio\nOR maxLoss exceeded

    NeedsRebalance --> Defensive : same health failures

    Defensive --> Healthy : _applyHealth() re-evaluated\nall conditions pass again

    Healthy --> Paused : setPoolPaused(true)
    NeedsRebalance --> Paused : setPoolPaused(true)
    Defensive --> Paused : setPoolPaused(true)

    Paused --> Healthy : setPoolPaused(false)

    note right of Defensive
        Blocks exposure-increasing swaps
        Allows emergency de-risk
    end note
```

---

### Step 12 · Swap Flow (Production)

Extended with health checks, LP inventory sync, and on-chain rebalance signalling.

```mermaid
sequenceDiagram
    participant Trader
    participant PoolManager
    participant Hook as ProductionDeltaNeutralHook
    participant Adapter as IHedgeAdapter

    Trader->>PoolManager: swap(...)
    PoolManager->>Hook: beforeSwap(key, params)
    Note over Hook: _applyHealth(config, state)<br/>• re-evaluate HealthMode from adapter snapshot<br/>_computeFee()<br/>• Paused → revert<br/>• Defensive + exposure-increasing → revert<br/>• stale pending order + exposure-increasing → revert<br/>• else bias fee ±pips
    Hook-->>PoolManager: (selector, ZERO_DELTA, feePips | OVERRIDE_FEE_FLAG)

    PoolManager->>Hook: afterSwap(key, delta)
    Note over Hook: state.poolBaseExposure -= baseCallerDelta<br/>_syncDelta() → netBaseDelta = poolBaseExposure + hedgePositionBase<br/>_requestRebalanceIfNeeded()
    alt |netBaseDelta| ≥ hedgeThresholdBase AND no pending order
        Hook-->>Hook: state.healthMode = NeedsRebalance\nemit RebalanceNeeded(...)
    end
    Hook-->>PoolManager: (selector, 0)
```

---

### Step 13 · LP Inventory Accounting

New in Production — the hook tracks every base-token unit that enters or leaves via liquidity.

```mermaid
sequenceDiagram
    participant LiqMgr as LiquidityManager
    participant PoolManager
    participant Hook as ProductionDeltaNeutralHook

    LiqMgr->>PoolManager: addLiquidity(...)
    PoolManager->>Hook: beforeAddLiquidity(sender, ...)
    Note over Hook: guard: sender must be LiquidityManager
    Hook-->>PoolManager: selector

    PoolManager->>Hook: afterAddLiquidity(sender, key, delta, feesAccrued, ...)
    Note over Hook: principalBaseDelta = baseAmount(delta) - baseAmount(feesAccrued)<br/>lpBaseDeposited += |principalBaseDelta|<br/>poolBaseExposure += deposited<br/>lpBaseFeesAccrued += fees<br/>poolBaseExposure += fees<br/>_syncDelta() → netBaseDelta<br/>_requestRebalanceIfNeeded()
    Hook-->>PoolManager: (selector, ZERO_DELTA)

    Note right of Hook: Mirror path exists for<br/>beforeRemoveLiquidity / afterRemoveLiquidity<br/>lpBaseWithdrawn += withdrawn<br/>poolBaseExposure -= withdrawn
```

---

### Step 14 · On-Chain Hedge Order Lifecycle

The full round-trip from rebalance signal through to settled hedge position.

```mermaid
sequenceDiagram
    participant Keeper
    participant Hook as ProductionDeltaNeutralHook
    participant Adapter as IHedgeAdapter

    Note over Hook: HealthMode = NeedsRebalance
    Keeper->>Hook: rebalance(key, acceptablePrice)
    Note over Hook: _refreshSnapshot() → pull latest adapter data<br/>_applyHealth()<br/>_requiredHedgeDelta() → hedgeDeltaBase = -netBaseDelta<br/>_requireHealthyCollateral()<br/>• collateralUsd ≥ required (ratio + leverage + minUsd)<br/>• PnL not beyond maxLossBps
    Hook->>Adapter: commitHedge(poolId, hedgeDeltaBase, acceptablePrice)
    Adapter-->>Hook: orderId
    Note over Hook: state.pendingOrderId = orderId<br/>state.pendingOrderBase = hedgeDeltaBase<br/>state.healthMode = PendingOrder\nemit HedgeOrderCommitted(orderId, hedgeDeltaBase)

    Note over Hook: HealthMode = PendingOrder
    Keeper->>Hook: settleHedgeOrder(key)
    Hook->>Adapter: getSnapshot(poolId)
    Adapter-->>Hook: beforeSnapshot (pendingOrderId must match)
    Hook->>Adapter: settleHedge(poolId, orderId)
    Adapter-->>Hook: HedgeSnapshot { positionBase, realizedPnl, ... }
    Note over Hook: _applySnapshot()<br/>hedgePositionBase = snapshot.positionBase<br/>realizedPnlUsd / unrealizedPnlUsd updated<br/>collateralUsd updated<br/>pendingOrderId / pendingOrderBase cleared<br/>_applyHealth() → likely Healthy
    Hook-->>Keeper: emit HedgeOrderSettled(orderId, hedgePositionBase, netBaseDelta)
```

---

### Step 15 · Collateral & Risk Guard System

The multi-layer safety net introduced in Production.

```mermaid
flowchart TD
    A[rebalance() called] --> B[_refreshSnapshot from Adapter]
    B --> C{adapterHealthy?}
    C -->|no| ERR1["❌ revert HedgeAdapterUnhealthy"]
    C -->|yes| D{snapshot stale?\nblock.timestamp > lastSnapshotTimestamp\n+ maxSnapshotAge}
    D -->|yes| ERR1
    D -->|no| E[_requiredCollateralUsd]

    E --> F["projectedExposure = |hedgePosition + delta|"]
    F --> G["notionalUsd = projectedExposure × lastMarkPrice / 1e18"]
    G --> H["ratioRequired = notionalUsd × minCollateralRatioBps / 10000\nleverageRequired = notionalUsd × 10000 / maxLeverageBps\nrequiredUsd = max(minCollateralUsd, ratioRequired, leverageRequired)"]
    H --> I{collateralUsd ≥ requiredUsd?}
    I -->|no| ERR2["❌ revert InsufficientCollateral"]
    I -->|yes| J[_checkMaxLoss]
    J --> K{"PnL < -(initialCollateral × maxLossBps / 10000)?"}
    K -->|yes| ERR3["❌ revert MaxLossExceeded"]
    K -->|no| OK["✅ proceed to commitHedge"]
```

---

### Step 16 · Emergency De-Risk

A bypass path for when the position needs to be closed immediately regardless of normal flow.

```mermaid
flowchart TD
    A["emergencyDeRisk(key, acceptablePrice)"] --> B{pendingOrderId != 0?}
    B -->|yes| ERR["❌ revert PendingOrderExists"]
    B -->|no| C["hedgeDeltaBase = -state.hedgePositionBase\n(full close)"]
    C --> D{hedgeDeltaBase == 0?}
    D -->|yes| ERR2["❌ revert NoRebalanceNeeded"]
    D -->|no| E["adapter.commitHedge(poolId, hedgeDeltaBase, acceptablePrice)"]
    E --> F["state.targetHedgeBase = 0\nstate.healthMode = Defensive\nemit EmergencyDeRiskRequested"]
    F --> G["→ Keeper calls settleHedgeOrder()\nto finalise the close"]
```

---

## Summary — v1 vs Production Side-by-Side

```mermaid
graph TB
    subgraph DeltaNeutralHook["DeltaNeutralHook (v1)"]
        direction TB
        A1["Fee Policy\n• targetFeePips ± inventory bias\n• requires external price push"]
        A2["Exposure Tracking\n• poolBaseExposure (swap only)\n• reportedHedgeBase (keeper reported)"]
        A3["Hedge Mechanism\n• emit HedgeIntent event\n• keeper executes off-chain\n• keeper calls recordHedgeFill"]
        A4["Health\n• single bool paused"]
        A5["LP Tracking\n• none — hook ignores liquidity"]
        A6["Collateral\n• none"]
    end

    subgraph ProductionDeltaNeutralHook["ProductionDeltaNeutralHook (Production)"]
        direction TB
        B1["Fee Policy\n• same bias + HealthMode gate\n• price from adapter snapshot"]
        B2["Exposure Tracking\n• poolBaseExposure (swap + LP in/out + fees)\n• hedgePositionBase (from adapter)"]
        B3["Hedge Mechanism\n• rebalance() → commitHedge on-chain\n• settleHedgeOrder() confirms fill\n• emergencyDeRisk() for full close"]
        B4["Health\n• HealthMode 5-state FSM\n• auto-transitions on every swap / LP op"]
        B5["LP Tracking\n• lpBaseDeposited / Withdrawn / FeesAccrued\n• gated by LiquidityManager role"]
        B6["Collateral\n• deposit / withdraw via adapter\n• ratio + leverage + maxLoss checks"]
    end

    A1 -.->|upgraded| B1
    A2 -.->|upgraded| B2
    A3 -.->|upgraded| B3
    A4 -.->|upgraded| B4
    A5 -.->|upgraded| B5
    A6 -.->|upgraded| B6
```
