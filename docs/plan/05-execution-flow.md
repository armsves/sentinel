# 05 — Execution flow

## Happy path (live)

```
PanicEvent received
        │
        ▼
Validate allowlist + mode + freshness
        │
        ▼
For each watched position:
        │
        ├─► Uniswap API: fetch position / liquidity state
        ├─► Uniswap API: decrease/remove liquidity → token0 + token1 in wallet
        └─► Collect ERC20 balances for those tokens
        │
        ▼
For each non-stable token balance > dust:
        │
        ├─► Uniswap API: quote token → USDC
        ├─► If route poor / fails → try USDT → DAI
        └─► Execute swap with panic slippage settings
        │
        ▼
Assert majority of value now in SAFE_ASSETS
        │
        ▼
Emit success receipt + alert
```

## Dry-run path

Identical until signing: return planned calls, quotes, estimated outbound amounts, and “would send” calldata summary.

## Slippage & MEV posture

During panic, **survival > price**:

- Higher slippage tolerance than normal trading bots.
- Short deadline.
- Optional private relay later (not MVP).

## Failure modes

| Failure | Response |
| --- | --- |
| Remove liquidity reverts | Alert; do not attempt unrelated swaps blindly |
| Swap route missing | Try next stable; else hold token + alert |
| RPC down | Retry with backoff; alert |
| Uniswap API 429 | Exponential backoff; surface in demo logs |
| Partial exit | Mark position `partial`; cooldown; manual follow-up |

## Accounting

Executor writes a simple JSONL receipt:

```json
{
  "panicId": "...",
  "txHashes": ["0x..."],
  "before": { "positions": [], "balances": {} },
  "after": { "balances": { "USDC": "..." } },
  "mode": "live"
}
```

## Demo injection

Provide `pnpm panic:simulate --scenario=depeg` that publishes a synthetic PanicEvent so judges can see the full path without waiting for a real hack.
