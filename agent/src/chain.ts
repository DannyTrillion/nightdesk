import {createPublicClient, createWalletClient, http, defineChain, type Address} from "viem";
import {privateKeyToAccount} from "viem/accounts";

export const robinhoodMainnet = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: {name: "Ether", symbol: "ETH", decimals: 18},
  rpcUrls: {default: {http: ["https://rpc.mainnet.chain.robinhood.com"]}},
  blockExplorers: {default: {name: "Blockscout", url: "https://robinhoodchain.blockscout.com"}},
});

export const robinhoodTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: {name: "Ether", symbol: "ETH", decimals: 18},
  rpcUrls: {default: {http: ["https://rpc.testnet.chain.robinhood.com"]}},
  blockExplorers: {default: {name: "Blockscout", url: "https://explorer.testnet.chain.robinhood.com"}},
});

export const aggregatorAbi = [
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {name: "roundId", type: "uint80"},
      {name: "answer", type: "int256"},
      {name: "startedAt", type: "uint256"},
      {name: "updatedAt", type: "uint256"},
      {name: "answeredInRound", type: "uint80"},
    ],
  },
] as const;

export const marketStateAbi = [
  {
    type: "function",
    name: "attest",
    stateMutability: "nonpayable",
    inputs: [
      {name: "newSession", type: "uint8"},
      {name: "haircutBps", type: "uint16"},
    ],
    outputs: [],
  },
  {type: "function", name: "session", stateMutability: "view", inputs: [], outputs: [{type: "uint8"}]},
  {type: "function", name: "riskHaircutBps", stateMutability: "view", inputs: [], outputs: [{type: "uint16"}]},
  {type: "function", name: "attestedAt", stateMutability: "view", inputs: [], outputs: [{type: "uint64"}]},
] as const;

/// Chainlink feeds on Robinhood Chain mainnet. Source of truth is Chainlink's
/// reference directory; these are the subset the agent samples to infer
/// whether the underlying market is trading.
export const FEEDS: {ticker: string; proxy: Address}[] = [
  {ticker: "GOOGL", proxy: "0xF6f373a037c30F0e5010d854385cA89185AE638b"},
  {ticker: "QQQ", proxy: "0x80901d846d5D7B030F26B480776EE3b29374C2ae"},
  {ticker: "TSM", proxy: "0x874cF94aa8eC88Fd9560094dD065f2fB3E41Fc2F"},
  {ticker: "SGOV", proxy: "0xa0DF4ee0fFf975306345875E3548Fcc519577A11"},
  {ticker: "EWY", proxy: "0xEFdf54610B62A7753Ec30bDc380847c12D32e1D1"},
];

export const HEARTBEAT_SECONDS = 86_400;

export type FeedObservation = {
  ticker: string;
  proxy: Address;
  priceUsd: number;
  updatedAt: number;
  ageSeconds: number;
  pastHeartbeat: boolean;
};

export function readerClient(chain = robinhoodMainnet) {
  return createPublicClient({chain, transport: http()});
}

export function attestorClient(privateKey: `0x${string}`, chain = robinhoodTestnet) {
  return createWalletClient({account: privateKeyToAccount(privateKey), chain, transport: http()});
}

/// Samples every configured feed in one multicall-free batch. Feeds are read
/// individually because Robinhood Chain does not guarantee a multicall3
/// deployment at the canonical address.
export async function observeFeeds(client = readerClient()): Promise<FeedObservation[]> {
  const now = Math.floor(Date.now() / 1000);

  return Promise.all(
    FEEDS.map(async ({ticker, proxy}) => {
      const [, answer, , updatedAt] = await client.readContract({
        address: proxy,
        abi: aggregatorAbi,
        functionName: "latestRoundData",
      });
      const updated = Number(updatedAt);
      const ageSeconds = Math.max(0, now - updated);
      return {
        ticker,
        proxy,
        priceUsd: Number(answer) / 1e8, // Robinhood equity feeds are 8 decimals
        updatedAt: updated,
        ageSeconds,
        pastHeartbeat: ageSeconds > HEARTBEAT_SECONDS,
      };
    }),
  );
}
