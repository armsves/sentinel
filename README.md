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

# Terminal A — poll portfolio tokens + Uniswap pool health
pnpm scanner

# Terminal B — Uniswap actions (default EXECUTION_MODE=dry_run)
pnpm cli positions
pnpm cli pool-info --tokenA 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 --tokenB 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 --fee 3000
pnpm cli swap --tokenIn 0x... --tokenOut 0x... --amount 0.01 --decimals 18
pnpm cli deposit --pool 0x... --token0 0x... --token1 0x... --amountToken 0x... --amount 1 --decimals 6
pnpm cli withdraw --nft 123 --token0 0x... --token1 0x... --pct 100
```

Set `EXECUTION_MODE=live` only when you intend to broadcast.

## Repo layout

```
apps/scanner     Graph portfolio + pool health loop
apps/executor    CLI for Uniswap swap / LP
packages/core    config, wallet (viem), types
packages/uniswap Trading API + LP API clients
packages/graph   The Graph queries
docs/plan        product plan
.agents/skills   Uniswap AI skills
```

## Plan

Plan docs: [`docs/plan/`](./docs/plan/) (see especially [07 — current slice](./docs/plan/07-current-slice.md)). Sponsor notes: [`FEEDBACK.md`](./FEEDBACK.md).

## License

MIT
