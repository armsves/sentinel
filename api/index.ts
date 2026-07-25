/**
 * Vercel serverless entry — same Hono app as local `pnpm api`.
 * Dynamic import avoids ERR_REQUIRE_ESM when Vercel wraps the handler as CJS.
 */
import { handle } from "hono/vercel";

if (process.env.VERCEL) {
  process.env.PUBLIC_DEMO ??= "true";
}

const appModule = await import("../apps/api/src/server.js");
const handler = handle(appModule.app);

export default handler;
