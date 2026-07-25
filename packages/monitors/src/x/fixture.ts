/**
 * Demo fixtures shaped like Blockaid X posts (hacks + depegs).
 * Used when X_BEARER_TOKEN is unset so local/dev still exercises parsing.
 * Mentions Sentinel demo assets (sUSD / Sepolia pool) so watchlist filters match.
 */
import type { XPost } from "./parse.js";

export const BLOCKAID_VERUS_FIXTURE: XPost[] = [
  {
    id: "fixture-susd-depeg-1",
    username: "blockaid_",
    createdAt: "2026-07-25T18:00:00.000Z",
    url: "https://x.com/blockaid_/status/fixture-susd-depeg-1",
    text:
      "🚨 Blockaid alert: sUSD lost its peg on Sepolia Uniswap v3 pool 0x68eB6856e570e2c33A7239D0fF8C5d9A77Cecd8b. Spot vs USDC under-peg ~180 bps. Token 0xC084E80E4E546561f4348198ebfC1fe7b714DB37. LP exits recommended.",
  },
  {
    id: "fixture-susd-hack-1",
    username: "blockaid_",
    createdAt: "2026-07-25T18:01:00.000Z",
    url: "https://x.com/blockaid_/status/fixture-susd-hack-1",
    text:
      "Follow-up: suspected oracle / reserve exploit path against sUSD-USDC. Watching drains involving USDC 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238. Treat as high severity until confirmed.",
  },
  {
    id: "fixture-verus-1",
    username: "blockaid_",
    createdAt: "2026-07-23T12:00:00.000Z",
    url: "https://x.com/blockaid_/status/fixture-verus-1",
    text:
      "🚨 Blockaid detected a @VerusCoin Ethereum Bridge exploit on Ethereum. An attacker used the bridge import path to trigger unbacked Ethereum-side payouts, draining ~$7.54M in ETH, tBTC, USDC, USDT, EURC, MKR, and scrvUSD from bridge reserves. More details in 🧵",
  },
];
