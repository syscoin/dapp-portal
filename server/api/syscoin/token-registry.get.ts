import { createPublicClient, http } from "viem";

import { syscoinTanenbaumBridge, syscoinTanenbaumTokens } from "@/data/syscoin";
import {
  attachSyscoinL1MappingsToL2Tokens,
  attachSyscoinL2MappingsToL1Tokens,
  fetchSyscoinBlockscoutTokens,
  mergeSyscoinTokens,
} from "@/utils/syscoinBlockscout";

// SYSCOIN: server-side cached registry. Blockscout is vanilla and does not
// expose bridge metadata, so the server periodically resolves L1->L2 mappings
// via L2AssetRouter and serves normalized data to clients.
export default defineCachedEventHandler(
  async () => {
    const l2PublicClient = createPublicClient({
      chain: {
        id: syscoinTanenbaumBridge.l2ChainId,
        name: "Syscoin Tanenbaum zksys",
        nativeCurrency: { name: "Tanenbaum Syscoin", symbol: "TSYS", decimals: 18 },
        rpcUrls: {
          default: { http: [syscoinTanenbaumBridge.l2RpcUrl] },
        },
      },
      transport: http(syscoinTanenbaumBridge.l2RpcUrl),
    });

    const [l1BlockscoutTokens, l2BlockscoutTokens] = await Promise.all([
      fetchSyscoinBlockscoutTokens(syscoinTanenbaumBridge.l1BlockscoutApiUrl, "L1", syscoinTanenbaumTokens),
      fetchSyscoinBlockscoutTokens(syscoinTanenbaumBridge.l2BlockscoutApiUrl, "L2", syscoinTanenbaumTokens),
    ]);

    const mappedL1Tokens = await attachSyscoinL2MappingsToL1Tokens(
      l2PublicClient,
      l1BlockscoutTokens,
      syscoinTanenbaumTokens
    );
    const l1Tokens = mergeSyscoinTokens(
      syscoinTanenbaumTokens.map((token) => ({
        ...token,
        address: token.l1Address || token.address,
      })),
      mappedL1Tokens
    );
    const l2MappedTokens = attachSyscoinL1MappingsToL2Tokens(l2BlockscoutTokens, l1Tokens);
    const l2Tokens = mergeSyscoinTokens(syscoinTanenbaumTokens, l2MappedTokens);

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
