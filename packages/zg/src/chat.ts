import { getConfig, logger } from "@sentinel/core";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ChatResult = {
  reply: string;
  model: string;
  provider: "0g-router";
};

const DEFAULT_SYSTEM = `You are Sentinel, a DeFi panic-button agent.
You help operators understand Uniswap LP risk, exploit alerts (Blockaid/X, Glider, Forta),
The Graph pool health, and flight-to-safety into USDC/USDT/DAI.
Be concise and practical. If asked whether 0G works, confirm you are answering via 0G Compute.`;

export async function chatWith0G(opts: {
  message: string;
  history?: ChatMessage[];
  system?: string;
}): Promise<ChatResult> {
  const cfg = getConfig();
  if (!cfg.ZG_ROUTER_API_KEY) {
    throw new Error(
      "ZG_ROUTER_API_KEY is not set — add a 0G Router key to .env to chat",
    );
  }
  if (cfg.ZG_COMPUTE_MODE === "off") {
    throw new Error("ZG_COMPUTE_MODE=off — set to router to enable chat");
  }

  const messages: ChatMessage[] = [
    { role: "system", content: opts.system ?? DEFAULT_SYSTEM },
    ...(opts.history ?? []).slice(-12),
    { role: "user", content: opts.message },
  ];

  const base = cfg.ZG_ROUTER_BASE_URL.replace(/\/$/, "");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.ZG_ROUTER_API_KEY}`,
    },
    body: JSON.stringify({
      model: cfg.ZG_MODEL,
      temperature: 0.4,
      messages,
    }),
  });

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    model?: string;
    error?: unknown;
  };

  if (!res.ok) {
    logger.error("0G chat failed", { status: res.status, error: json.error ?? json });
    throw new Error(
      `0G chat failed (${res.status}): ${JSON.stringify(json.error ?? json)}`,
    );
  }

  const reply = json.choices?.[0]?.message?.content?.trim();
  if (!reply) throw new Error("0G returned an empty reply");

  return {
    reply,
    model: json.model ?? cfg.ZG_MODEL,
    provider: "0g-router",
  };
}
