/**
 * Deploy Sentinel USDT, create pegged sUSD/USDT Uniswap v3 pool on Sepolia,
 * seed TVL (LP NFT sent to a vault — NOT the hot wallet), and seed equal
 * round-trip volume so the pool stays near 1:1.
 *
 * Run: pnpm exec tsx scripts/create-susd-usdt-exit-pool.ts
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatUnits,
  http,
  parseAbi,
  type Hex,
  type Abi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const SUSD = "0xC084E80E4E546561f4348198ebfC1fe7b714DB37" as const;
/** Uniswap v3 Sepolia */
const FACTORY = "0x0227628f3F023bb0B980b67D528571c95c6DaC1c" as const;
const NPM = "0x1238536071E1c677A632429e3655c799b22cDA52" as const;
const ROUTER = "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E" as const;

/** Hold LP here so the hot wallet has no open position in this exit pool. */
const LP_VAULT = "0x000000000000000000000000000000000000dEaD" as const;

const FEE = 3000; // 0.3% — matches main watched pool fee tier style
const SQRT_PRICE_X96 = 79228162514264337593543950336n; // 1:1
// fee 3000 → tickSpacing 60
const TICK_LOWER = -887220;
const TICK_UPPER = 887220;

const LP_AMOUNT = 100_000_000n; // 100 tokens each side (6 decimals)
const USDT_INITIAL = 1_000_000_000_000n; // 1,000,000 USDT
const SUSD_MINT_EXTRA = 500_000_000_000n; // 500,000 sUSD if we own the minter

const TARGET_VOLUME = 200; // $200 notional via equal round-trips
const SWAP_AMOUNT = 1_000_000n; // $1 each way
const MAX_ABS_TICK = 20;

const factoryAbi = parseAbi([
  "function getPool(address,address,uint24) view returns (address)",
  "function createPool(address,address,uint24) returns (address)",
]);
const poolAbi = parseAbi([
  "function initialize(uint160 sqrtPriceX96)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  "function liquidity() view returns (uint128)",
]);
const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function mint(address to, uint256 amount)",
  "function owner() view returns (address)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);
const npmAbi = parseAbi([
  "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
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
    env[line.slice(0, i)] = line.slice(i + 1).trim().replace(/^"|"$/g, "");
  }
  return env;
}

function sortTokens(a: `0x${string}`, b: `0x${string}`) {
  return a.toLowerCase() < b.toLowerCase()
    ? ([a, b] as const)
    : ([b, a] as const);
}

function loadUsdtArtifact(): { abi: Abi; bytecode: Hex } {
  execSync("forge build", {
    cwd: resolve("contracts"),
    stdio: "inherit",
  });
  const art = JSON.parse(
    readFileSync(
      resolve("contracts/out/SentinelUSDT.sol/SentinelUSDT.json"),
      "utf8",
    ),
  ) as { abi: Abi; bytecode: { object: string } };
  return {
    abi: art.abi,
    bytecode: art.bytecode.object as Hex,
  };
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

  console.log({ step: "start", me, susd: SUSD, lpVault: LP_VAULT });

  // --- Deploy USDT (or reuse from env / prior run) ---
  let USDT = (env.USDT_ADDRESS || "").trim() as `0x${string}` | "";
  if (USDT && USDT.startsWith("0x") && USDT.length === 42) {
    console.log({ step: "reuse-usdt", usdt: USDT });
  } else {
    const { abi: usdtAbi, bytecode } = loadUsdtArtifact();
    console.log({ step: "deploy-usdt" });
    const deployHash = await walletClient.deployContract({
      abi: usdtAbi,
      bytecode,
      args: [USDT_INITIAL],
    });
    const deployRc = await publicClient.waitForTransactionReceipt({
      hash: deployHash,
    });
    if (deployRc.status !== "success" || !deployRc.contractAddress) {
      throw new Error(`USDT deploy failed ${deployHash}`);
    }
    USDT = deployRc.contractAddress as `0x${string}`;
    console.log({ usdt: USDT, deployTx: deployHash });
  }

  // --- Top up sUSD if we are owner ---
  try {
    const owner = await publicClient.readContract({
      address: SUSD,
      abi: erc20Abi,
      functionName: "owner",
    });
    if (owner.toLowerCase() === me.toLowerCase()) {
      const mintHash = await walletClient.writeContract({
        address: SUSD,
        abi: erc20Abi,
        functionName: "mint",
        args: [me, SUSD_MINT_EXTRA],
      });
      await publicClient.waitForTransactionReceipt({ hash: mintHash });
      console.log({ step: "minted-extra-susd", amount: formatUnits(SUSD_MINT_EXTRA, 6) });
    } else {
      console.log({ step: "skip-susd-mint", owner });
    }
  } catch (err) {
    console.log({
      step: "susd-mint-unavailable",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const balUsdt = await publicClient.readContract({
    address: USDT,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [me],
  });
  const balSusd = await publicClient.readContract({
    address: SUSD,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [me],
  });
  console.log({
    balances: {
      USDT: formatUnits(balUsdt, 6),
      sUSD: formatUnits(balSusd, 6),
    },
  });
  if (balUsdt < LP_AMOUNT + BigInt(TARGET_VOLUME) * 1_000_000n) {
    throw new Error("insufficient USDT for LP + volume");
  }
  if (balSusd < LP_AMOUNT + BigInt(TARGET_VOLUME) * 1_000_000n) {
    throw new Error("insufficient sUSD for LP + volume — mint more sUSD first");
  }

  const [token0, token1] = sortTokens(SUSD, USDT);

  // --- Create + initialize pool ---
  let pool = await publicClient.readContract({
    address: FACTORY,
    abi: factoryAbi,
    functionName: "getPool",
    args: [token0, token1, FEE],
  });
  if (pool === "0x0000000000000000000000000000000000000000") {
    const hash = await walletClient.writeContract({
      address: FACTORY,
      abi: factoryAbi,
      functionName: "createPool",
      args: [token0, token1, FEE],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    pool = await publicClient.readContract({
      address: FACTORY,
      abi: factoryAbi,
      functionName: "getPool",
      args: [token0, token1, FEE],
    });
    console.log({ step: "createPool", pool, tx: hash });
  } else {
    console.log({ step: "pool-exists", pool });
  }

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
    await publicClient.waitForTransactionReceipt({ hash });
    console.log({ step: "initialize", tx: hash });
  } else {
    console.log({
      step: "already-initialized",
      tick: slot0[1],
      sqrtPriceX96: slot0[0].toString(),
    });
  }

  // --- Approve NPM ---
  for (const token of [SUSD, USDT] as const) {
    const allowance = await publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [me, NPM],
    });
    if (allowance < LP_AMOUNT) {
      const hash = await walletClient.writeContract({
        address: token,
        abi: erc20Abi,
        functionName: "approve",
        args: [NPM, 2n ** 256n - 1n],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      console.log({ step: "approve-npm", token });
    }
  }

  // --- Mint LP to vault (hot wallet keeps NO position) ---
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
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
        amount0Desired: LP_AMOUNT,
        amount1Desired: LP_AMOUNT,
        amount0Min: 0n,
        amount1Min: 0n,
        recipient: LP_VAULT,
        deadline,
      },
    ],
  });
  const mintRc = await publicClient.waitForTransactionReceipt({ hash: mintHash });
  if (mintRc.status !== "success") throw new Error(`mint failed ${mintHash}`);
  const liq = await publicClient.readContract({
    address: pool,
    abi: poolAbi,
    functionName: "liquidity",
  });
  console.log({
    step: "mint-lp-to-vault",
    recipient: LP_VAULT,
    liquidity: liq.toString(),
    tx: mintHash,
  });

  // --- Approve router for volume ---
  for (const token of [SUSD, USDT] as const) {
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

  // --- Equal round-trip volume (keeps peg) ---
  let volume = 0;
  let pairs = 0;
  while (volume < TARGET_VOLUME) {
    const s0 = await publicClient.readContract({
      address: pool,
      abi: poolAbi,
      functionName: "slot0",
    });
    const tick = Number(s0[1]);
    if (Math.abs(tick) > MAX_ABS_TICK) {
      console.log({ step: "stop-volume-peg-guard", tick, volume });
      break;
    }

    // USDT → sUSD then sUSD → USDT with same amountIn
    const data = [
      encodeSwap(USDT, SUSD, me, SWAP_AMOUNT),
      encodeSwap(SUSD, USDT, me, SWAP_AMOUNT),
    ];
    const hash = await walletClient.writeContract({
      address: ROUTER,
      abi: routerAbi,
      functionName: "multicall",
      args: [data],
      gas: 800_000n,
    });
    const rc = await publicClient.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") {
      console.log({ step: "swap-failed", hash });
      break;
    }
    volume += 2; // $1 each way
    pairs += 1;
    if (pairs % 10 === 0 || volume >= TARGET_VOLUME) {
      const s1 = await publicClient.readContract({
        address: pool,
        abi: poolAbi,
        functionName: "slot0",
      });
      console.log({
        step: "volume",
        volume,
        tick: Number(s1[1]),
        pairs,
      });
    }
  }

  const finalSlot = await publicClient.readContract({
    address: pool,
    abi: poolAbi,
    functionName: "slot0",
  });
  const result = {
    usdt: USDT,
    susd: SUSD,
    pool,
    fee: FEE,
    liquidity: liq.toString(),
    lpRecipient: LP_VAULT,
    mintTx: mintHash,
    token0,
    token1,
    achievedVolume: volume,
    targetVolume: TARGET_VOLUME,
    finalTick: Number(finalSlot[1]),
    note: "LP NFT minted to vault — hot wallet has no position; use as sUSD→USDT exit when USDC pool depegs",
  };
  mkdirSync("data", { recursive: true });
  writeFileSync(
    "data/sepolia-susd-usdt-exit-pool.json",
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));

  // --- Update .env (do NOT add this pool to WATCHED_POOLS) ---
  let envText = readFileSync(".env", "utf8");
  if (/^USDT_ADDRESS=/m.test(envText)) {
    envText = envText.replace(/^USDT_ADDRESS=.*$/m, `USDT_ADDRESS=${USDT}`);
  } else {
    envText += `\nUSDT_ADDRESS=${USDT}\n`;
  }
  if (/^SAFE_ASSETS=/m.test(envText)) {
    envText = envText.replace(/^SAFE_ASSETS=.*$/m, `SAFE_ASSETS=USDT,USDC`);
  }
  if (!envText.includes(USDT)) {
    envText = envText.replace(
      /^PORTFOLIO_TOKENS=(.*)$/m,
      (_, cur: string) =>
        `PORTFOLIO_TOKENS=${cur.includes(USDT) ? cur : `${cur},${USDT}`}`,
    );
  }
  if (/^SUSD_USDT_POOL=/m.test(envText)) {
    envText = envText.replace(/^SUSD_USDT_POOL=.*$/m, `SUSD_USDT_POOL=${pool}`);
  } else {
    envText += `SUSD_USDT_POOL=${pool}\n`;
  }
  writeFileSync(".env", envText);
  console.log({
    step: "env-updated",
    USDT_ADDRESS: USDT,
    SUSD_USDT_POOL: pool,
    SAFE_ASSETS: "USDT,USDC",
    watchedPoolsUnchanged: true,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
