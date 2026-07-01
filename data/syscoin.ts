import { getAddress, isAddress } from "viem";

import { L2_BASE_TOKEN_ADDRESS } from "../utils/constants";

import type { Token } from "../types";

// SYSCOIN: canonical Tanenbaum bridge constants shared by client config and
// server-side registry caching.
export const syscoinTanenbaumBridge = {
  gatewayRpcUrl: "https://rpc-gw.tanenbaum.io",
  l1BlockscoutApiUrl: "https://explorer.tanenbaum.io/api/v2",
  l2BlockscoutApiUrl: "https://explorer-zk.tanenbaum.io/api/v2",
  l2RpcUrl: "https://rpc-zk.tanenbaum.io",
  bridgehubAddress: "0x9ea2670685a2e3534bdaa114e1cb619ea5cf624f",
  sharedBridgeAddress: "0xc769c7b29543393f2e2cb209a07721b62cdd94fa",
  l1NullifierAddress: "0xa7d7381b7fb1ff64600d7a7215ddf2286a1c84ee",
  l2ChainId: 57057,
} as const;

export const SYSCOIN_TANENBAUM_FAUCET_URL = "https://faucet-zk.tanenbaum.io";

export const getSyscoinTanenbaumFaucetUrl = (address?: string) => {
  // SYSCOIN: rollups-faucet accepts an optional `address` query param. Only
  // prefill it after wallet reconnect has produced a valid EVM address.
  if (!address || !isAddress(address)) return SYSCOIN_TANENBAUM_FAUCET_URL;

  const url = new URL(SYSCOIN_TANENBAUM_FAUCET_URL);
  url.searchParams.set("address", getAddress(address));
  return url.toString();
};

export const syscoinTanenbaumTokens: Token[] = [
  {
    address: L2_BASE_TOKEN_ADDRESS,
    l1Address: "0x0000000000000000000000000000000000000000",
    l2Address: L2_BASE_TOKEN_ADDRESS,
    symbol: "TSYS",
    name: "Tanenbaum Syscoin",
    decimals: 18,
    iconUrl: "/img/syscoin-icon.svg",
    isETH: true,
  },
  {
    address: "0x6EBb170f69D886916D9ee9E585CE39E626CbC35d",
    l2Address: "0x6EBb170f69D886916D9ee9E585CE39E626CbC35d",
    symbol: "ZKSYS",
    name: "ZKSYS",
    decimals: 18,
    iconUrl: "/img/zksys-icon.svg",
  },
];
