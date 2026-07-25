/**
 * Peg-safe Trading API volume: each cycle = one swap each way with the SAME amount.
 * Run: cd apps/executor && pnpm exec tsx scripts/seed-equal-volume-api.ts
 */
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClients, getConfig, logger } from "@sentinel/core";
import { checkSwapApproval, executeSwap, sendApiTx } from "@sentinel/uniswap";
import { formatUnits, parseAbi, parseUnits } from "viem";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const OUT = resolve(ROOT, "data/sepolia-susd-usdc-volume-api-equal.json");

const USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as const;
const SUSD = "0xC084E80E4E546561f4348198ebfC1fe7b714DB37" as const;
const POOL = "0x68eB6856e570e2c33A7239D0fF8C5d9A77Cecd8b" as const;

const TARGET_VOLUME = 100; // extra API volume on top of contract $500
const AMOUNT_HUMAN = "1";
const AMOUNT = parseUnits(AMOUNT_HUMAN, 6).toString();
const MAX_ABS_TICK = 20;

const poolAbi = parseAbi([
  "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)",
]);
const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
]);

async function main() {
  getConfig();
  const { publicClient, walletClient, address } = createClients({
    requireSigner: true,
  });
  if (!walletClient || !address) throw new Error("signer required");

  for (const token of [USDC, SUSD] as const) {
    const approval = await checkSwapApproval({
      walletAddress: address,
      token,
      amount: AMOUNT,
      chainId: getConfig().CHAIN_ID,
    });
    if (approval) {
      await sendApiTx({
        tx: approval,
        walletClient,
        publicClient,
        dryRun: false,
        label: "swap_approval",
      });
    }
  }

  const readTick = async () =>
    (
      await publicClient.readContract({
        address: POOL,
        abi: poolAbi,
        functionName: "slot0",
      })
    )[1];

  let volume = 0;
  let pairs = 0;
  const txs: string[] = [];
  const started = Date.now();

  console.log({
    pool: POOL,
    via: "Trading API",
    rule: "1 swap each way, same amount",
    amount: AMOUNT_HUMAN,
    target: TARGET_VOLUME,
    startTick: await readTick(),
  });

  while (volume < TARGET_VOLUME) {
    // USDC → sUSD
    const a = await executeSwap({
      params: {
        tokenIn: USDC,
        tokenOut: SUSD,
        amount: AMOUNT,
        swapper: address,
        slippageTolerance: 1,
        routingPreference: "BEST_PRICE",
      },
      walletClient,
      publicClient,
      dryRun: false,
      skipApproval: true,
    });
    if (!a.hash) throw new Error("missing hash A");
    txs.push(a.hash);

    // sUSD → USDC (SAME amount)
    const b = await executeSwap({
      params: {
        tokenIn: SUSD,
        tokenOut: USDC,
        amount: AMOUNT,
        swapper: address,
        slippageTolerance: 1,
        routingPreference: "BEST_PRICE",
      },
      walletClient,
      publicClient,
      dryRun: false,
      skipApproval: true,
    });
    if (!b.hash) throw new Error("missing hash B");
    txs.push(b.hash);

    volume += Number(AMOUNT_HUMAN) * 2;
    pairs += 1;
    const tick = await readTick();
    const usdc = await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address],
    });

    console.log({
      pairs,
      volume,
      tick,
      usdc: formatUnits(usdc, 6),
      routing: `${a.quote.routing}/${b.quote.routing}`,
    });

    if (Math.abs(tick) > MAX_ABS_TICK) {
      throw new Error(`Stopped to protect peg (tick=${tick})`);
    }

    writeFileSync(
      OUT,
      JSON.stringify(
        {
          pool: POOL,
          targetVolume: TARGET_VOLUME,
          achievedVolume: volume,
          pairs,
          txs,
          finalTick: tick,
          elapsedMs: Date.now() - started,
          via: "uniswap-trading-api-equal-swaps",
        },
        null,
        2,
      ),
    );
  }

  console.log("done", {
    pool: POOL,
    volume,
    finalTick: await readTick(),
    pairs,
  });
}

main().catch((err) => {
  logger.error("api equal volume failed", {
    error: err instanceof Error ? err.message : String(err),
  });
  console.error(err);
  process.exit(1);
});
