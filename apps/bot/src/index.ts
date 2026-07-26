/**
 * Single process: scanner + panic worker.
 * Use with the Vercel dashboard + shared Redis, or a local API.
 */
import { logger, pulseBotHeartbeat } from "@sentinel/core";
import { runScanner } from "@sentinel/scanner";
import { runPanicWorker } from "@sentinel/executor/panic-worker";

const HEARTBEAT_MS = 10_000;

async function main() {
  logger.info("sentinel bot starting (scanner + panic-worker in one process)");
  await pulseBotHeartbeat("bot");
  setInterval(() => {
    void pulseBotHeartbeat("bot").catch((err) => {
      logger.debug("bot heartbeat failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, HEARTBEAT_MS);

  await Promise.all([runScanner(), runPanicWorker()]);
  // Intervals keep the process alive.
}

main().catch((err) => {
  logger.error("bot crashed", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
