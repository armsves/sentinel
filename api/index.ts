/**
 * Vercel serverless entry — same Hono app as local `pnpm api`.
 * Set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN in Vercel env
 * so settings/activity persist for public visitors.
 */
import { handle } from "hono/vercel";

if (process.env.VERCEL) {
  process.env.PUBLIC_DEMO ??= "true";
}

// Built workspace packages (vercel buildCommand compiles them)
import { app } from "../apps/api/src/server.js";

export default handle(app);
