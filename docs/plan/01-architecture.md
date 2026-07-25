# 01 — Architecture

## Two-agent split

| | **Scanner Agent** | **Executor Agent** |
| --- | --- | --- |
| Duty | Observe, score, emit panic | Act onchain |
| Secrets | API keys for Graph / Glider / 0G / Uniswap *read* | `PRIVATE_KEY` + Uniswap API key for writes |
| Process | Long-running loop / webhooks | Long-running consumer |
| Failure mode | Missed alert (bad) | False fire (worse) → gated by confirmations + dry-run |

Keeping signing keys off the scanner process limits blast radius if a monitoring dependency is compromised.

## Component diagram

```
                    ┌──────────────────────────────────────────┐
                    │              Signal sources               │
                    │  The Graph │ Glider │ Forta │ Defimon     │
                    │  Price oracles / TWAP (via Graph/API)     │
                    └───────────────┬──────────────────────────┘
                                    │ webhooks / poll / WS
                                    ▼
                    ┌──────────────────────────────────────────┐
                    │           Scanner Agent                   │
                    │  ingest → normalize → feature vector      │
                    │           │                               │
                    │           ▼                               │
                    │      0G Compute (risk score + reason)     │
                    │           │                               │
                    │           ▼                               │
                    │   Panic Policy (thresholds + N-of-M)      │
                    └───────────────┬──────────────────────────┘
                                    │ PanicEvent (signed payload optional)
                                    ▼
                    ┌──────────────────────────────────────────┐
                    │     Event bus (Redis / in-memory queue)   │
                    └───────────────┬──────────────────────────┘
                                    │
                                    ▼
                    ┌──────────────────────────────────────────┐
                    │           Executor Agent                  │
                    │  validate → plan → Uniswap API            │
                    │  1) remove / decrease liquidity           │
                    │  2) swap residuals → USDC/USDT/DAI        │
                    │  3) emit receipt + Telegram/webhook       │
                    └──────────────────────────────────────────┘
```

## Repo layout (target)

```
sentinel/
├── apps/
│   ├── scanner/          # always-on monitoring agent
│   ├── executor/         # signing / execution agent
│   └── dashboard/        # optional minimal UI for demo
├── packages/
│   ├── core/             # types, PanicEvent, policy
│   ├── graph/            # The Graph clients
│   ├── uniswap/          # Uniswap API client
│   ├── zg/               # 0G Compute client
│   └── monitors/         # Glider, Forta, Defimon adapters
├── docs/plan/            # this plan
├── .env.example
├── README.md
└── FEEDBACK.md
```

## PanicEvent (contract between agents)

```ts
type PanicEvent = {
  id: string;
  ts: number;
  severity: "low" | "medium" | "high" | "critical";
  reasons: Array<{
    source: "glider" | "graph" | "forta" | "defimon" | "price" | "zg";
    signal: string;
    evidence: Record<string, unknown>;
  }>;
  positions: Array<{
    chainId: number;
    pool?: string;
    positionId?: string;
    tokens: string[];
  }>;
  targetStables: ("USDC" | "USDT" | "DAI")[];
  mode: "dry_run" | "live";
  zgScore?: number;       // 0–1
  zgRationale?: string;
};
```

## Deployment topology (hackathon)

- Two Node.js processes on one machine (or two terminals).
- Shared Redis optional; start with an in-process HTTP/webhook + file/JSON queue if Redis is heavy.
- Single chain first (Ethereum mainnet or Uniswap-supported testnet used for demo).

## Trust boundaries

1. Scanner may be noisy; Executor **must** re-check `EXECUTION_MODE`, position allowlist, and confirmation count.
2. Uniswap quotes re-fetched at execution time (do not trust scanner-cached routes).
3. Alerts outbound only (Telegram/webhook); no inbound “execute now” without auth token.
