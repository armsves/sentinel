import type { NormalizedSignal, Severity, SignalCategory } from "@sentinel/core";

export type XPost = {
  id: string;
  username: string;
  text: string;
  createdAt?: string;
  url?: string;
};

const EXPLOIT_RE =
  /\b(exploit|exploited|draining|drained|hack(?:ed)?|attack(?:er|ed)?|vulnerability|0-?day|bridge\s+exploit)\b/i;

const DEPEG_RE =
  /\b(de-?peg(?:ged|ging)?|lost\s+(?:its\s+)?peg|off[\s-]?peg|peg\s+(?:break|broke|failure|deviation)|stablecoin\s+crash|under[\s-]?peg)\b/i;

const ADDR_RE = /0x[a-fA-F0-9]{40}/g;
const TX_RE = /0x[a-fA-F0-9]{64}/g;
/** Common tickers + Sentinel demo sUSD */
const TOKEN_RE =
  /\b(ETH|WETH|BTC|WBTC|tBTC|USDC|USDT|DAI|EURC|MKR|stETH|scrvUSD|UNI|LINK|ARB|OP|sUSD|SUSD|USDe|FRAX)\b/g;

export function isExploitPost(text: string): boolean {
  return EXPLOIT_RE.test(text);
}

export function isDepegPost(text: string): boolean {
  return DEPEG_RE.test(text);
}

export function isSecurityPost(text: string): boolean {
  return isExploitPost(text) || isDepegPost(text);
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

export function categoryForPost(text: string): SignalCategory {
  if (isDepegPost(text) && !isExploitPost(text)) return "depeg";
  if (isExploitPost(text) && /\bhack/i.test(text)) return "hack";
  if (isExploitPost(text)) return "exploit";
  if (isDepegPost(text)) return "depeg";
  return "other";
}

export function severityForPost(text: string): Severity {
  if (/\b(draining|drained|\$\d)/i.test(text)) return "critical";
  if (isDepegPost(text) && /\b(lost|break|broke|crash|under[\s-]?peg)/i.test(text))
    return "critical";
  if (/\b(exploit|hacked|attacker|de-?peg)/i.test(text)) return "high";
  return "medium";
}

export function postToSignal(post: XPost): NormalizedSignal | null {
  if (!isSecurityPost(post.text)) return null;
  const addresses = extractAddresses(post.text);
  const tokens = extractTokenSymbols(post.text);
  const txs = extractTxHashes(post.text);
  const category = categoryForPost(post.text);
  return {
    source: "x",
    severity: severityForPost(post.text),
    addresses,
    tokens,
    category,
    message: `@${post.username}: ${post.text.slice(0, 240)}`,
    raw: {
      id: post.id,
      username: post.username,
      url: post.url ?? `https://x.com/${post.username}/status/${post.id}`,
      createdAt: post.createdAt,
      txs,
      text: post.text,
      category,
    },
    ts: post.createdAt ? Date.parse(post.createdAt) || Date.now() : Date.now(),
  };
}

export function postsToSignals(posts: XPost[]): NormalizedSignal[] {
  return posts
    .map(postToSignal)
    .filter((s): s is NormalizedSignal => s !== null);
}

/** Keep signals that touch watched pools/tokens/portfolio symbols. */
export function filterSignalsByWatchlist(
  signals: NormalizedSignal[],
  opts: {
    addresses?: string[];
    symbols?: string[];
    /** When true and watchlist empty, keep all (live API mode). */
    keepAllIfEmpty?: boolean;
  },
): NormalizedSignal[] {
  const addrs = new Set(
    (opts.addresses ?? []).map((a) => a.toLowerCase()).filter(Boolean),
  );
  const symbols = new Set(
    (opts.symbols ?? []).map((s) => s.toUpperCase()).filter(Boolean),
  );
  if (!addrs.size && !symbols.size) {
    return opts.keepAllIfEmpty === false ? [] : signals;
  }
  return signals.filter((s) => {
    const addrHit = s.addresses.some((a) => addrs.has(a.toLowerCase()));
    const tokenHit = (s.tokens ?? []).some((t) => symbols.has(t.toUpperCase()));
    return addrHit || tokenHit;
  });
}
