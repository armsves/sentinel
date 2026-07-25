# 06 — Roadmap (ETHGlobal Lisbon weekend)

## Phase 0 — Plan & repo (done when this lands)

- [x] Product plan docs under `docs/plan/`
- [x] README + FEEDBACK.md + `.env.example`
- [ ] GitHub repo `armsves/sentinel` with plan pushed

## Phase 1 — Skeleton (half day)

- Monorepo (`pnpm` workspaces): `apps/scanner`, `apps/executor`, `packages/core`
- Shared types: `NormalizedSignal`, `PanicEvent`
- In-memory / Redis queue + HTTP webhook receiver
- Logging + `EXECUTION_MODE=dry_run` default

## Phase 2 — Data plane (Graph + prices)

- Uniswap subgraph queries for watched pools/positions
- Price drop + depeg detectors
- Heartbeat metrics (last block, last signal)

## Phase 3 — Security plane (Glider + one backup)

- Glider webhook adapter
- Forta poll **or** Defimon WS (pick whichever enrolls faster)
- Normalization + allowlist matching

## Phase 4 — Intelligence (0G)

- Router client OpenAI-compatible
- Structured JSON scoring wired into Panic Policy
- Persist rationale on PanicEvent for demo storytelling

## Phase 5 — Execution (Uniswap API)

- API key client: quote, swap, LP decrease/remove
- Executor validation + idempotency
- Dry-run demo path end-to-end
- Live path on testnet or small mainnet amount

## Phase 6 — Demo polish

- Minimal dashboard or rich CLI logs
- `panic:simulate` scenarios: exploit, depeg, crash
- Fill FEEDBACK.md sponsor checkboxes
- 3-minute pitch script

## Stretch (only if core demo works)

- Messari standardized subgraphs cross-protocol
- Substreams SKILL one-prompt pipeline
- Tokenized stocks watchlist via Uniswap API
- Safe / session-key upgrade sketch
- Dashboard with live signal timeline

## Ownership split (suggested)

| Track | Focus |
| --- | --- |
| A | Graph + price/depeg heuristics |
| B | Glider/Forta adapters + policy |
| C | Uniswap executor + receipts |
| Shared | 0G scoring prompt + demo |

## Definition of done (submit)

1. README explains architecture in <1 screen.
2. Scanner runs continuously and shows live Graph + at least one security feed.
3. Synthetic panic triggers Executor dry-run via Uniswap API quotes/plan.
4. Optional live tiny exit recorded on explorer.
5. FEEDBACK.md checkboxes updated for Uniswap, Graph, 0G, Glider.
