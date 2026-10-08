import { getAddress, isAddress } from "viem";

import { L2_BASE_TOKEN_ADDRESS } from "../utils/constants";

import type { Token } from "../types";

// SYSCOIN: canonical Tanenbaum bridge constants shared by client config and
// server-side registry caching. SYSCOIN: fresh v32 deployment; v31 was replaced.
export const syscoinTanenbaumBridge = {
  gatewayRpcUrl: "https://rpc-gw.tanenbaum.io",
  l1BlockscoutApiUrl: "https://explorer.tanenbaum.io/api/v2",
  l2BlockscoutApiUrl: "https://explorer-zk.tanenbaum.io/api/v2",
  l2RpcUrl: "https://rpc-zk.tanenbaum.io",
  bridgehubAddress: "0x212816f0d638316beeb6fcd1f7baa03fab3b54a5",
  sharedBridgeAddress: "0x6b3660f2aab5c19c6e8d84dd17d4c840e83e31e3",
  l1NullifierAddress: "0xf9ae1986379c9408d53cf10d6c3dd7228ba74ea4",
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
