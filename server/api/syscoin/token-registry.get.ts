import { createPublicClient, http } from "viem";

import { syscoinTanenbaumBridge, syscoinTanenbaumTokens } from "@/data/syscoin";
import {
  attachSyscoinL1MappingsToL2Tokens,
  attachSyscoinL2MappingsToL1Tokens,
  fetchSyscoinBlockscoutTokens,
  mergeSyscoinTokens,
} from "@/utils/syscoinBlockscout";

// SYSCOIN: server-side cached registry. Blockscout is vanilla and does not
// expose bridge metadata, so refreshes resolve registered pairs through both
// NativeTokenVaults. The legacy router is only a Root-native first-deposit fallback.
export default defineCachedEventHandler(
  async () => {
    const l1PublicClient = createPublicClient({
      chain: {
        id: syscoinTanenbaumBridge.l1ChainId,
        name: "Syscoin Tanenbaum",
        nativeCurrency: { name: "Tanenbaum Syscoin", symbol: "TSYS", decimals: 18 },
        rpcUrls: { default: { http: [syscoinTanenbaumBridge.l1RpcUrl] } },
      },
      transport: http(syscoinTanenbaumBridge.l1RpcUrl, { batch: { batchSize: 32 } }),
    });
    const l2PublicClient = createPublicClient({
      chain: {
        id: syscoinTanenbaumBridge.l2ChainId,
        name: "Syscoin Tanenbaum zksys",
        nativeCurrency: { name: "Tanenbaum Syscoin", symbol: "TSYS", decimals: 18 },
        rpcUrls: {
          default: { http: [syscoinTanenbaumBridge.l2RpcUrl] },
        },
      },
      transport: http(syscoinTanenbaumBridge.l2RpcUrl, { batch: { batchSize: 32 } }),
    });

    const [l1BlockscoutTokens, l2BlockscoutTokens] = await Promise.all([
      fetchSyscoinBlockscoutTokens(syscoinTanenbaumBridge.l1BlockscoutApiUrl, "L1", syscoinTanenbaumTokens),
      fetchSyscoinBlockscoutTokens(syscoinTanenbaumBridge.l2BlockscoutApiUrl, "L2", syscoinTanenbaumTokens),
    ]);

    const mappedL1Tokens = await attachSyscoinL2MappingsToL1Tokens(
      l2PublicClient,
      l1BlockscoutTokens,
      syscoinTanenbaumTokens,
      {
        l1PublicClient,
        l1AssetRouterAddress: syscoinTanenbaumBridge.sharedBridgeAddress,
        l1ChainId: syscoinTanenbaumBridge.l1ChainId,
        l2ChainId: syscoinTanenbaumBridge.l2ChainId,
      }
    );
    const l1Tokens = mergeSyscoinTokens(
      syscoinTanenbaumTokens
        .filter((token) => token.l1Address)
        .map((token) => ({
          ...token,
          address: token.l1Address || token.address,
        })),
      mappedL1Tokens
    );
    // Merge metadata first: otherwise a curated L2 token without its new L1
    // wrapper address would discard the freshly resolved mapping.
    const l2Tokens = attachSyscoinL1MappingsToL2Tokens(
      mergeSyscoinTokens(syscoinTanenbaumTokens, l2BlockscoutTokens),
      l1Tokens
    );

    return {
      updatedAt: new Date().toISOString(),
      l1Tokens,
      l2Tokens,
    };
  },
  {
    maxAge: 60 * 60,
    swr: true,
  }
);
