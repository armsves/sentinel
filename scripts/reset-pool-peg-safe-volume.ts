/**
 * 1) Withdraw LP from depegged fee-500 pool
 * 2) Create fresh USDC/sUSD pool (fee 100) at 1:1 with deep liquidity
 * 3) Seed ~$500 volume via SwapRouter multicall with peg-safe round-trips
 *
 * Run: pnpm exec tsx scripts/reset-pool-peg-safe-volume.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatUnits,
  http,
  maxUint128,
  parseAbi,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as const;
const SUSD = "0xC084E80E4E546561f4348198ebfC1fe7b714DB37" as const;
const FACTORY = "0x0227628f3F023bb0B980b67D528571c95c6DaC1c" as const;
const NPM = "0x1238536071E1c677A632429e3655c799b22cDA52" as const;
const ROUTER = "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E" as const;

const OLD_NFT_ID = 230372n;
const NEW_FEE = 100; // 0.01% — new pool (old was 500)
const SQRT_PRICE_X96 = 79228162514264337593543950336n; // 1:1
// fee 100 → tickSpacing 1
const TICK_LOWER = -887272;
const TICK_UPPER = 887272;

const TARGET_VOLUME = 500; // human USD
const SWAP_SIZE = 1_000_000n; // $1 per leg — tiny vs depth
const MAX_TICK_DRIFT = 50; // abort if |tick| exceeds this after a batch
const LP_USDC = 40_000_000n; // $40 depth (matched with sUSD)

const factoryAbi = parseAbi([
  "function getPool(address,address,uint24) view returns (address)",
  "function createPool(address,address,uint24) returns (address)",
]);
const poolAbi = parseAbi([
  "function initialize(uint160 sqrtPriceX96)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
]);
const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const npmAbi = parseAbi([
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline)) payable returns (uint256 amount0, uint256 amount1)",
  "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) payable returns (uint256 amount0, uint256 amount1)",
  "function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
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

function sortTokens(a: `0x${string}`, b: `0x${string}`) {
  return a.toLowerCase() < b.toLowerCase() ? ([a, b] as const) : ([b, a] as const);
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
        fee: NEW_FEE,
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
  const [token0, token1] = sortTokens(USDC, SUSD);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

  console.log({ step: "start", me, token0, token1, newFee: NEW_FEE });

  // --- 1) Withdraw old LP ---
  const pos = await publicClient.readContract({
    address: NPM,
    abi: npmAbi,
    functionName: "positions",
    args: [OLD_NFT_ID],
  });
  const oldLiq = pos[7];
  if (oldLiq > 0n) {
    const calls: Hex[] = [
      encodeFunctionData({
        abi: npmAbi,
        functionName: "decreaseLiquidity",
        args: [
          {
            tokenId: OLD_NFT_ID,
            liquidity: oldLiq,
            amount0Min: 0n,
            amount1Min: 0n,
            deadline,
          },
        ],
      }),
      encodeFunctionData({
        abi: npmAbi,
        functionName: "collect",
        args: [
          {
            tokenId: OLD_NFT_ID,
            recipient: me,
            amount0Max: maxUint128,
            amount1Max: maxUint128,
          },
        ],
      }),
    ];
    const hash = await walletClient.writeContract({
      address: NPM,
      abi: npmAbi,
      functionName: "multicall",
      args: [calls],
    });
    console.log("withdraw LP", hash);
    await publicClient.waitForTransactionReceipt({ hash });
  } else {
    console.log("old LP already empty");
  }

  const usdcAfter = await publicClient.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [me],
  });
  const susdAfter = await publicClient.readContract({
    address: SUSD,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [me],
  });
  console.log({
    afterWithdraw: {
      usdc: formatUnits(usdcAfter, 6),
      susd: formatUnits(susdAfter, 6),
    },
  });

  // --- 2) Create + init new fee-100 pool ---
  let pool = await publicClient.readContract({
    address: FACTORY,
    abi: factoryAbi,
    functionName: "getPool",
    args: [token0, token1, NEW_FEE],
  });
  if (pool === "0x0000000000000000000000000000000000000000") {
    const hash = await walletClient.writeContract({
      address: FACTORY,
      abi: factoryAbi,
      functionName: "createPool",
      args: [token0, token1, NEW_FEE],
    });
    console.log("createPool", hash);
    await publicClient.waitForTransactionReceipt({ hash });
    pool = await publicClient.readContract({
      address: FACTORY,
      abi: factoryAbi,
      functionName: "getPool",
      args: [token0, token1, NEW_FEE],
    });
  }
  console.log("pool", pool);

  const slot0 = await publicClient.readContract({
    address: pool,
    abi: poolAbi,
    functionName: "slot0",
  });
  if (slot0[0] === 0n) {
    const hash = await walletClient.writeContract({
      address: pool,
      abi: poolAbi,
      functionName: "initialize",
      args: [SQRT_PRICE_X96],
    });
    console.log("initialize 1:1", hash);
    await publicClient.waitForTransactionReceipt({ hash });
  } else {
    console.log("already initialized", { tick: slot0[1] });
  }

  // Approvals
  for (const [token, spender] of [
    [USDC, NPM],
    [SUSD, NPM],
    [USDC, ROUTER],
    [SUSD, ROUTER],
  ] as const) {
    const allowance = await publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [me, spender],
    });
    if (allowance < 10n ** 24n) {
      const hash = await walletClient.writeContract({
        address: token,
        abi: erc20Abi,
        functionName: "approve",
        args: [spender, 2n ** 256n - 1n],
      });
      console.log("approve", token.slice(0, 10), "→", spender.slice(0, 10), hash);
      await publicClient.waitForTransactionReceipt({ hash });
    }
  }

  // Mint deep balanced LP (use min of desired and available USDC - keep $5 float for volume)
  const usdcBal = await publicClient.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [me],
  });
  const float = 5_000_000n;
  const lpAmount =
    usdcBal > LP_USDC + float
      ? LP_USDC
      : usdcBal > float
        ? usdcBal - float
        : usdcBal / 2n;
  if (lpAmount < 10_000_000n) {
    throw new Error(`Need more USDC for depth; have ${formatUnits(usdcBal, 6)}`);
  }

  const amount0Desired = token0.toLowerCase() === USDC.toLowerCase() ? lpAmount : lpAmount;
  const amount1Desired = lpAmount;

  const mintHash = await walletClient.writeContract({
    address: NPM,
    abi: npmAbi,
    functionName: "mint",
    args: [
      {
        token0,
        token1,
        fee: NEW_FEE,
        tickLower: TICK_LOWER,
        tickUpper: TICK_UPPER,
        amount0Desired,
        amount1Desired,
        amount0Min: 0n,
        amount1Min: 0n,
        recipient: me,
        deadline,
      },
    ],
  });
  console.log("mint LP", mintHash, "amount", formatUnits(lpAmount, 6));
  const mintReceipt = await publicClient.waitForTransactionReceipt({
    hash: mintHash,
  });
  if (mintReceipt.status !== "success") throw new Error("mint failed");

  const liq = await publicClient.readContract({
    address: pool,
    abi: poolAbi,
    functionName: "liquidity",
  });
  const tick0 = (
    await publicClient.readContract({
      address: pool,
      abi: poolAbi,
      functionName: "slot0",
    })
  )[1];
  console.log({ liquidity: liq.toString(), tick: tick0 });

  // --- 3) Peg-safe volume: each multicall = USDC→sUSD then sUSD→USDC ($2 volume) ---
  let volume = 0;
  let batches = 0;
  const started = Date.now();
  const txs: string[] = [];

  while (volume < TARGET_VOLUME) {
    const calls: Hex[] = [
      encodeSwap(USDC, SUSD, me, SWAP_SIZE),
      encodeSwap(SUSD, USDC, me, SWAP_SIZE),
    ];
    // 10 round-trips per tx = $20 volume, still tiny vs $40 depth
    for (let i = 0; i < 9; i++) {
      calls.push(encodeSwap(USDC, SUSD, me, SWAP_SIZE));
      calls.push(encodeSwap(SUSD, USDC, me, SWAP_SIZE));
    }

    const hash = await walletClient.writeContract({
      address: ROUTER,
      abi: routerAbi,
      functionName: "multicall",
      args: [calls],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`swap batch failed ${hash}`);

    const batchVol = (Number(SWAP_SIZE) / 1e6) * calls.length;
    volume += batchVol;
    batches += 1;
    txs.push(hash);

    const tick = (
      await publicClient.readContract({
        address: pool,
        abi: poolAbi,
        functionName: "slot0",
      })
    )[1];
    console.log({
      batch: batches,
      volume: Math.min(volume, TARGET_VOLUME),
      tick,
      tx: hash,
    });

    if (Math.abs(tick) > MAX_TICK_DRIFT) {
      throw new Error(
        `Peg drift too high (tick=${tick}). Stopping to avoid depeg.`,
      );
    }
  }

  const result = {
    oldNftId: OLD_NFT_ID.toString(),
    pool,
    fee: NEW_FEE,
    liquidity: liq.toString(),
    targetVolume: TARGET_VOLUME,
    achievedVolume: volume,
    batches,
    txs,
    finalTick: (
      await publicClient.readContract({
        address: pool,
        abi: poolAbi,
        functionName: "slot0",
      })
    )[1],
    elapsedMs: Date.now() - started,
    via: "swaprouter-multicall-roundtrips",
  };
  writeFileSync(
    "data/sepolia-susd-usdc-pool-v2.json",
    JSON.stringify(result, null, 2),
  );

  // Update .env watched pool
  let envText = readFileSync(".env", "utf8");
  if (/^SUSD_USDC_POOL=/m.test(envText)) {
    envText = envText.replace(/^SUSD_USDC_POOL=.*$/m, `SUSD_USDC_POOL=${pool}`);
  } else {
    envText += `\nSUSD_USDC_POOL=${pool}\n`;
  }
  if (/^WATCHED_POOLS=/m.test(envText)) {
    envText = envText.replace(/^WATCHED_POOLS=.*$/m, `WATCHED_POOLS=${pool}`);
  }
  writeFileSync(".env", envText);

  console.log("done", result);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
