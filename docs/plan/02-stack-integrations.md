# 02 — Stack integrations

## Uniswap API

Docs: https://developers.uniswap.org/docs

**Requirement:** valid API key from the Uniswap Developer Platform; use the API for core value movement (not only decorative reads).

### MVP usage

| Capability | Sentinel use |
| --- | --- |
| Quote / route | Price impact check before exit; choose best path to stable |
| Swap / trade execution | Convert withdrawn tokens → USDC/USDT/DAI |
| Liquidity | Decrease / remove LP for watched v3 positions (or coordinated exit) |
| Agent coordination | Scanner plans intent; Executor submits via API |

### Stretch

- Tokenized stocks as watched assets (new Uniswap API asset class) — panic if equity-token depegs from reference.
- UniswapX / filler patterns only if time remains.

### Integration notes

- Store `UNISWAP_API_KEY` in env.
- Prefer official TypeScript SDK / API skills (`npx skills add uniswap/uniswap-ai --skill swap-integration`) for agent-assisted coding.
- Always set slippage + deadline conservatively during panic (accept worse price to exit risk).

## The Graph

Resources: https://thegraph.com/blog/hackathon-resources/

**Role:** live source of blockchain data for **token & pool monitoring**.

### MVP usage

1. Query Uniswap subgraph(s) for pool reserves, volume spikes, tick / liquidity changes, position ownership.
2. Query stablecoin / Messari standardized subgraphs for peg deviation proxies.
3. Optional: Subgraph MCP so the 0G-backed agent can ask natural-language questions over 15k+ subgraphs.
4. Optional: x402 pay-per-query for autonomous metering.

### Signals derived from Graph

- Pool TVL drop % over window
- Token price vs reference (ETH/USD, stables)
- Abnormal swap volume / concentrated sells into the pool
- LP share / position value change

### Bounty alignment

Strong fit for **Best AI Use Case of The Graph** (risk monitor + execution agent) and optionally **Best Use of Composable / Standardized Graph Products** if Messari standard schemas are used for cross-protocol checks.

## 0G Compute

Docs: https://docs.0g.ai/

**Role:** decentralized inference for risk scoring and human-readable panic rationale.

### Recommended path (MVP)

**Compute Router** — OpenAI-compatible:

- Base URL: `https://router-api.0g.ai/v1`
- API key from `pc.0g.ai`
- Model from marketplace catalog (e.g. Qwen instruct)

Scanner builds a compact JSON context (signals, thresholds, pool summary) and asks 0G for:

```json
{
  "score": 0.0,
  "shouldPanic": false,
  "severity": "low",
  "rationale": "...",
  "whichSourcesMatter": ["glider", "graph"]
}
```

Policy still enforces hard rules (e.g. never panic on AI alone without `PANIC_CONFIRMATIONS`).

### Alternative

Direct SDK `@0gfoundation/0g-compute-ts-sdk` with wallet signing — useful if demo wants on-chain settlement narrative; Router is faster to ship.

## Env matrix

See root `.env.example` for the full variable list spanning Uniswap, Graph, 0G, monitors, and wallet.
