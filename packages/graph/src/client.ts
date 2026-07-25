import { getConfig, logger } from "@sentinel/core";

export function subgraphUrl(subgraphId = getConfig().GRAPH_UNISWAP_SUBGRAPH): string {
  const cfg = getConfig();
  const base = cfg.GRAPH_GATEWAY_URL.replace(/\/$/, "");
  if (!cfg.GRAPH_API_KEY) {
    // Public explorer gateway sometimes works for light queries; prefer keyed gateway.
    return `${base}/${subgraphId}`;
  }
  return `${base}/${cfg.GRAPH_API_KEY}/subgraphs/id/${subgraphId}`;
}

export async function graphQuery<T>(
  query: string,
  variables?: Record<string, unknown>,
  subgraphId?: string,
): Promise<T> {
  const url = subgraphUrl(subgraphId);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as { data?: T; errors?: unknown };
  if (!res.ok || json.errors) {
    logger.error("graph query failed", { status: res.status, errors: json.errors });
    throw new Error(`Graph query failed: ${JSON.stringify(json.errors ?? json)}`);
  }
  if (!json.data) throw new Error("Graph query returned no data");
  return json.data;
}
