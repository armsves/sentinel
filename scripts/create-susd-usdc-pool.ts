/**
 * Create Uniswap v3 sUSD/USDC pool on Sepolia and seed liquidity.
 * Run: pnpm exec tsx scripts/create-susd-usdc-pool.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  parseAbi,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as const;
const SUSD = "0xC084E80E4E546561f4348198ebfC1fe7b714DB37" as const;
const FACTORY = "0x0227628f3F023bb0B980b67D528571c95c6DaC1c" as const;
const NPM = "0x1238536071E1c677A632429e3655c799b22cDA52" as const;
const FEE = 500; // 0.05% — stable pair
const LIQUIDITY_AMOUNT = 50_000_000n; // 50 tokens (6 decimals)
// 1:1 price, same decimals → sqrt(1) * 2^96
const SQRT_PRICE_X96 = 79228162514264337593543950336n;
const TICK_LOWER = -887270; // nearest valid full-range for tickSpacing 10
const TICK_UPPER = 887270;

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
  "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
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
  const walletClient = createWalletClient({
    account,
    chain: sepolia,
    transport,
  });

  const [token0, token1] = sortTokens(USDC, SUSD);
  console.log({ account: account.address, token0, token1, fee: FEE });

  let pool = await publicClient.readContract({
    address: FACTORY,
    abi: factoryAbi,
    functionName: "getPool",
    args: [token0, token1, FEE],
  });
  console.log("existing pool", pool);

  if (pool === "0x0000000000000000000000000000000000000000") {
    const hash = await walletClient.writeContract({
      address: FACTORY,
      abi: factoryAbi,
      functionName: "createPool",
      args: [token0, token1, FEE],
    });
    console.log("createPool tx", hash);
    await publicClient.waitForTransactionReceipt({ hash });
    pool = await publicClient.readContract({
      address: FACTORY,
      abi: factoryAbi,
      functionName: "getPool",
      args: [token0, token1, FEE],
    });
    console.log("new pool", pool);
  }

  // initialize if needed
  let initialized = true;
  try {
    await publicClient.readContract({
      address: pool,
      abi: poolAbi,
      functionName: "slot0",
    });
  } catch {
    initialized = false;
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
    console.log("initialize tx", hash);
    await publicClient.waitForTransactionReceipt({ hash });
  } else {
    console.log("already initialized", { sqrtPriceX96: slot0[0].toString(), tick: slot0[1] });
  }

  // approve NPM
  for (const token of [USDC, SUSD]) {
    const allowance = await publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account.address, NPM],
    });
    if (allowance < LIQUIDITY_AMOUNT) {
      const hash = await walletClient.writeContract({
        address: token,
        abi: erc20Abi,
        functionName: "approve",
        args: [NPM, 2n ** 256n - 1n],
      });
      console.log("approve", token, hash);
      await publicClient.waitForTransactionReceipt({ hash });
    }
  }

  const amount0Desired = token0.toLowerCase() === USDC.toLowerCase() ? LIQUIDITY_AMOUNT : LIQUIDITY_AMOUNT;
  const amount1Desired = LIQUIDITY_AMOUNT;

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
  const mintParams = {
    token0,
    token1,
    fee: FEE,
    tickLower: TICK_LOWER,
    tickUpper: TICK_UPPER,
    amount0Desired,
    amount1Desired,
    amount0Min: 0n,
    amount1Min: 0n,
    recipient: account.address,
    deadline,
  };

  const hash = await walletClient.writeContract({
    address: NPM,
    abi: npmAbi,
    functionName: "mint",
    args: [mintParams],
  });
  console.log("mint tx", hash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log("mint status", receipt.status);

  // parse tokenId from logs if possible — Transfer from 0 on NPM
  const liq = await publicClient.readContract({
    address: pool,
    abi: poolAbi,
    functionName: "liquidity",
  });

  const result = {
    susd: SUSD,
    usdc: USDC,
    pool,
    fee: FEE,
    liquidity: liq.toString(),
    mintTx: hash,
    token0,
    token1,
  };
  console.log(JSON.stringify(result, null, 2));
  writeFileSync("data/sepolia-susd-usdc-pool.json", JSON.stringify(result, null, 2));

  // update .env WATCHED_POOLS / PORTFOLIO_TOKENS
  let envText = readFileSync(".env", "utf8");
  if (!envText.includes(SUSD)) {
    envText = envText.replace(
      /^PORTFOLIO_TOKENS=.*$/m,
      (line) => `${line},${SUSD}`,
    );
  }
  if (/^WATCHED_POOLS=\s*$/m.test(envText) || /^WATCHED_POOLS=$/m.test(envText)) {
    envText = envText.replace(/^WATCHED_POOLS=.*$/m, `WATCHED_POOLS=${pool}`);
  } else if (!envText.toLowerCase().includes(pool.toLowerCase())) {
    envText = envText.replace(
      /^WATCHED_POOLS=(.*)$/m,
      (_, cur) => `WATCHED_POOLS=${cur ? `${cur},${pool}` : pool}`,
    );
  }
  if (!/^SUSD_ADDRESS=/m.test(envText)) {
    envText += `\nSUSD_ADDRESS=${SUSD}\nSUSD_USDC_POOL=${pool}\n`;
  }
  writeFileSync(".env", envText);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
