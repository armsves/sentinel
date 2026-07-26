# FEEDBACK.md — Uniswap API issues (ETHGlobal Lisbon 2026)

Notes from building **Sentinel** against the [Uniswap Developer Platform](https://developers.uniswap.org/docs) Trading API + LP API. Focused on friction we hit; not a full product log.

**Surfaces used:** `/quote`, `/swap`, `/check_approval` (trade) · `/lp/create`, `/lp/decrease`, `/lp/check_approval`, `/lp/pool_info` (LP)  
**Hosts:** `trade-api.gateway.uniswap.org` · `liquidity.api.uniswap.org`  
**Demo chain:** Ethereum Sepolia (`11155111`) + mainnet-oriented docs defaults

---

## Issues & friction

### 1. `gasFeeUSD` is misleading on Sepolia (and non-mainnet)

Quote responses still expose `gasFeeUSD`, but on Sepolia the number was not a trustworthy USD gas cost (looked like a mainnet-style estimate / placeholder).

**Impact:** Dashboard dry-run quotes showed bogus “USD gas” until we special-cased non-mainnet and displayed native ETH from `gasFee` (wei) instead.

**Ask:** Document which quote fields are reliable per `chainId`, or omit / null `gasFeeUSD` off mainnet.

### 2. Two different API hosts + different required headers

Trading and LP live on different base URLs. Trade calls also need `x-universal-router-version: 2.0`; LP calls do not.

**Impact:** Easy to hit the wrong host or miss the UR header and get opaque 4xx/5xx. Skills docs help, but a single “integration checklist” for both surfaces would cut setup time.

### 3. No first-class “list my positions” for the panic agent

For “what NFTs does this wallet hold / what’s in this pool?”, we could not rely on a simple LP API owner listing that matched our needs.

**Impact:** Fell back to on-chain `NonfungiblePositionManager` (`balanceOf` / `tokenOfOwnerByIndex` / `positions`) via RPC. Fine for MVP, but means the Uniswap API is not the single source of truth for portfolio inventory.

**Ask:** Owner position listing (or signed wallet session → positions) on the LP API would make agent demos cleaner.

### 4. Position token amounts are not returned (only liquidity / ticks)

LP / NPM data gives liquidity + tick range, not human-readable token0/token1 balances.

**Impact:** We reimplemented Uniswap v3 tick math (`sqrtPriceX96` + liquidity → amounts) to show “52 USDC / 53 sUSD” on the Portfolio page.

**Ask:** Optional enriched position payload (`amount0`, `amount1`, symbols, decimals) would save every integrator repeating TickMath.

### 5. Quote / plan expiry and empty `tx.data`

Built swap/LP transactions can come back with empty or stale calldata if the plan expires or the client mishandles the response.

**Impact:** Had to validate `to` / `data` before broadcast and surface “quote may have expired” errors.

**Ask:** Clearer error codes when a quote is expired vs malformed client payload.

### 6. Error bodies are inconsistent (JSON vs non-JSON)

Some failure paths return JSON (`error` / `detail`); others returned non-JSON bodies that broke naive `res.json()` parsers on the public demo API.

**Impact:** Hardened fetch helpers to always read text first, then parse; map status + body into one error string for the UI.

**Ask:** Always JSON error envelope with a stable `code` + `message`.

### 7. Multi-step approval / Permit2 / UniswapX branching

Trade flow: `check_approval` → optional approval tx → `quote` → optional Permit2 sign → `swap`. Routing can be classic UR or UniswapX (`DUTCH_V2` / `DUTCH_V3` / `PRIORITY`) with different signature shapes.

**Impact:** Extra branching for a panic “flight to stables” path that just wants a reliable classic V3 swap under stress.

**Ask:** A documented “agent panic swap” preset (force classic V3, skip UniswapX) would reduce footguns for automated executors.

### 8. LP `check_approval` KYC / allowlist warnings

LP approval responses can include `kycRequiredWarnings` for permissioned pools.

**Impact:** We treat that as a hard stop. Fine, but easy to miss in docs until you hit it.

### 9. Dry-run / simulation story is split

LP create/decrease support `simulateTransaction`; trade dry-run is more “plan but don’t send” on our side. Public Vercel demo cannot hold a hot key, so we only quote / simulate activity for visitors.

**Impact:** Two mental models (API simulate vs client dry-run) for sponsors watching the demo.

**Ask:** Uniform `simulate: true` across trade + LP that returns gas + amounts without requiring a funded signer.

### 10. Sepolia demo LP still needed custom on-chain setup

Creating / seeding our sUSD–USDC v3 pool for the hackathon demo was mostly scripts + NPM on Sepolia, not a one-shot LP API “create demo pool” path.

**Impact:** More time on pool bootstrap than on agent logic.

---

## What worked well

- API key from the Developer Platform unlocked both Trading + LP with the same key.
- `/lp/pool_info` and `/quote` were enough to prove routing + pool metadata quickly.
- Official AI skills (`swap-integration`, `lp-integration`, `viem-integration`) were a useful map of endpoints and headers.
- Classic V3 `protocols: ["V3"]` on quote kept panic swaps predictable once we locked that in.

---

## Suggested Uniswap improvements (for agents)

1. Null or omit unreliable quote money fields off mainnet (`gasFeeUSD`).
2. Owner position inventory + enriched amounts on the LP API.
3. Stable JSON errors with machine-readable codes.
4. Explicit “classic V3 only / no UniswapX” flag for automated executors.
5. One shared simulate mode for trade + LP dry-runs.

---

## Contact

GitHub: [armsves/sentinel](https://github.com/armsves/sentinel) · X: [x.com/armsves](https://x.com/armsves)
