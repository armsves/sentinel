/**
 * Continue peg-safe $500 volume on the fee-100 USDC/sUSD pool.
 * Each batch: small round-trips, then a corrective swap to pull tick toward 0.
 *
 * Run: pnpm exec tsx scripts/seed-volume-peg-safe.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatUnits,
  http,
  parseAbi,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as const;
const SUSD = "0xC084E80E4E546561f4348198ebfC1fe7b714DB37" as const;
const ROUTER = "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E" as const;
const POOL = "0x1f897E1588B8923537F5f42b22Affea73D5D508a" as const;
const FEE = 100;

const TARGET_VOLUME = 500;
const SWAP_SIZE = 500_000n; // $0.50
// Return leg slightly smaller to offset 0.01% fee so we don't net-sell sUSD
const RETURN_SIZE = 499_900n;
const ROUND_TRIPS_PER_BATCH = 4; // $4 volume / batch
const MAX_TICK = 30;
const CORRECT_SIZE = 200_000n; // $0.20 corrective

const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const poolAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
]);
const routerAbi = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
]);

function loadEnv() {
  const env: Record<string, string> = {};
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    env[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return env;
}

function encodeSwap(
  tokenIn: `0x${string}`,
  tokenOut: `0x${string}`,
  recipient: `0x${string}`,
  amountIn: bigint,
) {
  return encodeFunctionData({
    abi: routerAbi,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn,
        tokenOut,
        fee: FEE,
        recipient,
        amountIn,
        amountOutMinimum: 0n,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
}

async function main() {
  const env = loadEnv();
  let pk = env.PRIVATE_KEY;
  if (!pk.startsWith("0x")) pk = `0x${pk}`;
  const account = privateKeyToAccount(pk as Hex);
  const transport = http(env.RPC_URL);
  const publicClient = createPublicClient({ chain: sepolia, transport });
  const walletClient = createWalletClient({
    account,
    chain: sepolia,
    transport,
  });
  const me = account.address;

  for (const token of [USDC, SUSD] as const) {
    const allowance = await publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [me, ROUTER],
    });
    if (allowance < 10n ** 18n) {
      const hash = await walletClient.writeContract({
        address: token,
        abi: erc20Abi,
        functionName: "approve",
        args: [ROUTER, 2n ** 256n - 1n],
      });
      await publicClient.waitForTransactionReceipt({ hash });
    }
  }

  let volume = 0;
  try {
    const prev = JSON.parse(
      readFileSync("data/sepolia-susd-usdc-pool-v2.json", "utf8"),
    );
    volume = Number(prev.achievedVolume ?? 0);
  } catch {
    /* fresh */
  }

  let batches = 0;
  const txs: string[] = [];
  const started = Date.now();

  const liq = await publicClient.readContract({
    address: POOL,
    abi: poolAbi,
    functionName: "liquidity",
  });
  console.log({
    pool: POOL,
    liquidity: liq.toString(),
    resumeVolume: volume,
    target: TARGET_VOLUME,
  });

  while (volume < TARGET_VOLUME) {
    const calls: Hex[] = [];
    for (let i = 0; i < ROUND_TRIPS_PER_BATCH; i++) {
      calls.push(encodeSwap(USDC, SUSD, me, SWAP_SIZE));
      calls.push(encodeSwap(SUSD, USDC, me, RETURN_SIZE));
    }

    // Corrective legs toward tick 0
    let tick = (
      await publicClient.readContract({
        address: POOL,
        abi: poolAbi,
        functionName: "slot0",
      })
    )[1];
    if (tick > 5) {
      // price too high → sell sUSD
      calls.push(encodeSwap(SUSD, USDC, me, CORRECT_SIZE));
    } else if (tick < -5) {
      calls.push(encodeSwap(USDC, SUSD, me, CORRECT_SIZE));
    }

    const hash = await walletClient.writeContract({
      address: ROUTER,
      abi: routerAbi,
      functionName: "multicall",
      args: [calls],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`batch failed ${hash}`);

    const batchVol =
      (Number(SWAP_SIZE + RETURN_SIZE) / 1e6) * ROUND_TRIPS_PER_BATCH +
      (tick > 5 || tick < -5 ? Number(CORRECT_SIZE) / 1e6 : 0);
    volume += batchVol;
    batches += 1;
    txs.push(hash);

    tick = (
      await publicClient.readContract({
        address: POOL,
        abi: poolAbi,
        functionName: "slot0",
      })
    )[1];

    const [usdc, susd] = await Promise.all([
      publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [me],
      }),
      publicClient.readContract({
        address: SUSD,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [me],
      }),
    ]);

    console.log({
      batch: batches,
      volume: Math.min(volume, TARGET_VOLUME),
      tick,
      usdc: formatUnits(usdc, 6),
      susd: formatUnits(susd, 6),
      tx: hash,
    });

    if (Math.abs(tick) > MAX_TICK) {
      // Extra solo correction
      const fixCalls: Hex[] =
        tick > 0
          ? [encodeSwap(SUSD, USDC, me, CORRECT_SIZE * 2n)]
          : [encodeSwap(USDC, SUSD, me, CORRECT_SIZE * 2n)];
      const fixHash = await walletClient.writeContract({
        address: ROUTER,
        abi: routerAbi,
        functionName: "multicall",
        args: [fixCalls],
      });
      await publicClient.waitForTransactionReceipt({ hash: fixHash });
      volume += Number(CORRECT_SIZE * 2n) / 1e6;
      tick = (
        await publicClient.readContract({
          address: POOL,
          abi: poolAbi,
          functionName: "slot0",
        })
      )[1];
      console.log({ correctedTick: tick, fixHash });
      if (Math.abs(tick) > MAX_TICK * 3) {
        throw new Error(`Cannot restore peg (tick=${tick})`);
      }
    }

    writeFileSync(
      "data/sepolia-susd-usdc-pool-v2.json",
      JSON.stringify(
        {
          pool: POOL,
          fee: FEE,
          targetVolume: TARGET_VOLUME,
          achievedVolume: volume,
          batches,
          txs,
          finalTick: tick,
          elapsedMs: Date.now() - started,
          via: "swaprouter-peg-safe",
        },
        null,
        2,
      ),
    );
  }

  const finalTick = (
    await publicClient.readContract({
      address: POOL,
      abi: poolAbi,
      functionName: "slot0",
    })
  )[1];
  console.log("done", {
    pool: POOL,
    volume,
    finalTick,
    batches,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
