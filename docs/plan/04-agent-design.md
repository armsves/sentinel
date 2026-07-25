# 04 — Agent design

## Scanner Agent (`AGENT_ROLE=scanner`)

### Loop

1. **Ingest** — webhooks (Glider) + poll (Graph, Forta) + optional WS (Defimon).
2. **Normalize** — map to `NormalizedSignal`.
3. **Enrich** — pull latest pool/token snapshot from The Graph for watched set.
4. **Score** — call 0G Compute with compact context + local heuristics.
5. **Decide** — Panic Policy (`packages/core`).
6. **Emit** — enqueue `PanicEvent` if panic; else heartbeat log.

### Local heuristics (always on, even if 0G blips)

- `priceDropPct >= PRICE_DROP_THRESHOLD_PCT`
- `stableDeviationBps >= DEPEG_THRESHOLD_BPS`
- `poolTvlDropPct` over `N` minutes above threshold
- Security feed severity `high|critical` matching allowlisted addresses

### 0G prompt sketch

System: You are Sentinel risk brain. Return JSON only. Prefer precision over recall when evidence is weak.

User payload: watched positions, last signals (≤20), thresholds, recent pool stats.

Output schema: `score`, `shouldPanic`, `severity`, `rationale`, `whichSourcesMatter`.

## Executor Agent (`AGENT_ROLE=executor`)

### Loop

1. Dequeue `PanicEvent`.
2. **Validate**: signature/shared secret, allowlisted positions, `mode`, confirmation count, freshness (`ts` not stale).
3. If `dry_run`: simulate plan (quotes only), log, alert, **do not sign**.
4. If `live`:
   - Snapshot balances / positions.
   - Uniswap API: remove/decrease liquidity for each position.
   - For each non-stable balance: quote + swap to best available of `SAFE_ASSETS`.
   - Prefer USDC; fall back USDT → DAI if liquidity/route fails.
5. Persist receipt; notify Telegram/webhook.

### Key handling (MVP)

- `PRIVATE_KEY` only loaded in executor process.
- Never log the key; redact in errors.
- Post-hackathon upgrade path: Safe module / session key / turnkey — documented in README, not built this weekend unless spare time.

## Panic Policy

```
panic = (
  count(distinct sources with severity >= high) >= PANIC_CONFIRMATIONS
  OR (zg.shouldPanic AND zg.score >= 0.8 AND ≥1 hard heuristic fired)
)
```

Critical Glider “live exploitation” may be configured as **single-source override** via env flag `ALLOW_SINGLE_SOURCE_CRITICAL=true` (default false for safety).

## Concurrency & idempotency

- PanicEvent `id` is idempotent key; executor ignores duplicates.
- Cooldown per position (e.g. 15 min) after an exit attempt.
- Partial failure: retry swaps independently; never re-enter LP automatically.
