/**
 * Initialize fee-3000 pool at 1:1, mint deep LP, seed $500 with equal opposite swaps.
 * Assumes LP already withdrawn and pool 0x68eB... already created.
 *
 * Rule: each pair = ONE swap each direction with IDENTICAL amountIn.
 * Run: pnpm exec tsx scripts/init-and-equal-volume.ts
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
const NPM = "0x1238536071E1c677A632429e3655c799b22cDA52" as const;
const ROUTER = "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E" as const;
const POOL = "0x68eB6856e570e2c33A7239D0fF8C5d9A77Cecd8b" as const;

const FEE = 3000;
const SQRT_PRICE_X96 = 79228162514264337593543950336n;
const TICK_LOWER = -887220;
const TICK_UPPER = 887220;
const TARGET_VOLUME = 500;
const AMOUNT = 1_000_000n; // identical both ways
const MAX_ABS_TICK = 20;

const poolAbi = parseAbi([
  "function initialize(uint160 sqrtPriceX96)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  "function liquidity() view returns (uint128)",
]);
const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const npmAbi = parseAbi([
  "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256,uint128,uint256,uint256)",
]);
const routerAbi = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)",
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

async function main() {
  const env = loadEnv();
  let pk = env.PRIVATE_KEY;
  if (!pk.startsWith("0x")) pk = `0x${pk}`;
  const account = privateKeyToAccount(pk as Hex);
  const transport = http(env.RPC_URL);
  const publicClient = createPublicClient({ chain: sepolia, transport });
  const walletClient = createWalletClient({ account, chain: sepolia, transport });
  const me = account.address;
  const [token0, token1] = sortTokens(USDC, SUSD);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 7200);

  const slot0 = await publicClient.readContract({
    address: POOL,
    abi: poolAbi,
    functionName: "slot0",
  });
  if (slot0[0] === 0n) {
    const hash = await walletClient.writeContract({
      address: POOL,
      abi: poolAbi,
      functionName: "initialize",
      args: [SQRT_PRICE_X96],
      gas: 500_000n,
    });
    const rc = await publicClient.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") throw new Error(`initialize failed ${hash}`);
    console.log("initialized 1:1", hash);
  } else {
    console.log("slot0", { tick: slot0[1], sqrt: slot0[0].toString() });
    if (slot0[1] !== 0) {
      throw new Error(`Pool not at peg (tick=${slot0[1]})`);
    }
  }

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
        gas: 100_000n,
      });
      await publicClient.waitForTransactionReceipt({ hash });
    }
  }

  let liq = await publicClient.readContract({
    address: POOL,
    abi: poolAbi,
    functionName: "liquidity",
  });
  if (liq === 0n) {
    const usdcNow = await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [me],
    });
    const float = 5_000_000n;
    const lpAmount =
      usdcNow > float + 20_000_000n ? usdcNow - float : usdcNow / 2n;
    if (lpAmount < 20_000_000n) {
      throw new Error(`Need >=20 USDC LP, have ${formatUnits(usdcNow, 6)}`);
    }
    const mintHash = await walletClient.writeContract({
      address: NPM,
      abi: npmAbi,
      functionName: "mint",
      args: [
        {
          token0,
          token1,
          fee: FEE,
          tickLower: TICK_LOWER,
          tickUpper: TICK_UPPER,
          amount0Desired: lpAmount,
          amount1Desired: lpAmount,
          amount0Min: 0n,
          amount1Min: 0n,
          recipient: me,
          deadline,
        },
      ],
      gas: 1_000_000n,
    });
    const mintRc = await publicClient.waitForTransactionReceipt({ hash: mintHash });
    if (mintRc.status !== "success") throw new Error(`mint failed ${mintHash}`);
    liq = await publicClient.readContract({
      address: POOL,
      abi: poolAbi,
      functionName: "liquidity",
    });
    console.log({ minted: formatUnits(lpAmount, 6), liquidity: liq.toString() });
  } else {
    console.log({ existingLiquidity: liq.toString() });
  }

  const encodeSwap = (tokenIn: `0x${string}`, tokenOut: `0x${string}`) =>
    encodeFunctionData({
      abi: routerAbi,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn,
          tokenOut,
          fee: FEE,
          recipient: me,
          amountIn: AMOUNT,
          amountOutMinimum: 0n,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });

  let volume = 0;
  let pairs = 0;
  const txs: string[] = [];
  const started = Date.now();

  console.log({
    rule: "exactly 1 swap each way, same amountIn",
    amount: formatUnits(AMOUNT, 6),
    target: TARGET_VOLUME,
  });

  while (volume < TARGET_VOLUME) {
    // Pair: USDC→sUSD then sUSD→USDC, SAME amount
    const hash = await walletClient.writeContract({
      address: ROUTER,
      abi: routerAbi,
      functionName: "multicall",
      args: [[encodeSwap(USDC, SUSD), encodeSwap(SUSD, USDC)]],
      gas: 600_000n,
    });
    const rc = await publicClient.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") throw new Error(`pair failed ${hash}`);
    volume += (Number(AMOUNT) * 2) / 1e6;
    pairs += 1;
    txs.push(hash);

    let tick = (
      await publicClient.readContract({
        address: POOL,
        abi: poolAbi,
        functionName: "slot0",
      })
    )[1];

    if (volume < TARGET_VOLUME) {
      // Next pair starts opposite side, still same amount each way
      const hash2 = await walletClient.writeContract({
        address: ROUTER,
        abi: routerAbi,
        functionName: "multicall",
        args: [[encodeSwap(SUSD, USDC), encodeSwap(USDC, SUSD)]],
        gas: 600_000n,
      });
      const rc2 = await publicClient.waitForTransactionReceipt({ hash: hash2 });
      if (rc2.status !== "success") throw new Error(`pair2 failed ${hash2}`);
      volume += (Number(AMOUNT) * 2) / 1e6;
      pairs += 1;
      txs.push(hash2);
      tick = (
        await publicClient.readContract({
          address: POOL,
          abi: poolAbi,
          functionName: "slot0",
        })
      )[1];
    }

    const [u, s] = await Promise.all([
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
      pairs,
      volume: Math.min(volume, TARGET_VOLUME),
      tick,
      usdc: formatUnits(u, 6),
    });

    if (Math.abs(tick) > MAX_ABS_TICK) {
      throw new Error(`Stopped to protect peg (tick=${tick})`);
    }

    writeFileSync(
      "data/sepolia-susd-usdc-pool-v3.json",
      JSON.stringify(
        {
          pool: POOL,
          fee: FEE,
          targetVolume: TARGET_VOLUME,
          achievedVolume: volume,
          pairs,
          txs,
          finalTick: tick,
          elapsedMs: Date.now() - started,
          via: "equal-amount-opposite-swaps",
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

  let envText = readFileSync(".env", "utf8");
  if (/^SUSD_USDC_POOL=/m.test(envText)) {
    envText = envText.replace(/^SUSD_USDC_POOL=.*$/m, `SUSD_USDC_POOL=${POOL}`);
  } else {
    envText += `\nSUSD_USDC_POOL=${POOL}\n`;
  }
  envText = envText.replace(/^WATCHED_POOLS=.*$/m, `WATCHED_POOLS=${POOL}`);
  writeFileSync(".env", envText);

  console.log("done", { pool: POOL, volume, finalTick, pairs });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
