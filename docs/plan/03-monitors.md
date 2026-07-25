# 03 — Monitors (exploits, hacks, dependency risk)

Sentinel does **not** invent a full CTEM stack. It **subscribes** to specialist monitors and fuses them with Graph market data.

## Primary: Hexens Glider Monitor

https://hexens.io/solutions/glider-monitor  
Portal: https://portal.hexens.io

Glider is a Web3 Continuous Threat Exposure Management system covering:

| Mode | What Sentinel cares about |
| --- | --- |
| **Prevent** | New vulns replayed against your contracts → exposure alert |
| **React** | Live attacking tx / key leak style signals |
| **Monitor** | Dependency & DeFi risk graph; oracle / upstream compromise |
| **Invariants** | Custom per-block invariant breaches |

**Hackathon plan:** enroll **Community tier** (free), connect watched contracts / pools’ underlying protocols, deliver alerts to Telegram/Slack/webhook → Scanner ingest adapter.

Community limits to note: manual 0day/1day replay, delayed direct-attack monitoring, snapshot dependency risk, 1 custom invariant — enough for MVP wiring, not enterprise coverage.

## Recommended secondary monitors

Use as backup or complementary feeds. Prefer anything with **API / WebSocket / webhook** over Telegram scraping.

| Tool | Fit for Sentinel | Integration style | Notes |
| --- | --- | --- | --- |
| [**Forta**](https://docs.forta.network/) | Broad on-chain threat intel from detection bots | GraphQL API poll; paid push webhooks | Good generic exploit / anomaly coverage; public API polling works for MVP |
| [**Defimon**](https://defimon.xyz/) | Machine-readable exploit stream | WebSocket JSON (raw + LLM-confirmed) | Built for agent IR; low parsing cost |
| [**Hypernative**](https://www.hypernative.io/) | Enterprise detect + automated response | Webhooks / API (sales / trial) | Strong depeg + economic attack coverage; may be heavy for weekend |
| [**Guardrail**](https://www.guardrail.ai/monitoring/security-risk-monitoring) | Real-time exploit / oracle / flash-loan monitoring | Alerts → Discord/Slack/Telegram/PagerDuty | Request access; good “React” peer to Glider |
| [**Raksha Labs**](https://www.rakshalabs.io/) | Oracle divergence + **stablecoin depeg** focus | API / webhooks | Excellent complement for peg monitoring |
| [**Dedaub Monitoring**](https://dedaub.com/web3-security-monitoring/) | Protocol-specific custom rules | Managed / custom queries | Strong quality, slower to onboard at hackathon |
| [**OpenZeppelin Defender**](https://docs.openzeppelin.com/defender) + Forta Sentinels | Alert routing into autotasks | Defender notifications | Useful if already in OZ ecosystem |
| **Tenderly Alerts** / **OpenZeppelin Monitor** style | Tx simulation & address watches | Webhooks | DIY watch on pool + token contracts |
| **Chainlink / Pyth price deviation** (DIY) | Depeg & crash | Poll feeds + Graph | Cheap backup if third-party security APIs lag |

## Suggested fusion for MVP

```
Priority sources (need ≥ PANIC_CONFIRMATIONS = 2 by default):

1. Glider critical / high alert on watched protocol or dependency
2. Graph-derived: pool TVL −X% or token −Y% in window
3. Graph / oracle: stable peg deviation > DEPEG_THRESHOLD_BPS
4. Optional: Defimon LLM-confirmed exploit mentioning watched token/protocol
5. Optional: Forta alert matching watched addresses
```

0G then **explains and scores**; hard policy still requires multi-source agreement for `live` exits.

## Adapter interface

```ts
interface MonitorAdapter {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  // push into scanner bus
  onSignal(handler: (signal: NormalizedSignal) => void): void;
}

type NormalizedSignal = {
  source: string;
  severity: "low" | "medium" | "high" | "critical";
  addresses: string[];
  tokens?: string[];
  category: "exploit" | "hack" | "depeg" | "price" | "dependency" | "invariant" | "other";
  raw: unknown;
  ts: number;
};
```

## Enrollment checklist

- [ ] Glider Community: portal.hexens.io — add contracts, webhook URL → `/hooks/glider`
- [ ] Forta: identify 1–2 bots relevant to Uniswap / ERC20 anomaly; poll API
- [ ] Defimon: request API key / WS URL if available this weekend
- [ ] DIY price: Graph + Chainlink as always-on depeg/crash baseline (no vendor lock)
