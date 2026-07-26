/** Block explorer helpers for activity feed + CLI. */

const EXPLORERS: Record<number, string> = {
  1: "https://etherscan.io",
  10: "https://optimistic.etherscan.io",
  8453: "https://basescan.org",
  42161: "https://arbiscan.io",
  137: "https://polygonscan.com",
  11155111: "https://sepolia.etherscan.io",
};

export function explorerBaseUrl(chainId: number): string {
  return EXPLORERS[chainId] ?? `https://etherscan.io`;
}

export function explorerTxUrl(chainId: number, hash: string): string {
  return `${explorerBaseUrl(chainId)}/tx/${hash}`;
}

export function explorerAddressUrl(chainId: number, address: string): string {
  return `${explorerBaseUrl(chainId)}/address/${address}`;
}
