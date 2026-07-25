/**
 * Seed Uniswap v3 sUSD/USDC pool volume via alternating swaps (multicall batches).
 * Run: pnpm exec tsx scripts/seed-pool-volume.ts
 *
 * Target: $10,000 notional swap volume (both stables are 6 decimals).
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
const POOL = "0xdc59AE4B4001928355Fa4F578FC24d0090E532f4" as const;
const ROUTER = "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E" as const;
const FEE = 500;
const TARGET_VOLUME = 10_000; // human units
const SWAP_SIZE = 5_000_000n; // 5 tokens — fits ~50 liquidity depth
const SWAPS_PER_BATCH = 40; // 40 * 5 = 200 volume per tx

const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const routerAbi = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
]);
const poolAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
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

  const [liq, slot0, usdcBal, susdBal] = await Promise.all([
    publicClient.readContract({
      address: POOL,
      abi: poolAbi,
      functionName: "liquidity",
    }),
    publicClient.readContract({
      address: POOL,
      abi: poolAbi,
      functionName: "slot0",
    }),
    publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    }),
    publicClient.readContract({
      address: SUSD,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    }),
  ]);

  console.log({
    account: account.address,
    pool: POOL,
    liquidity: liq.toString(),
    tick: slot0[1],
    usdc: formatUnits(usdcBal, 6),
    susd: formatUnits(susdBal, 6),
    target: TARGET_VOLUME,
  });

  for (const token of [USDC, SUSD] as const) {
    const allowance = await publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account.address, ROUTER],
    });
    if (allowance < 10n ** 24n) {
      const hash = await walletClient.writeContract({
        address: token,
        abi: erc20Abi,
        functionName: "approve",
        args: [ROUTER, 2n ** 256n - 1n],
      });
      console.log("approve", token, hash);
      await publicClient.waitForTransactionReceipt({ hash });
    }
  }

  // Bootstrap USDC inventory if needed (swap sUSD → USDC once).
  let usdc = await publicClient.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  });
  if (usdc < SWAP_SIZE) {
    const hash = await walletClient.writeContract({
      address: ROUTER,
      abi: routerAbi,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: SUSD,
          tokenOut: USDC,
          fee: FEE,
          recipient: account.address,
          amountIn: SWAP_SIZE * 2n,
          amountOutMinimum: 0n,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    console.log("bootstrap sUSD→USDC", hash);
    await publicClient.waitForTransactionReceipt({ hash });
    usdc = await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    });
    console.log("usdc after bootstrap", formatUnits(usdc, 6));
  }

  let volume = 0;
  let batches = 0;
  const started = Date.now();

  while (volume < TARGET_VOLUME) {
    const calls: Hex[] = [];
    // Start with whichever side we can fund; alternate so price stays near 1:1.
    let nextInIsUsdc = usdc >= SWAP_SIZE;
    for (let i = 0; i < SWAPS_PER_BATCH; i++) {
      if (nextInIsUsdc) {
        calls.push(encodeSwap(USDC, SUSD, account.address, SWAP_SIZE));
      } else {
        calls.push(encodeSwap(SUSD, USDC, account.address, SWAP_SIZE));
      }
      nextInIsUsdc = !nextInIsUsdc;
    }

    const hash = await walletClient.writeContract({
      address: ROUTER,
      abi: routerAbi,
      functionName: "multicall",
      args: [calls],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`batch failed: ${hash}`);
    }

    const batchVolume = Number(SWAP_SIZE) * SWAPS_PER_BATCH / 1e6;
    volume += batchVolume;
    batches += 1;

    usdc = await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    });
    const susd = await publicClient.readContract({
      address: SUSD,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    });
    const tick = (
      await publicClient.readContract({
        address: POOL,
        abi: poolAbi,
        functionName: "slot0",
      })
    )[1];

    console.log({
      batch: batches,
      tx: hash,
      volume: Math.min(volume, TARGET_VOLUME),
      usdc: formatUnits(usdc, 6),
      susd: formatUnits(susd, 6),
      tick,
    });

    if (usdc < SWAP_SIZE) {
      // Re-seed USDC from sUSD if inventory drifted.
      const seed = await walletClient.writeContract({
        address: ROUTER,
        abi: routerAbi,
        functionName: "exactInputSingle",
        args: [
          {
            tokenIn: SUSD,
            tokenOut: USDC,
            fee: FEE,
            recipient: account.address,
            amountIn: SWAP_SIZE * 3n,
            amountOutMinimum: 0n,
            sqrtPriceLimitX96: 0n,
          },
        ],
      });
      await publicClient.waitForTransactionReceipt({ hash: seed });
      volume += Number(SWAP_SIZE * 3n) / 1e6;
      usdc = await publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [account.address],
      });
      console.log("reseed USDC", formatUnits(usdc, 6), "volume", volume);
    }
  }

  const result = {
    pool: POOL,
    targetVolume: TARGET_VOLUME,
    achievedVolume: volume,
    batches,
    elapsedMs: Date.now() - started,
  };
  writeFileSync("data/sepolia-susd-usdc-volume.json", JSON.stringify(result, null, 2));
  console.log("done", result);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
