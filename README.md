# Sentinel

**Panic-button liquidity guardian for DeFi.**

Always-on agent watches Uniswap positions for exploits, depegs, and pool-health failures — then exits LP and converts to stables via the Uniswap API.

## Stack (this phase)

| Piece | What it does |
| --- | --- |
| [Uniswap Trading API](https://developers.uniswap.org/docs) + LP API | `swap`, `deposit`, `withdraw`, `positions`, `pool-info` |
| [The Graph](https://thegraph.com/blog/hackathon-resources/) Uniswap v3 subgraph | Portfolio token meta + pool health polling |
| Uniswap AI skills | `swap-integration`, `lp-integration`, `viem-integration` in `.agents/skills/` |

## Quick start

```bash
cp .env.example .env
# set RPC_URL, PRIVATE_KEY or WALLET_ADDRESS, UNISWAP_API_KEY, GRAPH_API_KEY

pnpm install

# Terminal A — poll portfolio tokens + Uniswap pool health + X/Blockaid
pnpm scanner

# Terminal B — panic worker (consumes queue)
pnpm panic-worker

# Terminal C — HTTP API
pnpm api

# Terminal D — control UI (http://localhost:5173)
pnpm dashboard

# Or CLI
pnpm cli positions
pnpm cli queue
pnpm cli pool-info --tokenA 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 --tokenB 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 --fee 3000
```

Set `EXECUTION_MODE=live` only when you intend to broadcast.

## Repo layout

```
apps/scanner     Graph + X/Blockaid polling → panic queue
apps/executor    CLI + panic worker (withdraw/swap)
apps/api         HTTP API for the dashboard
apps/dashboard   Control UI
packages/core    config, wallet, panic queue
packages/uniswap Trading API + LP API clients
packages/graph   The Graph queries
packages/monitors X/Blockaid exploit parsing
docs/plan        product plan
.agents/skills   Uniswap AI skills
```

## Plan

Plan docs: [`docs/plan/`](./docs/plan/) (see especially [07 — current slice](./docs/plan/07-current-slice.md)). Sponsor notes: [`FEEDBACK.md`](./FEEDBACK.md).

## License

MIT
