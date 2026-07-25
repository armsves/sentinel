# FEEDBACK.md — ETHGlobal Lisbon 2026

Living notes for mentors, sponsors, and judges. Update during the hackathon as integrations land.

## Project one-liner

Sentinel = always-on DeFi panic button: detect exploit / depeg / crash signals → exit Uniswap LP → flight to USDC/USDT/DAI.

## Sponsor checklist

### Uniswap

- [x] Valid API key from [Uniswap Developer Platform](https://developers.uniswap.org/docs) (in `.env`)
- [x] Skills installed: `swap-integration`, `lp-integration`, `viem-integration`
- [x] Core functionality via Uniswap API: Trading API swap + LP API create/decrease + pool_info + on-chain positions
- [x] Demo path: `pnpm panic:simulate` → queue → `pnpm panic-worker` dry-runs withdraw/swap plan
- [ ] Optional stretch: tokenized stocks as watched risk assets (new Uniswap API asset class)
- [ ] Notes / blockers:

```
Need live RPC_URL + funded wallet for live txs. Default EXECUTION_MODE=dry_run.
CLI: pnpm cli swap|deposit|withdraw|positions|pool-info|panic-simulate|panic-worker
Dashboard: pnpm api && pnpm dashboard
```

### The Graph

- [x] Live blockchain data source for token/pool monitoring ([hackathon resources](https://thegraph.com/blog/hackathon-resources/))
- [x] GraphQL against Uniswap v3 Ethereum subgraph (`GRAPH_UNISWAP_SUBGRAPH`) — portfolio tokens + pool health poller in `apps/scanner`
- [ ] Optional: Substreams for high-frequency pool events; x402 pay-per-query
- [x] Track target: **Best AI Use Case of The Graph** (risk monitor / execution agent)
- [ ] Notes / blockers:

```
Set GRAPH_API_KEY. Scanner: pnpm scanner
```

### 0G Compute

- [x] Inference via [0G Compute](https://docs.0g.ai/) Router OpenAI-compatible client (`packages/zg`)
- [x] Agent uses 0G for threat scoring / panic decision narrative (heuristic fallback if no key)
- [ ] Notes / blockers:

```
Set ZG_ROUTER_API_KEY for live router scoring. Without it, heuristic fallback still attaches rationale.
```

### Hexens Glider Monitor

- [ ] Community tier enrollment at [portal.hexens.io](https://portal.hexens.io) (manual)
- [ ] Contracts / dependency graph under Glider monitoring (manual)
- [x] Webhook channel wired: `POST /hooks/glider` (+ `x-glider-secret`) and `/api/glider/simulate`
- [ ] Notes / blockers:

```
Point Glider portal webhook to public tunnel → :8787/hooks/glider
Local demo: curl -X POST localhost:8787/api/glider/simulate
```

### Extra monitors

- [x] Blockaid/X exploit scrape/parse (`X_BEARER_TOKEN` or fixture)
- [x] Optional Forta GraphQL poll (`FORTA_POLL_ENABLED=true`)

## Mentor questions

Use this section in office hours.

1. Safest MVP signing model under hackathon time (env PK vs Safe module vs session key)?
2. Best Uniswap API surface for **remove liquidity + multi-hop to stable** in one coordinated flow?
3. Which Graph subgraphs are most reliable for Uniswap v3/v4 pool TVL + price + stablecoin peg on mainnet/testnet this weekend?
4. Glider Community tier: webhook latency / payload shape for agent automation?
5. 0G Router: recommended model + latency budget for sub-30s panic decisions?

## Decisions log

| Date | Decision | Why |
| --- | --- | --- |
| 2026-07-25 | Two-process agent (scanner ≠ executor) | Isolate keys; clearer sponsor story |
| 2026-07-25 | Multi-source panic confirmations (default 2) | Cut false-positive exits |
| 2026-07-25 | Flight assets: USDC → USDT → DAI priority | Liquidity + perceived safety |
| 2026-07-25 | Primary security feed: Glider + Blockaid/X; Forta optional | Free/demo paths + machine-readable backups |
| 2026-07-25 | 0G scoring with heuristic fallback | Works offline; still tells 0G sponsor story when keyed |

## Demo script (draft)

1. `pnpm api` + `pnpm dashboard` — show mode dry_run, X fixture feed.
2. Click **Simulate Blockaid + Glider panic** (or `pnpm panic:simulate`).
3. Show panic queue item with 0G/heuristic score + rationale.
4. `pnpm panic-worker` — dry-run LP decrease + swap-to-stable plan in logs.
5. Optional: live tiny exit with `EXECUTION_MODE=live` on funded wallet.

## Risks & open issues

- False positives causing unnecessary exits (mitigate with confirmations + dry-run first).
- Uniswap API key / rate limits during demo.
- Graph subgraph freshness vs mempool-speed exploits (accept “fast response”, not “same-block firewall”).
- Hot wallet key management (MVP only; document upgrade path to Safe / session keys).
- X API bearer may be unavailable — fixture covers demo.

## Contact

GitHub: [armsves/sentinel](https://github.com/armsves/sentinel)
