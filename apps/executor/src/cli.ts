#!/usr/bin/env node
import {
  buildPanicEvent,
  createClients,
  enqueuePanic,
  getConfig,
  getEffectiveConfig,
  isDryRunAsync,
  logger,
} from "@sentinel/core";
import {
  BLOCKAID_VERUS_FIXTURE,
  GLIDER_FIXTURE,
  normalizeGliderWebhook,
  postsToSignals,
} from "@sentinel/monitors";
import {
  createPosition,
  decreasePosition,
  executeSwap,
  getPoolInfo,
  getPositionByTokenId,
  listOwnerPositions,
} from "@sentinel/uniswap";
import { scoreSignalsWith0G, chatWith0G } from "@sentinel/zg";
import { parseUnits } from "viem";
import { printQueue, processOnePanic, runPanicWorker } from "./panicWorker.js";

function usage(): never {
  console.log(`
Sentinel executor CLI — Uniswap swap + LP (Trading API + LP API)

Usage:
  pnpm cli swap --tokenIn <addr> --tokenOut <addr> --amount <human> [--decimals 18]
  pnpm cli deposit --pool <poolAddr> --token0 <addr> --token1 <addr> --amountToken <addr> --amount <human> [--decimals 18] [--tickLower n] [--tickUpper n] [--minPrice x] [--maxPrice y] [--protocol V3]
  pnpm cli withdraw --nft <tokenId> --token0 <addr> --token1 <addr> --pct 100 [--protocol V3]
  pnpm cli positions [--nft <tokenId>]
  pnpm cli pool-info --tokenA <addr> --tokenB <addr> [--fee 3000] [--protocol V3]
  pnpm cli queue
  pnpm cli panic-simulate [--source x|glider|both]
  pnpm cli panic-once
  pnpm cli panic-worker
  pnpm cli chat --message "hello"

Env:
  EXECUTION_MODE=dry_run|live   (default dry_run)
  UNISWAP_API_KEY, RPC_URL, PRIVATE_KEY, CHAIN_ID
  ZG_ROUTER_API_KEY (for chat / scoring)
`);
  process.exit(1);
}

function arg(flag: string, argv: string[]): string | undefined {
  const i = argv.indexOf(flag);
  if (i === -1) return undefined;
  return argv[i + 1];
}

function requireArg(flag: string, argv: string[]): string {
  const v = arg(flag, argv);
  if (!v) {
    console.error(`Missing ${flag}`);
    usage();
  }
  return v;
}

async function cmdSwap(argv: string[]) {
  const cfg = getConfig();
  const { publicClient, walletClient, address } = createClients({
    requireSigner: true,
  });
  if (!walletClient || !address) throw new Error("signer required");

  const tokenIn = requireArg("--tokenIn", argv) as `0x${string}`;
  const tokenOut = requireArg("--tokenOut", argv) as `0x${string}`;
  const human = requireArg("--amount", argv);
  const decimals = Number(arg("--decimals", argv) ?? "18");
  const amount = parseUnits(human, decimals).toString();

  const result = await executeSwap({
    params: {
      tokenIn,
      tokenOut,
      amount,
      swapper: address,
      slippageTolerance: cfg.SLIPPAGE_TOLERANCE,
      routingPreference: "BEST_PRICE",
    },
    walletClient,
    publicClient,
    dryRun: await isDryRunAsync(),
  });

  logger.info("swap done", {
    mode: (await getEffectiveConfig()).EXECUTION_MODE,
    routing: result.quote.routing,
    hash: result.hash,
    simulated: result.simulated,
  });
}

async function cmdDeposit(argv: string[]) {
  const cfg = getConfig();
  const { publicClient, walletClient, address } = createClients({
    requireSigner: true,
  });
  if (!walletClient || !address) throw new Error("signer required");

  const pool = requireArg("--pool", argv);
  const token0 = requireArg("--token0", argv) as `0x${string}`;
  const token1 = requireArg("--token1", argv) as `0x${string}`;
  const amountToken = requireArg("--amountToken", argv) as `0x${string}`;
  const human = requireArg("--amount", argv);
  const decimals = Number(arg("--decimals", argv) ?? "18");
  const protocol = (arg("--protocol", argv) ?? "V3") as "V2" | "V3" | "V4";
  const amount = parseUnits(human, decimals).toString();

  const tickLower = arg("--tickLower", argv);
  const tickUpper = arg("--tickUpper", argv);
  const minPrice = arg("--minPrice", argv);
  const maxPrice = arg("--maxPrice", argv);

  const result = await createPosition({
    params: {
      walletAddress: address,
      protocol,
      chainId: cfg.CHAIN_ID,
      token0Address: token0,
      token1Address: token1,
      poolReference: pool,
      independentToken: { tokenAddress: amountToken, amount },
      ...(tickLower && tickUpper
        ? {
            tickBounds: {
              tickLower: Number(tickLower),
              tickUpper: Number(tickUpper),
            },
          }
        : minPrice && maxPrice
          ? { priceBounds: { minPrice, maxPrice } }
          : {
              // wide default range — override in production
              tickBounds: { tickLower: -887220, tickUpper: 887220 },
            }),
    },
    walletClient,
    publicClient,
    dryRun: await isDryRunAsync(),
  });

  logger.info("deposit done", {
    mode: (await getEffectiveConfig()).EXECUTION_MODE,
    hash: result.hash,
    simulated: result.simulated,
  });
}

async function cmdWithdraw(argv: string[]) {
  const cfg = getConfig();
  const { publicClient, walletClient, address } = createClients({
    requireSigner: true,
  });
  if (!walletClient || !address) throw new Error("signer required");

  const nft = requireArg("--nft", argv);
  const token0 = requireArg("--token0", argv) as `0x${string}`;
  const token1 = requireArg("--token1", argv) as `0x${string}`;
  const pct = Number(arg("--pct", argv) ?? "100");
  const protocol = (arg("--protocol", argv) ?? "V3") as "V2" | "V3" | "V4";

  const result = await decreasePosition({
    params: {
      walletAddress: address,
      protocol,
      chainId: cfg.CHAIN_ID,
      token0Address: token0,
      token1Address: token1,
      nftTokenId: nft,
      liquidityPercentageToDecrease: pct,
    },
    walletClient,
    publicClient,
    dryRun: await isDryRunAsync(),
  });

  logger.info("withdraw done", {
    mode: (await getEffectiveConfig()).EXECUTION_MODE,
    hash: result.hash,
    simulated: result.simulated,
  });
}

async function cmdPositions(argv: string[]) {
  const { publicClient, address } = createClients();
  if (!address) throw new Error("WALLET_ADDRESS or PRIVATE_KEY required");
  const nft = arg("--nft", argv);
  if (nft) {
    const pos = await getPositionByTokenId(publicClient, BigInt(nft));
    console.log(JSON.stringify(pos, null, 2));
    return;
  }
  const list = await listOwnerPositions(publicClient, address);
  console.log(JSON.stringify(list, null, 2));
}

async function cmdPoolInfo(argv: string[]) {
  const cfg = getConfig();
  const tokenA = requireArg("--tokenA", argv) as `0x${string}`;
  const tokenB = requireArg("--tokenB", argv) as `0x${string}`;
  const fee = arg("--fee", argv);
  const protocol = (arg("--protocol", argv) ?? "V3") as "V2" | "V3" | "V4";
  const info = await getPoolInfo({
    protocol,
    chainId: cfg.CHAIN_ID,
    tokenAddressA: tokenA,
    tokenAddressB: tokenB,
    fee: fee ? Number(fee) : undefined,
  });
  console.log(JSON.stringify(info, null, 2));
}

async function cmdChat(argv: string[]) {
  const message = requireArg("--message", argv);
  const result = await chatWith0G({ message });
  console.log(JSON.stringify(result, null, 2));
}

async function cmdPanicSimulate(argv: string[]) {
  const source = (arg("--source", argv) ?? "both") as "x" | "glider" | "both";
  const signals = [];
  if (source === "x" || source === "both") {
    signals.push(...postsToSignals(BLOCKAID_VERUS_FIXTURE));
  }
  if (source === "glider" || source === "both") {
    signals.push(normalizeGliderWebhook(GLIDER_FIXTURE));
  }
  const zg = await scoreSignalsWith0G(signals);
  const event = await buildPanicEvent(signals, {
    zgScore: zg.score,
    zgRationale: zg.rationale,
    zgShouldPanic: zg.shouldPanic,
  });
  if (!event) {
    logger.error("panic policy rejected simulation", { zg });
    process.exit(1);
  }
  const added = await enqueuePanic(event);
  console.log(JSON.stringify({ added, event, zg }, null, 2));
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === "-h" || cmd === "--help") usage();

  logger.info("executor", {
    cmd,
    mode: getConfig().EXECUTION_MODE,
    chainId: getConfig().CHAIN_ID,
  });

  switch (cmd) {
    case "swap":
      await cmdSwap(argv);
      break;
    case "deposit":
      await cmdDeposit(argv);
      break;
    case "withdraw":
      await cmdWithdraw(argv);
      break;
    case "positions":
      await cmdPositions(argv);
      break;
    case "pool-info":
      await cmdPoolInfo(argv);
      break;
    case "queue":
      await printQueue();
      break;
    case "panic-simulate":
      await cmdPanicSimulate(argv);
      break;
    case "panic-once":
      await processOnePanic();
      break;
    case "panic-worker":
      await runPanicWorker();
      break;
    case "chat":
      await cmdChat(argv);
      break;
    default:
      usage();
  }
}

main().catch((err) => {
  logger.error("executor failed", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
