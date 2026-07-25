# 07 — Current execution slice (Uniswap + Graph)

Status: **implemented in monorepo** (dry-run by default).

## Uniswap AI skills

Installed via:

```bash
npx skills add https://github.com/uniswap/uniswap-ai \
  --skill swap-integration \
  --skill lp-integration \
  --skill viem-integration \
  -a cursor -y
```

Location: `.agents/skills/{swap,lp,viem}-integration/` + `skills-lock.json`.

## Executor capabilities

| Command | API / mechanism |
| --- | --- |
| `swap` | Trading API `/check_approval` → `/quote` → `/swap` |
| `deposit` | LP API `/lp/check_approval` → `/lp/create` |
| `withdraw` | LP API `/lp/check_approval` → `/lp/decrease` |
| `positions` | On-chain NonfungiblePositionManager |
| `pool-info` | LP API `/lp/pool_info` |

Base URLs:

- Trade: `https://trade-api.gateway.uniswap.org/v1`
- LP: `https://liquidity.api.uniswap.org`

## Graph scanner

- Subgraph: Uniswap v3 Ethereum `5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV`
- Reads `PORTFOLIO_TOKENS` balances on-chain, enriches via subgraph `tokens`
- Loads pools by `WATCHED_POOLS` and/or pools touching portfolio tokens
- Flags unhealthy pools (TVL floor, TVL drop, zero liquidity, stable peg)

## Next

Wire unhealthy Graph signals + Glider into PanicEvent → auto `withdraw` + `swap` to stables.
