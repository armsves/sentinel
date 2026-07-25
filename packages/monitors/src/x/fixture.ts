/**
 * Demo fixture shaped like a Blockaid exploit thread
 * (VerusCoin Ethereum Bridge, Jul 2026).
 * Used when X_BEARER_TOKEN is unset so local/dev still exercises parsing.
 */
import type { XPost } from "./parse.js";

export const BLOCKAID_VERUS_FIXTURE: XPost[] = [
  {
    id: "fixture-verus-1",
    username: "blockaid_",
    createdAt: "2026-07-23T12:00:00.000Z",
    url: "https://x.com/blockaid_/status/fixture-verus-1",
    text:
      "🚨 Blockaid detected a @VerusCoin Ethereum Bridge exploit on Ethereum. An attacker used the bridge import path to trigger unbacked Ethereum-side payouts, draining ~$7.54M in ETH, tBTC, USDC, USDT, EURC, MKR, and scrvUSD from bridge reserves. More details in 🧵",
  },
  {
    id: "fixture-verus-2",
    username: "blockaid_",
    createdAt: "2026-07-23T12:01:00.000Z",
    url: "https://x.com/blockaid_/status/fixture-verus-2",
    text:
      "Exploit tx: https://etherscan.io/tx/0xa1f1e65c1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa Target contract: 0x71518580f36feceffe0721f06ba4703218cd7f63 Attacker: 0xCFd0A20703cD11E0b9f665e1C3F1Ef989C142D54",
  },
];
