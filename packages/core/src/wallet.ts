import {
  createPublicClient,
  createWalletClient,
  http,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  mainnet,
  arbitrum,
  base,
  optimism,
  polygon,
  sepolia,
  unichain,
} from "viem/chains";
import { getConfig } from "./config.js";

const CHAINS: Record<number, Chain> = {
  [mainnet.id]: mainnet,
  [arbitrum.id]: arbitrum,
  [base.id]: base,
  [optimism.id]: optimism,
  [polygon.id]: polygon,
  [sepolia.id]: sepolia,
  [unichain.id]: unichain,
};

export function getChain(chainId = getConfig().CHAIN_ID): Chain {
  const chain = CHAINS[chainId];
  if (!chain) {
    throw new Error(`Unsupported CHAIN_ID=${chainId}`);
  }
  return chain;
}

export function createClients(opts?: {
  requireSigner?: boolean;
}): {
  publicClient: PublicClient<Transport, Chain>;
  walletClient?: WalletClient<Transport, Chain, Account>;
  account?: Account;
  address?: `0x${string}`;
} {
  const cfg = getConfig();
  const chain = getChain(cfg.CHAIN_ID);
  const transport = http(cfg.RPC_URL);
  const publicClient = createPublicClient({ chain, transport });

  const pk = cfg.PRIVATE_KEY?.trim();
  if (!pk) {
    if (opts?.requireSigner) {
      throw new Error("PRIVATE_KEY is required for signing");
    }
    const address = cfg.WALLET_ADDRESS
      ? (cfg.WALLET_ADDRESS as `0x${string}`)
      : undefined;
    return { publicClient, address };
  }

  const account = privateKeyToAccount(
    (pk.startsWith("0x") ? pk : `0x${pk}`) as Hex,
  );
  const walletClient = createWalletClient({
    account,
    chain,
    transport,
  });

  return {
    publicClient,
    walletClient,
    account,
    address: account.address,
  };
}
