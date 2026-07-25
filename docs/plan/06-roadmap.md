# 06 — Roadmap (ETHGlobal Lisbon weekend)

## Phase 0 — Plan & repo

- [x] Product plan docs under `docs/plan/`
- [x] README + FEEDBACK.md + `.env.example`
- [x] GitHub repo `armsves/sentinel` with plan pushed

## Phase 1 — Skeleton + Uniswap skills

- [x] Monorepo (`pnpm` workspaces): `apps/scanner`, `apps/executor`, `packages/*`
- [x] Install Uniswap AI skills: `swap-integration`, `lp-integration`, `viem-integration`
- [x] Shared types + config + viem wallet helpers
- [x] `EXECUTION_MODE=dry_run` default

## Phase 2 — Uniswap execution (current)

- [x] Trading API: quote → approval → swap
- [x] LP API: create (deposit), decrease (withdraw), pool_info
- [x] Position check via NPM `positions` / `tokenOfOwnerByIndex`
- [x] Executor CLI: `swap | deposit | withdraw | positions | pool-info`

## Phase 3 — Graph data plane (current)

- [x] Poll portfolio ERC-20 balances + subgraph token meta
- [x] Poll Uniswap v3 pools for watched tokens / watched pool IDs
- [x] Health heuristics: min TVL, day-over-day TVL drop, zero liquidity, stable-stable depeg
- [x] Scanner loop emits unhealthy signals

## Phase 4 — Security plane

- [x] X / Blockaid monitor (`@sentinel/monitors`) + fixture
- [x] Scanner fuses Graph pool health + X exploit signals
- [ ] Glider webhook adapter
- [ ] Forta poll **or** Defimon WS
- [ ] Panic confirmations + queue to executor

## Phase 5 — Intelligence (0G)

- [ ] Router client OpenAI-compatible
- [ ] Structured JSON scoring wired into Panic Policy

## Phase 6 — Panic orchestration

- [x] Queue PanicEvent scanner → executor (`data/panic-queue.json`)
- [x] Panic worker: withdraw LP + swap residuals → SAFE_ASSETS (dry_run default)
- [ ] Optional live tiny exit on funded wallet

## Phase 7 — Demo polish

- [x] Minimal control dashboard (`apps/dashboard` + `apps/api`)
- [ ] `panic:simulate` CLI alias (API already has `/api/panic/simulate`)
- [ ] Fill FEEDBACK.md sponsor checkboxes

## Definition of done (this slice)

1. Uniswap skills installed in-repo.
2. CLI can dry-run swap / deposit / withdraw and read positions.
3. Scanner polls The Graph for portfolio tokens + pool health on an interval.
