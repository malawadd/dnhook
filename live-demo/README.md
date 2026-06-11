# Delta Neutral Live Arena

Local-only dashboard and orchestration service for the Base Sepolia production hook demo.

```bash
cd contracts/delta-neutral-hook/live-demo
npm install
npm run dev
```

The server reads `../.env` and uses `BASE_SEPOLIA_RPC_URL` plus `PRIVATE_KEY`. Trader wallets are generated into `live-demo/.demo-state/traders.json`, which is ignored by git.

Reads can use multiple RPCs through `BASE_SEPOLIA_RPC_URLS`; writes stay on one RPC through `BASE_SEPOLIA_WRITE_RPC_URL`, falling back to `BASE_SEPOLIA_RPC_URL` or the first read URL. Keeping writes on one provider prevents nonce divergence while the dashboard still gets resilient reads. The price chart uses chunked `eth_getLogs` requests so Alchemy free-tier endpoints work with `LIVE_GET_LOGS_BLOCK_SPAN=10`.

Default live settings:

```text
LIVE_TRADER_COUNT=10
LIVE_TRADER_FUNDING_ETH=0.05
LIVE_REPLACEMENT_FEE_BUMP_BPS=2500
LIVE_NONCE_CONFIRM_TIMEOUT_MS=120000
LIVE_ALLOW_WALLET_ROTATION=false
LIVE_SWAP_INTERVAL_MS=4000
LIVE_KEEPER_INTERVAL_MS=8000
LIVE_MAX_TX_PER_MIN=30
LIVE_MAX_RUNTIME_MINUTES=20
LIVE_GET_LOGS_BLOCK_SPAN=10
LIVE_PRICE_BACKFILL_BLOCKS=40
```

Recommended Base Sepolia RPC options for the local demo:

- Base official: `https://sepolia.base.org`
- PublicNode: `https://base-sepolia-rpc.publicnode.com`
- Coinbase CDP Node for higher free request throughput
- QuickNode can work, but its free trial may use stricter `eth_getLogs` block ranges

Use the dashboard buttons to prepare wallets, fund them, start swaps, start the keeper loop, trigger defensive mode, recover, and stop all loops.

Nonce guidance:

- Do not run two live-demo API servers against the same `.demo-state/traders.json`.
- If one trader has a pending nonce gap, the arena pauses that trader and keeps the rest of the fleet available.
- The transaction coordinator serializes each sender, uses pending nonces, waits for receipts, and retries one underpriced replacement with `LIVE_REPLACEMENT_FEE_BUMP_BPS`.
- Use `Refresh nonces` to inspect stuck wallets. If a wallet stays stuck, wait for the pending tx to clear or set `LIVE_ALLOW_WALLET_ROTATION=true` and use `Rotate wallets`; the old trader file is archived instead of deleted.
- PublicNode or Coinbase CDP can be used as `BASE_SEPOLIA_WRITE_RPC_URL` if an Alchemy mempool gets sticky.
