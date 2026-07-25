/**
 * Seed sUSD/USDC pool volume via Uniswap Trading API (quote → /swap).
 * Run: cd apps/executor && pnpm exec tsx scripts/seed-pool-volume-api.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClients, getConfig, logger } from "@sentinel/core";
import { checkSwapApproval, executeSwap, sendApiTx } from "@sentinel/uniswap";
import { formatUnits, parseAbi, parseUnits } from "viem";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const OUT_FILE = resolve(ROOT, "data/sepolia-susd-usdc-volume-api.json");

const USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as const;
const SUSD = "0xC084E80E4E546561f4348198ebfC1fe7b714DB37" as const;
const POOL = "0xdc59AE4B4001928355Fa4F578FC24d0090E532f4" as const;

const TARGET_VOLUME = 10_000;
const SWAP_HUMAN = "10";
const SWAP_DECIMALS = 6;
const SLIPPAGE = 15;

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
]);

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

type Progress = {
  pool: string;
  targetVolume: number;
  achievedVolume: number;
  swaps: number;
  txs: string[];
  elapsedMs: number;
  via: string;
};

function loadProgress(): Progress | null {
  if (!existsSync(OUT_FILE)) return null;
  try {
    return JSON.parse(readFileSync(OUT_FILE, "utf8")) as Progress;
  } catch {
    return null;
  }
}

async function main() {
  const cfg = getConfig();
  const { publicClient, walletClient, address } = createClients({
    requireSigner: true,
  });
  if (!walletClient || !address) throw new Error("signer required");

  const amount = parseUnits(SWAP_HUMAN, SWAP_DECIMALS).toString();
  const step = Number(SWAP_HUMAN);
  const minBal = parseUnits(SWAP_HUMAN, SWAP_DECIMALS);

  const prev = loadProgress();
  let volume = prev?.achievedVolume ?? 0;
  let swaps = prev?.swaps ?? 0;
  const txs = prev?.txs ?? [];
  let failures = 0;
  let tokenIn: `0x${string}` = SUSD;
  let tokenOut: `0x${string}` = USDC;
  const started = Date.now() - (prev?.elapsedMs ?? 0);

  console.log({
    account: address,
    pool: POOL,
    chainId: cfg.CHAIN_ID,
    target: TARGET_VOLUME,
    resumeFrom: volume,
    swapSize: SWAP_HUMAN,
    mode: "Trading API live (dryRun=false)",
  });

  // One-time approvals for both tokens via Trading API.
  for (const token of [SUSD, USDC] as const) {
    const approval = await checkSwapApproval({
      walletAddress: address,
      token,
      amount,
      chainId: cfg.CHAIN_ID,
    });
    if (approval) {
      await sendApiTx({
        tx: approval,
        walletClient,
        publicClient,
        dryRun: false,
        label: `swap_approval_${token.slice(0, 8)}`,
      });
    }
  }

  while (volume < TARGET_VOLUME) {
    const balIn = await publicClient.readContract({
      address: tokenIn,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address],
    });
    if (balIn < minBal) {
      tokenIn = tokenIn === SUSD ? USDC : SUSD;
      tokenOut = tokenOut === USDC ? SUSD : USDC;
      const retryBal = await publicClient.readContract({
        address: tokenIn,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [address],
      });
      if (retryBal < minBal) {
        throw new Error(
          `Insufficient balance for both sides (need ${SWAP_HUMAN})`,
        );
      }
    }

    try {
      const result = await executeSwap({
        params: {
          tokenIn,
          tokenOut,
          amount,
          swapper: address,
          slippageTolerance: SLIPPAGE,
          routingPreference: "BEST_PRICE",
        },
        walletClient,
        publicClient,
        dryRun: false,
        skipApproval: true,
      });

      if (!result.hash) {
        throw new Error("swap returned no hash (unexpected dry-run?)");
      }
      txs.push(result.hash);
      volume += step;
      swaps += 1;
      failures = 0;

      const [usdc, susd] = await Promise.all([
        publicClient.readContract({
          address: USDC,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [address],
        }),
        publicClient.readContract({
          address: SUSD,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [address],
        }),
      ]);

      console.log({
        swap: swaps,
        routing: result.quote.routing,
        hash: result.hash,
        volume: Math.min(volume, TARGET_VOLUME),
        usdc: formatUnits(usdc, 6),
        susd: formatUnits(susd, 6),
        direction: `${tokenIn === SUSD ? "sUSD" : "USDC"}→${
          tokenOut === USDC ? "USDC" : "sUSD"
        }`,
      });

      const nextIn = tokenOut;
      tokenOut = tokenIn;
      tokenIn = nextIn;

      writeFileSync(
        OUT_FILE,
        JSON.stringify(
          {
            pool: POOL,
            targetVolume: TARGET_VOLUME,
            achievedVolume: volume,
            swaps,
            txs,
            elapsedMs: Date.now() - started,
            via: "uniswap-trading-api",
          } satisfies Progress,
          null,
          2,
        ),
      );

      await sleep(200);
    } catch (err) {
      failures += 1;
      logger.error("api volume swap failed", {
        error: err instanceof Error ? err.message : String(err),
        volume,
        swaps,
        failures,
      });
      if (failures >= 8) {
        throw new Error(`Aborting after ${failures} consecutive failures`);
      }
      const nextIn = tokenOut;
      tokenOut = tokenIn;
      tokenIn = nextIn;
      await sleep(2500);
    }
  }

  console.log("done", {
    pool: POOL,
    targetVolume: TARGET_VOLUME,
    achievedVolume: volume,
    swaps,
    elapsedMs: Date.now() - started,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
