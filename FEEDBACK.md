# FEEDBACK.md — Uniswap API issues

Issues hit while integrating [Uniswap Trading API](https://developers.uniswap.org/docs/trading/swapping-api/integration-guide) and [LP API](https://developers.uniswap.org/docs/liquidity/liquidity-provisioning-api/integration-guide) into Sentinel (ETHGlobal Lisbon 2026).

## Setup / config

1. **Two base URLs** — Trade and LP use different hosts (`UNISWAP_TRADE_API_BASE_URL` vs `UNISWAP_LP_API_BASE_URL`). Pointing both at one URL breaks half the calls.
2. **Extra Trade header** — Trading API needs `x-universal-router-version: 2.0` in addition to `x-api-key`. Missing it fails requests that look correctly keyed.
3. **Same API key, different products** — One Developer Platform key works for both Trade and LP, but each product still has its own base URL and header rules.

## Quotes / swaps

4. **`gasFeeUSD` on Sepolia** — Quotes return `gasFeeUSD` that is not meaningful on testnets. We display `gasFee` as ETH on Sepolia instead of treating USD as truth.
5. **Non-JSON error bodies** — Failed `/quote` sometimes returns plain text / HTML. Parsers that assume JSON throw; read as text first, then parse.
6. **Quote expiry** — Planned txs can come back with empty `data`. Treat empty calldata as expired quote and re-quote before send.
7. **Routing variants** — Responses may be classic Universal Router or UniswapX (`DUTCH_V2` / `DUTCH_V3` / `PRIORITY`). Each needs different Permit2 / signature handling before `/swap`.
8. **Amount units** — Amounts are smallest units (wei-style strings), not human decimals. Passing `"1"` means 1 base unit, not 1 USDC.

## LP API

9. **`/lp/check_approval` KYC warnings** — Permissioned pools return `kycRequiredWarnings`. Must fail closed or exits blow up later.
10. **Decrease needs NFT id + pool token addresses** — `/lp/decrease` expects wallet, protocol, chainId, token0/token1, and `liquidityPercentageToDecrease`. Missing any of these fails after you already thought you “had” the position.
11. **Simulate vs live** — `simulateTransaction: true` is the dry-run path for create/decrease. Easy to forget and attempt a real tx in demo mode.

## What we work around in Sentinel

| Gap | Workaround in this repo |
| --- | --- |
| No reliable owner position list from API | `listOwnerPositions` via RPC against NPM |
| No token amounts on positions | `getAmountsForPosition` in `packages/uniswap/src/v3math.ts` |
| Bad Sepolia `gasFeeUSD` | Show `gasFee` as ETH when `CHAIN_ID !== 1` |
| Non-JSON error bodies | Read response as text, then `JSON.parse` safely |
| UniswapX vs UR quotes | Prefer classic routes; handle Permit2 only when present |

## Open questions for Uniswap

1. Best API path for **full LP exit + multi-hop to stables** as one coordinated flow?
2. Recommended way to list all v3 NFT positions for a wallet without NPM RPC?
3. Is `gasFeeUSD` expected to be valid on Sepolia, or mainnet-only?
4. Preferred pattern for dry-run in public demos without shipping private keys?
