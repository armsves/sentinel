import {
  completeItem,
  createClients,
  dequeuePending,
  emitActivity,
  getEffectiveConfig,
  isDryRunAsync,
  listQueue,
  loadPolicySettings,
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

function stableAddress(
  symbol: string,
  cfg: Awaited<ReturnType<typeof getEffectiveConfig>>,
): `0x${string}` | null {
  if (symbol === "USDC") return cfg.USDC_ADDRESS as `0x${string}`;
  if (symbol === "USDT") return cfg.USDT_ADDRESS as `0x${string}`;
  if (symbol === "DAI") return cfg.DAI_ADDRESS as `0x${string}`;
  return null;
}

async function transferStablesToSafe(opts: {
  event: PanicEvent;
  policy: Awaited<ReturnType<typeof loadPolicySettings>>;
  cfg: Awaited<ReturnType<typeof getEffectiveConfig>>;
  publicClient: ReturnType<typeof createClients>["publicClient"];
  walletClient: NonNullable<ReturnType<typeof createClients>["walletClient"]>;
  from: `0x${string}`;
  dryRun: boolean;
}) {
  const { event, policy, cfg, publicClient, walletClient, from, dryRun } = opts;
  if (!policy.actions.transferToSafe) {
    await emitActivity({
      agent: "executor",
      phase: "transfer",
      level: "info",
      message: "Transfer to safe skipped (disabled in policy)",
    });
    return;
  }
  const safe = cfg.SAFE_WALLET_ADDRESS?.trim() as `0x${string}` | undefined;
  if (!safe || !/^0x[a-fA-F0-9]{40}$/.test(safe)) {
    await emitActivity({
      agent: "executor",
      phase: "transfer",
      level: "warn",
      message: "SAFE_WALLET_ADDRESS unset — stables stay on hot wallet",
    });
    return;
  }
  if (safe.toLowerCase() === from.toLowerCase()) {
    await emitActivity({
      agent: "executor",
      phase: "transfer",
      level: "info",
      message: "Safe wallet equals signer — skip transfer",
    });
    return;
  }

  const targetStables = event.targetStables.length
    ? event.targetStables
    : policy.safeAssets;

  for (const stableSym of targetStables) {
    const token = stableAddress(stableSym, cfg);
    if (!token) continue;
    let balance = 0n;
    try {
      balance = await publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [from],
      });
    } catch {
      continue;
    }
    if (balance === 0n) continue;

    if (dryRun) {
      await emitActivity({
        agent: "executor",
        phase: "transfer",
        level: "warn",
        message: `[dry_run] would transfer ${stableSym} → safe wallet`,
        data: {
          panicId: event.id,
          token: stableSym,
          amount: balance.toString(),
          to: safe,
        },
      });
      continue;
    }

    try {
      const hash = await walletClient.writeContract({
        address: token,
        abi: erc20Abi,
        functionName: "transfer",
        args: [safe, balance],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      await emitActivity({
        agent: "executor",
        phase: "transfer",
        level: "warn",
        message: `Transferred ${stableSym} to safe wallet`,
        data: { amount: balance.toString(), to: safe, hash },
      });
    } catch (err) {
      await emitActivity({
        agent: "executor",
        phase: "error",
        level: "error",
        message: `Transfer to safe failed (${stableSym})`,
        data: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }
}

async function flightToStables(event: PanicEvent) {
  const cfg = await getEffectiveConfig();
  const policy = await loadPolicySettings();
  const { publicClient, walletClient, address } = createClients({
    requireSigner: true,
  });
  if (!walletClient || !address) throw new Error("signer required");

  const dryRun = (await isDryRunAsync()) || event.mode === "dry_run";
  let positions: Awaited<ReturnType<typeof listOwnerPositions>> = [];
  try {
    positions = await listOwnerPositions(publicClient, address);
  } catch (err) {
    await emitActivity({
      agent: "executor",
      phase: "withdraw",
      level: "warn",
      message: "Could not list NFT positions; continuing with portfolio tokens",
      data: { error: err instanceof Error ? err.message : String(err) },
    });
  }
  const watched = new Set(cfg.watchedPositionIds);
  const targets =
    watched.size > 0
      ? positions.filter((p) => p.nftTokenId && watched.has(p.nftTokenId))
      : positions;

  const eventTokenIds = new Set(
    event.positions
      .map((p) => p.positionId)
      .filter((id): id is string => Boolean(id)),
  );
  const finalTargets =
    eventTokenIds.size > 0
      ? targets.filter((p) => p.nftTokenId && eventTokenIds.has(p.nftTokenId))
      : targets;

  await emitActivity({
    agent: "executor",
    phase: "withdraw",
    level: "warn",
    message: `Exit plan starting (${dryRun ? "dry_run" : "LIVE"})`,
    data: {
      panicId: event.id,
      positions: finalTargets.length,
      withdrawLp: policy.actions.withdrawLp,
      swapToStables: policy.actions.swapToStables,
      transferToSafe: policy.actions.transferToSafe,
      safeAssets: policy.safeAssets,
      safeWallet: cfg.SAFE_WALLET_ADDRESS || null,
    },
  });

  if (policy.actions.withdrawLp) {
    for (const pos of finalTargets) {
      if (!pos.nftTokenId) continue;
      if (pos.liquidity === "0") continue;
      try {
        await emitActivity({
          agent: "executor",
          phase: "withdraw",
          level: "info",
          message: `Withdrawing LP NFT #${pos.nftTokenId}`,
          data: { dryRun },
        });
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
        await emitActivity({
          agent: "executor",
          phase: "withdraw",
          level: "info",
          message: `LP withdraw ${dryRun ? "simulated" : "sent"} for NFT #${pos.nftTokenId}`,
        });
      } catch (err) {
        await emitActivity({
          agent: "executor",
          phase: "error",
          level: "error",
          message: `LP decrease failed for NFT #${pos.nftTokenId}`,
          data: { error: err instanceof Error ? err.message : String(err) },
        });
      }
    }
  } else {
    await emitActivity({
      agent: "executor",
      phase: "withdraw",
      level: "info",
      message: "LP withdraw skipped (disabled in policy)",
    });
  }

  if (policy.actions.swapToStables) {
    const tokenSet = new Set<string>();
    for (const pos of finalTargets) {
      tokenSet.add(pos.token0Address.toLowerCase());
      tokenSet.add(pos.token1Address.toLowerCase());
    }
    for (const t of cfg.portfolioTokens) tokenSet.add(t.toLowerCase());
    if (cfg.SUSD_ADDRESS) tokenSet.add(cfg.SUSD_ADDRESS.toLowerCase());

    const targetStables = event.targetStables.length
      ? event.targetStables
      : policy.safeAssets;
    const safe = new Set(
      targetStables
        .map((s) => stableAddress(s, cfg))
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
      for (const stableSym of targetStables) {
        const out = stableAddress(stableSym, cfg);
        if (!out) continue;
        try {
          await emitActivity({
            agent: "executor",
            phase: "swap",
            level: "info",
            message: `Swapping residual → ${stableSym}`,
            data: { token, amount: balance.toString(), dryRun },
          });
          await executeSwap({
            params: {
              tokenIn: token as `0x${string}`,
              tokenOut: out,
              amount: balance.toString(),
              swapper: address,
              slippageTolerance: Math.max(cfg.SLIPPAGE_TOLERANCE, 1),
              routingPreference: "BEST_PRICE",
            },
            walletClient,
            publicClient,
            dryRun,
          });
          await emitActivity({
            agent: "executor",
            phase: "swap",
            level: "warn",
            message: `[${dryRun ? "dry_run" : "live"}] swap to ${stableSym} ready`,
            data: { token },
          });
          swapped = true;
          break;
        } catch (err) {
          await emitActivity({
            agent: "executor",
            phase: "swap",
            level: "warn",
            message: `Swap to ${stableSym} failed — trying next`,
            data: { error: err instanceof Error ? err.message : String(err) },
          });
        }
      }
      if (!swapped) {
        await emitActivity({
          agent: "executor",
          phase: "error",
          level: "error",
          message: "Could not flight token to any stable",
          data: { token },
        });
      }
    }
  } else {
    await emitActivity({
      agent: "executor",
      phase: "swap",
      level: "info",
      message: "Swap-to-stables skipped (disabled in policy)",
    });
  }

  await transferStablesToSafe({
    event,
    policy,
    cfg,
    publicClient,
    walletClient,
    from: address,
    dryRun,
  });
}

export async function processOnePanic(): Promise<boolean> {
  const item = await dequeuePending();
  if (!item) return false;
  await emitActivity({
    agent: "executor",
    phase: "enqueue",
    level: "warn",
    message: `Processing panic ${item.event.id}`,
    data: {
      severity: item.event.severity,
      mode: item.event.mode,
      reasons: item.event.reasons.map((r) => r.source),
    },
  });
  try {
    await flightToStables(item.event);
    await completeItem(item.event.id, "done");
    await emitActivity({
      agent: "executor",
      phase: "done",
      level: "warn",
      message: `Panic completed ${item.event.id}`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await completeItem(item.event.id, "failed", msg);
    await emitActivity({
      agent: "executor",
      phase: "error",
      level: "error",
      message: `Panic failed ${item.event.id}`,
      data: { error: msg },
    });
  }
  return true;
}

export async function runPanicWorker(intervalMs = 5000) {
  const cfg = await getEffectiveConfig();
  await emitActivity({
    agent: "executor",
    phase: "heartbeat",
    level: "info",
    message: "Panic worker started",
    data: {
      mode: cfg.EXECUTION_MODE,
      intervalMs,
      safeWallet: cfg.SAFE_WALLET_ADDRESS || null,
    },
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
