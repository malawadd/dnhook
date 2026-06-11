# Delta Neutral Live Arena

Local-only dashboard and orchestration service for the Base Sepolia production hook demo.

```bash
cd contracts/delta-neutral-hook/live-demo
npm install
npm run dev
```

The server reads `../.env` and uses `BASE_SEPOLIA_RPC_URL` plus `PRIVATE_KEY`. Trader wallets are generated into `live-demo/.demo-state/traders.json`, which is ignored by git.

Default live settings:

```text
LIVE_TRADER_COUNT=10
LIVE_TRADER_FUNDING_ETH=0.05
LIVE_SWAP_INTERVAL_MS=4000
LIVE_KEEPER_INTERVAL_MS=8000
LIVE_MAX_TX_PER_MIN=30
LIVE_MAX_RUNTIME_MINUTES=20
```

Use the dashboard buttons to prepare wallets, fund them, start swaps, start the keeper loop, trigger defensive mode, recover, and stop all loops.
