import {
  completeItem,
  createClients,
  dequeuePending,
  getConfig,
  isDryRun,
  listQueue,
  logger,
  type PanicEvent,
} from "@sentinel/core";
import {
  decreasePosition,
  executeSwap,
  listOwnerPositions,
} from "@sentinel/uniswap";
import { erc20Abi } from "viem";

const NATIVE = "0x0000000000000000000000000000000000000000" as const;

function stableAddress(symbol: string): `0x${string}` | null {
  const cfg = getConfig();
  if (symbol === "USDC") return cfg.USDC_ADDRESS as `0x${string}`;
  if (symbol === "USDT") return cfg.USDT_ADDRESS as `0x${string}`;
  if (symbol === "DAI") return cfg.DAI_ADDRESS as `0x${string}`;
  return null;
}

async function flightToStables(event: PanicEvent) {
  const cfg = getConfig();
  const { publicClient, walletClient, address } = createClients({
    requireSigner: true,
  });
  if (!walletClient || !address) throw new Error("signer required");

  const dryRun = isDryRun() || event.mode === "dry_run";
  const positions = await listOwnerPositions(publicClient, address);
  const watched = new Set(cfg.watchedPositionIds);
  const targets =
    watched.size > 0
      ? positions.filter((p) => p.nftTokenId && watched.has(p.nftTokenId))
      : positions;

  logger.info("panic exit: positions", {
    total: positions.length,
    targeting: targets.length,
    dryRun,
    panicId: event.id,
  });

  for (const pos of targets) {
    if (!pos.nftTokenId) continue;
    if (pos.liquidity === "0") continue;
    try {
      await decreasePosition({
        params: {
          walletAddress: address,
          protocol: pos.protocol,
          chainId: cfg.CHAIN_ID,
          token0Address: pos.token0Address as `0x${string}`,
          token1Address: pos.token1Address as `0x${string}`,
          nftTokenId: pos.nftTokenId,
          liquidityPercentageToDecrease: 100,
        },
        walletClient,
        publicClient,
        dryRun,
      });
    } catch (err) {
      logger.error("decrease failed", {
        nft: pos.nftTokenId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const tokenSet = new Set<string>();
  for (const pos of targets) {
    tokenSet.add(pos.token0Address.toLowerCase());
    tokenSet.add(pos.token1Address.toLowerCase());
  }
  for (const t of cfg.portfolioTokens) tokenSet.add(t.toLowerCase());

  const safe = new Set(
    event.targetStables
      .map(stableAddress)
      .filter(Boolean)
      .map((a) => a!.toLowerCase()),
  );

  for (const token of tokenSet) {
    if (safe.has(token)) continue;
    if (token === NATIVE) continue;
    let balance = 0n;
    try {
      balance = await publicClient.readContract({
        address: token as `0x${string}`,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [address],
      });
    } catch {
      continue;
    }
    if (balance === 0n) continue;

    let swapped = false;
    for (const stableSym of event.targetStables) {
      const out = stableAddress(stableSym);
      if (!out) continue;
      try {
        await executeSwap({
          params: {
            tokenIn: token as `0x${string}`,
            tokenOut: out,
            amount: balance.toString(),
            swapper: address,
            slippageTolerance: Math.max(cfg.SLIPPAGE_TOLERANCE, 1),
            routingPreference: "CLASSIC",
          },
          walletClient,
          publicClient,
          dryRun,
        });
        swapped = true;
        break;
      } catch (err) {
        logger.warn("swap to stable failed, trying next", {
          token,
          stableSym,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (!swapped) {
      logger.error("could not flight token to any stable", { token });
    }
  }
}

export async function processOnePanic(): Promise<boolean> {
  const item = await dequeuePending();
  if (!item) return false;
  logger.warn("processing panic", {
    id: item.event.id,
    severity: item.event.severity,
    mode: item.event.mode,
  });
  try {
    await flightToStables(item.event);
    await completeItem(item.event.id, "done");
    logger.info("panic completed", { id: item.event.id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await completeItem(item.event.id, "failed", msg);
    logger.error("panic failed", { id: item.event.id, error: msg });
  }
  return true;
}

export async function runPanicWorker(intervalMs = 5000) {
  logger.info("panic worker starting", {
    mode: getConfig().EXECUTION_MODE,
    intervalMs,
  });
  const tick = async () => {
    try {
      let more = true;
      while (more) more = await processOnePanic();
    } catch (err) {
      logger.error("worker tick failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
  await tick();
  setInterval(tick, intervalMs);
}

export async function printQueue() {
  const items = await listQueue();
  console.log(JSON.stringify(items, null, 2));
}
