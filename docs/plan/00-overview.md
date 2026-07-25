# 00 — Overview

## Problem

LP and DeFi positions are exposed to fast-moving failure modes:

- Smart-contract **exploits** and live attacking transactions
- Protocol / dependency **hacks**
- Stablecoin **depegs**
- Sudden **price crashes** and oracle dislocations
- Cascading **liquidity drains** in the pools you sit in

Humans cannot watch this 24/7. By the time a Telegram alert is read, the pool may already be toxic.

## Solution

**Sentinel** is a panic-button agent system:

1. Continuously scan watched Uniswap positions and related tokens.
2. Fuse security feeds + on-chain market data + AI scoring.
3. On confirmed threat, automatically **exit liquidity** and **convert to secure stables**.

## Goals (hackathon)

- Dual-agent runtime: **Scanner** (no keys) + **Executor** (signing wallet in env).
- Integrate **Uniswap API** with a valid developer API key for trade / LP execution.
- Use **The Graph** as the live source for token & pool state.
- Use **0G Compute** for AI threat evaluation / decision assistance.
- Ingest **Hexens Glider Monitor** (and optional secondary monitors).
- Dry-run mode by default; live mode behind `EXECUTION_MODE=live`.
- Documentable demo: signal → decision → exit → stable balance.

## Non-goals (this weekend)

- Same-block / mempool firewall that *prevents* the attacking tx (that is Glider/Forta Firewall territory; we *react*).
- Full institutional custody / MPC (upgrade path only).
- Cross-chain bridging as part of panic (stay on one chain for MVP).
- Perfect zero false positives (use confirmation thresholds instead).

## Success criteria

| Criterion | Pass bar |
| --- | --- |
| Sponsor integrations | Uniswap API + Graph + 0G all exercised in demo |
| Safety | Executor alone holds `PRIVATE_KEY`; dry-run works end-to-end |
| Latency | Panic decision + start execution within ~30–60s of signal |
| Clarity | Judges understand scanner vs executor in <60s |

## User story

> As an LP, I configure which Uniswap positions to protect and which stables to flee to. Sentinel watches. If Glider or Graph-backed signals say my pool or token is under attack / depegging / crashing, Sentinel pulls me out and parks value in USDC (or next best stable) without me opening a wallet UI.
