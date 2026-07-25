# Sentinel

**Panic-button liquidity guardian for DeFi.**

Sentinel is an always-on agent system that watches your Uniswap positions for exploits, hacks, token depegs, and sharp price drops — then automatically exits liquidity and converts proceeds into secure stables (USDC / USDT / DAI).

Built for [ETHGlobal Lisbon 2026](https://ethglobal.com/) with:

| Partner | Role |
| --- | --- |
| [Uniswap API](https://developers.uniswap.org/docs) | Routing, swaps, LP exit / trade execution |
| [The Graph](https://thegraph.com/blog/hackathon-resources/) | Live token & pool monitoring via Subgraphs / Substreams / MCP |
| [0G Compute](https://docs.0g.ai/) | Decentralized AI inference for threat scoring & decisioning |
| [Hexens Glider Monitor](https://hexens.io/solutions/glider-monitor) | Continuous threat exposure (prevent / react / dependency risk) |

## How it works

```
┌─────────────────────┐         panic signal          ┌─────────────────────┐
│  Scanner Agent      │  ───────────────────────────► │  Executor Agent     │
│  (always-on)        │         (queue / IPC)         │  (hot wallet)       │
│                     │                               │                     │
│  • The Graph pools  │                               │  • Uniswap API      │
│  • Glider / Forta   │                               │  • Remove liquidity │
│  • Price / depeg    │                               │  • Swap → stables   │
│  • 0G risk scoring  │                               │  • Confirm + alert  │
└─────────────────────┘                               └─────────────────────┘
```

1. **Scanner** continuously ingests pool/token data (The Graph), security alerts (Glider + optional feeds), and price signals.
2. **0G Compute** scores whether the situation warrants a panic exit (threshold + multi-source confirmation).
3. **Executor** (separate process) holds the wallet key and, on confirmed panic, uses the **Uniswap API** to exit LP and route to stables.

> Hackathon MVP: private key in `.env` on the executor only. Scanner never holds signing keys.

## Plan docs

Full design lives in [`docs/plan/`](./docs/plan/):

| Doc | Contents |
| --- | --- |
| [00 — Overview](./docs/plan/00-overview.md) | Problem, goals, non-goals |
| [01 — Architecture](./docs/plan/01-architecture.md) | Two-agent system, data flow |
| [02 — Stack integrations](./docs/plan/02-stack-integrations.md) | Uniswap / Graph / 0G wiring |
| [03 — Monitors](./docs/plan/03-monitors.md) | Glider + alternative monitors |
| [04 — Agent design](./docs/plan/04-agent-design.md) | Roles, signals, panic policy |
| [05 — Execution flow](./docs/plan/05-execution-flow.md) | Exit LP → swap → stables |
| [06 — Roadmap](./docs/plan/06-roadmap.md) | Phased hackathon delivery |

Feedback & sponsor notes: [`FEEDBACK.md`](./FEEDBACK.md)

## Quick start (planned)

```bash
cp .env.example .env
# fill UNISWAP_API_KEY, GRAPH_*, ZG_*, PRIVATE_KEY, WATCHED_*

pnpm install

# Terminal 1 — risk scanner (no keys)
pnpm agent:scanner

# Terminal 2 — execution agent (signing wallet)
pnpm agent:executor
```

## Status

**Planning / scaffolding.** Repo currently contains the product plan, README, and feedback template. Implementation follows the roadmap in `docs/plan/06-roadmap.md`.

## License

MIT (intended)
