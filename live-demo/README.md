# Delta Neutral Live Arena

Local-only dashboard and orchestration service for the Base Sepolia production hook demo.

```bash
cd contracts/delta-neutral-hook/live-demo
npm install
npm run dev
```

Fork showcase:

```bash
cd contracts/delta-neutral-hook/live-demo
npm run dev:fork
```

Open the dashboard, arm live transaction controls, then click `Start Fork Showcase`. The server prepares fork trader wallets, tops up local Anvil balances, starts swaps and keeper ticks, injects hedge PnL/collateral shocks through the demo adapter, demonstrates defensive mode, recovers, and repeats until `Stop Showcase`.

The server reads `../.env` and uses `BASE_SEPOLIA_RPC_URL` plus `PRIVATE_KEY`. Trader wallets are generated into `live-demo/.demo-state/traders.json`, which is ignored by git.

Reads can use multiple RPCs through `BASE_SEPOLIA_RPC_URLS`. Deployer, funding, keeper, and scenario writes stay on `BASE_SEPOLIA_WRITE_RPC_URL`; trader writes are sharded across HTTPS endpoints from `BASE_SEPOLIA_WRITE_RPC_URLS`. The price chart uses chunked `eth_getLogs` requests so Alchemy free-tier endpoints work with `LIVE_GET_LOGS_BLOCK_SPAN=10`.

Default live settings:

```text
LIVE_TRADER_COUNT=10
LIVE_TRADER_FUNDING_ETH=0.05
LIVE_REPLACEMENT_FEE_BUMP_BPS=2500
LIVE_NONCE_CONFIRM_TIMEOUT_MS=120000
LIVE_ALLOW_WALLET_ROTATION=false
LIVE_RPC_COOLDOWN_MS=30000
LIVE_RPC_RETRY_ATTEMPTS=2
LIVE_TRADER_BALANCE_REFRESH_MS=15000
LIVE_SWAP_INTERVAL_MS=4000
LIVE_KEEPER_INTERVAL_MS=8000
LIVE_MAX_TX_PER_MIN=30
LIVE_MAX_RUNTIME_MINUTES=20
LIVE_GET_LOGS_BLOCK_SPAN=10
LIVE_PRICE_BACKFILL_BLOCKS=40
LIVE_MODE=base-sepolia
LIVE_FORK_RPC_URL=http://127.0.0.1:8545
LIVE_FORK_TRADER_COUNT=5
LIVE_FORK_TRADER_FUNDING_ETH=0.02
LIVE_FORK_BACKOFF_MS=3000
LIVE_FORK_MAX_CONSECUTIVE_ERRORS=5
LIVE_SHOWCASE_EXPOSURE_TARGET_BASE=1
LIVE_SHOWCASE_NET_DELTA_TARGET_BASE=0.1
LIVE_SHOWCASE_MARK_PRICE_START=2000
LIVE_SHOWCASE_MARK_PRICE_STEP=100
LIVE_SHOWCASE_REALIZED_LOSS_USD=5000
LIVE_SHOWCASE_UNREALIZED_LOSS_USD=2500
LIVE_SHOWCASE_LOW_COLLATERAL_USD=500
LIVE_SHOWCASE_PHASE_DELAY_MS=5000
```

Recommended Base Sepolia RPC options for the local demo:

- Base official: `https://sepolia.base.org`
- PublicNode: `https://base-sepolia-rpc.publicnode.com`
- Coinbase CDP Node for higher free request throughput
- QuickNode can work, but its free trial may use stricter `eth_getLogs` block ranges
- Extra HTTPS trader write pool candidates: `https://base-sepolia.gateway.tenderly.co`, `https://base-sepolia.rpc.sentio.xyz`, `https://base-sepolia.api.onfinality.io/public`, `https://base-sepolia-public.nodies.app`
- WSS endpoints are useful for future event streaming, but this live arena only uses HTTPS endpoints for transaction writes.

Use the dashboard buttons to prepare wallets, fund them, start swaps, start the keeper loop, trigger defensive mode, recover, and stop all loops.

Nonce guidance:

- Do not run two live-demo API servers against the same `.demo-state/traders.json`.
- If one trader has a pending nonce gap, the arena pauses that trader and keeps the rest of the fleet available.
- The transaction coordinator serializes each sender, uses pending nonces, waits for receipts, and retries one underpriced replacement with `LIVE_REPLACEMENT_FEE_BUMP_BPS`.
- Trader wallets are assigned to stable RPCs from `BASE_SEPOLIA_WRITE_RPC_URLS`; rate-limited providers cool down for `LIVE_RPC_COOLDOWN_MS` while the affected trader retries another endpoint.
- Trader balances are cached for `LIVE_TRADER_BALANCE_REFRESH_MS` so snapshot polling does not overwhelm public RPCs during active swaps.
- Use `Refresh nonces` to inspect stuck wallets. If a wallet stays stuck, wait for the pending tx to clear or set `LIVE_ALLOW_WALLET_ROTATION=true` and use `Rotate wallets`; the old trader file is archived instead of deleted.
- PublicNode or Coinbase CDP can be used as `BASE_SEPOLIA_WRITE_RPC_URL` if an Alchemy mempool gets sticky.
- Fork mode uses `.demo-state/fork-traders.json`, forces all read/write RPCs to the local Anvil fork, and uses `LIVE_FORK_TRADER_FUNDING_ETH` instead of the live `LIVE_TRADER_FUNDING_ETH` setting.
