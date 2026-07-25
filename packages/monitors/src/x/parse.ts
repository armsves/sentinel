import type { NormalizedSignal, Severity } from "@sentinel/core";

export type XPost = {
  id: string;
  username: string;
  text: string;
  createdAt?: string;
  url?: string;
};

const EXPLOIT_RE =
  /\b(exploit|exploited|draining|drained|hack(?:ed)?|attack(?:er|ed)?|vulnerability|0-?day|bridge\s+exploit)\b/i;

const ADDR_RE = /0x[a-fA-F0-9]{40}/g;
const TX_RE = /0x[a-fA-F0-9]{64}/g;
/** Common tickers mentioned in security alerts */
const TOKEN_RE =
  /\b(ETH|WETH|BTC|WBTC|tBTC|USDC|USDT|DAI|EURC|MKR|stETH|scrvUSD|UNI|LINK|ARB|OP)\b/g;

export function isExploitPost(text: string): boolean {
  return EXPLOIT_RE.test(text);
}

export function extractAddresses(text: string): string[] {
  // Prefer full 64-char tx hashes; only keep standalone 40-char addresses.
  const txs = new Set(extractTxHashes(text));
  const found = text.match(ADDR_RE) ?? [];
  return [
    ...new Set(
      found
        .map((a) => a.toLowerCase())
        .filter((a) => a.length === 42)
        .filter((a) => ![...txs].some((tx) => tx.startsWith(a))),
    ),
  ];
}

export function extractTxHashes(text: string): string[] {
  const found = text.match(TX_RE) ?? [];
  return [...new Set(found.map((t) => t.toLowerCase()).filter((t) => t.length === 66))];
}

export function extractTokenSymbols(text: string): string[] {
  const found = text.match(TOKEN_RE) ?? [];
  return [...new Set(found.map((t) => t.toUpperCase()))];
}

export function severityForPost(text: string): Severity {
  if (/\b(draining|drained|\$\d)/i.test(text)) return "critical";
  if (/\b(exploit|hacked|attacker)\b/i.test(text)) return "high";
  return "medium";
}

export function postToSignal(post: XPost): NormalizedSignal | null {
  if (!isExploitPost(post.text)) return null;
  const addresses = extractAddresses(post.text);
  const tokens = extractTokenSymbols(post.text);
  const txs = extractTxHashes(post.text);
  return {
    source: "x",
    severity: severityForPost(post.text),
    addresses,
    tokens,
    category: "exploit",
    message: `@${post.username}: ${post.text.slice(0, 240)}`,
    raw: {
      id: post.id,
      username: post.username,
      url: post.url ?? `https://x.com/${post.username}/status/${post.id}`,
      createdAt: post.createdAt,
      txs,
      text: post.text,
    },
    ts: post.createdAt ? Date.parse(post.createdAt) || Date.now() : Date.now(),
  };
}

export function postsToSignals(posts: XPost[]): NormalizedSignal[] {
  return posts
    .map(postToSignal)
    .filter((s): s is NormalizedSignal => s !== null);
}
