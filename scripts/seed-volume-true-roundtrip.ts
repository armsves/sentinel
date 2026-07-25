/**
 * Peg-safe volume: each round-trip sells USDC then sells back exactly the sUSD received.
 * Optionally re-centers tick before seeding.
 *
 * Run: pnpm exec tsx scripts/seed-volume-true-roundtrip.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
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
const CENTER_CHUNK = 2_000_000n; // $2 while centering
const LEG = 3_000_000n; // $3 per round-trip leg
const MAX_TICK = 40;

const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const poolAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
]);
const routerAbi = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
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

  async function tick() {
    return (
      await publicClient.readContract({
        address: POOL,
        abi: poolAbi,
        functionName: "slot0",
      })
    )[1];
  }

  async function bal(token: `0x${string}`) {
    return publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [me],
    });
  }

  async function swap(
    tokenIn: `0x${string}`,
    tokenOut: `0x${string}`,
    amountIn: bigint,
  ) {
    const hash = await walletClient.writeContract({
      address: ROUTER,
      abi: routerAbi,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn,
          tokenOut,
          fee: FEE,
          recipient: me,
          amountIn,
          amountOutMinimum: 0n,
          sqrtPriceLimitX96: 0n,
        },
      ],
      gas: 450_000n,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`swap failed ${hash}`);
    return hash;
  }

  for (const token of [USDC, SUSD] as const) {
    const a = await publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [me, ROUTER],
    });
    if (a < 10n ** 18n) {
      const hash = await walletClient.writeContract({
        address: token,
        abi: erc20Abi,
        functionName: "approve",
        args: [ROUTER, 2n ** 256n - 1n],
      });
      await publicClient.waitForTransactionReceipt({ hash });
    }
  }

  // Center peg first.
  // token0=USDC, token1=sUSD; price = token1/token0.
  // tick>0 (sUSD expensive in USDC terms? price>1 means more sUSD per USDC):
  //   sell USDC→sUSD to lower price; tick<0: sell sUSD→USDC to raise price.
  let t = await tick();
  console.log({ phase: "center", tick: t, usdc: formatUnits(await bal(USDC), 6) });
  let guard = 0;
  while (Math.abs(t) > 8 && guard < 200) {
    if (t > 0) {
      const u = await bal(USDC);
      const chunk = u < CENTER_CHUNK ? u : CENTER_CHUNK;
      if (chunk === 0n) throw new Error("Need USDC to lower tick");
      await swap(USDC, SUSD, chunk);
    } else {
      await swap(SUSD, USDC, CENTER_CHUNK);
    }
    t = await tick();
    guard += 1;
    if (guard % 5 === 0) console.log({ centering: guard, tick: t });
  }
  console.log({ centeredTick: t });

  let volume = 0;
  const txs: string[] = [];
  const started = Date.now();
  let trips = 0;

  while (volume < TARGET_VOLUME) {
    const usdcBal = await bal(USDC);
    if (usdcBal < LEG) throw new Error("USDC float too low for next leg");

    const susdBefore = await bal(SUSD);
    const h1 = await swap(USDC, SUSD, LEG);
    const susdAfter = await bal(SUSD);
    const gained = susdAfter - susdBefore;
    if (gained <= 0n) throw new Error("no sUSD received");
    const h2 = await swap(SUSD, USDC, gained);

    volume += (Number(LEG) + Number(gained)) / 1e6;
    trips += 1;
    txs.push(h1, h2);
    t = await tick();

    console.log({
      trip: trips,
      volume: Math.min(volume, TARGET_VOLUME),
      tick: t,
      gained: formatUnits(gained, 6),
      usdc: formatUnits(await bal(USDC), 6),
    });

    if (Math.abs(t) > MAX_TICK) {
      console.log("recentering…");
      let g = 0;
      while (Math.abs(t) > 8 && g < 80) {
        if (t > 0) {
          const u = await bal(USDC);
          const chunk = u < CENTER_CHUNK ? u : CENTER_CHUNK;
          if (chunk === 0n) break;
          await swap(USDC, SUSD, chunk);
        } else {
          await swap(SUSD, USDC, CENTER_CHUNK);
        }
        t = await tick();
        g += 1;
      }
      console.log({ recenteredTick: t });
    }

    if (trips % 5 === 0) {
      writeFileSync(
        "data/sepolia-susd-usdc-pool-v2.json",
        JSON.stringify(
          {
            pool: POOL,
            fee: FEE,
            targetVolume: TARGET_VOLUME,
            achievedVolume: volume,
            trips,
            txs,
            finalTick: t,
            elapsedMs: Date.now() - started,
            via: "true-roundtrip",
          },
          null,
          2,
        ),
      );
    }
  }

  t = await tick();
  writeFileSync(
    "data/sepolia-susd-usdc-pool-v2.json",
    JSON.stringify(
      {
        pool: POOL,
        fee: FEE,
        targetVolume: TARGET_VOLUME,
        achievedVolume: volume,
        trips,
        txs,
        finalTick: t,
        elapsedMs: Date.now() - started,
        via: "true-roundtrip",
      },
      null,
      2,
    ),
  );

  // Update env to new pool
  let envText = readFileSync(".env", "utf8");
  envText = envText.replace(/^SUSD_USDC_POOL=.*$/m, `SUSD_USDC_POOL=${POOL}`);
  envText = envText.replace(/^WATCHED_POOLS=.*$/m, `WATCHED_POOLS=${POOL}`);
  writeFileSync(".env", envText);

  console.log("done", { pool: POOL, volume, finalTick: t, trips });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
