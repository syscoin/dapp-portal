import { $fetch } from "ofetch";
import { utils } from "zksync-ethers";

import { customBridgeTokens } from "@/data/customBridgeTokens";
import { syscoinTanenbaumTokens } from "@/data/syscoin";
import { fetchSyscoinTokenRegistry, mergeSyscoinTokens } from "@/utils/syscoinBlockscout";
import { isSyscoinBridgeNetwork } from "@/utils/syscoinBridge";

import type { Api, Token } from "@/types";

export const useZkSyncTokensStore = defineStore("zkSyncTokens", () => {
  const providerStore = useZkSyncProviderStore();
  const { eraNetwork } = storeToRefs(providerStore);
  const syscoinL1TokensRaw = ref<Token[] | undefined>();

  const {
    result: tokensRaw,
    inProgress: tokensRequestInProgress,
    error: tokensRequestError,
    execute: requestTokens,
    reset: resetTokensRaw,
  } = usePromise<Token[]>(async () => {
    if (isSyscoinBridgeNetwork(eraNetwork.value)) {
      // SYSCOIN: global token discovery and L1->L2 mapping resolution are
      // server-cached. The client only renders the normalized registry.
      const registry = await fetchSyscoinTokenRegistry();
      syscoinL1TokensRaw.value = registry.l1Tokens;
      return registry.l2Tokens;
    }
    syscoinL1TokensRaw.value = undefined;

    const provider = await providerStore.requestProvider();
    const ethL2TokenAddress = await provider.l2TokenAddress(utils.ETH_ADDRESS);

    let baseToken = null;
    let ethToken = null;
    let explorerTokens: Token[] = [];
    let configTokens: Token[] = [];

    if (eraNetwork.value.blockExplorerApi) {
      const responses: Api.Response.Collection<Api.Response.Token>[] = await Promise.all([
        $fetch(`${eraNetwork.value.blockExplorerApi}/tokens?minLiquidity=0&limit=100&page=1`),
        $fetch(`${eraNetwork.value.blockExplorerApi}/tokens?minLiquidity=0&limit=100&page=2`),
        $fetch(`${eraNetwork.value.blockExplorerApi}/tokens?minLiquidity=0&limit=100&page=3`),
      ]);
      explorerTokens = responses.map((response) => response.items.map(mapApiToken)).flat();
      baseToken = explorerTokens.find((token) => token.address.toUpperCase() === L2_BASE_TOKEN_ADDRESS.toUpperCase());
      ethToken = explorerTokens.find((token) => token.address.toUpperCase() === ethL2TokenAddress.toUpperCase());
    }

    if (eraNetwork.value.getTokens && (!baseToken || !ethToken)) {
      configTokens = await eraNetwork.value.getTokens();
      if (!baseToken) {
        baseToken = configTokens.find((token) => token.address.toUpperCase() === L2_BASE_TOKEN_ADDRESS.toUpperCase());
      }
      if (!ethToken) {
        ethToken = configTokens.find((token) => token.address.toUpperCase() === ethL2TokenAddress.toUpperCase());
      }
    }

    if (!baseToken) {
      baseToken = {
        address: L2_BASE_TOKEN_ADDRESS,
        l1Address: eraNetwork.value.l1Network ? await provider.getBaseTokenContractAddress() : undefined,
        symbol: "BASETOKEN",
        name: "Base Token",
        decimals: 18,
        iconUrl: "/img/eth.svg",
      };
    }
    if (!ethToken) {
      ethToken = {
        address: ethL2TokenAddress,
        l1Address: utils.ETH_ADDRESS,
        symbol: "ETH",
        name: "Ether",
        decimals: 18,
        iconUrl: "/img/eth.svg",
      };
    }

    const tokens = explorerTokens.length ? explorerTokens : configTokens;
    // SYSCOIN: keep base-token filtering case-insensitive because zkSYS system
    // contract constants are lowercased while registry entries may be checksummed.
    const nonBaseOrEthExplorerTokens = tokens.filter(
      (token) =>
        token.address.toUpperCase() !== L2_BASE_TOKEN_ADDRESS.toUpperCase() &&
        token.address.toUpperCase() !== ethL2TokenAddress.toUpperCase()
    );
    return [
      baseToken,
      ...(ethToken && baseToken.address.toUpperCase() !== ethToken.address.toUpperCase() ? [ethToken] : []),
      ...nonBaseOrEthExplorerTokens,
    ].map((token) => ({
      ...token,
      isETH: token.address.toUpperCase() === ethL2TokenAddress.toUpperCase(),
    }));
  });

  const tokens = computed<{ [tokenAddress: string]: Token } | undefined>(() => {
    if (!tokensRaw.value) return undefined;
    return Object.fromEntries(tokensRaw.value.map((token) => [token.address, token]));
  });
  const l1Tokens = computed<{ [tokenAddress: string]: Token } | undefined>(() => {
    const isSyscoinBridge = isSyscoinBridgeNetwork(eraNetwork.value);
    const sourceTokens =
      isSyscoinBridge && syscoinL1TokensRaw.value
        ? mergeSyscoinTokens(
            syscoinTanenbaumTokens.map((token) => ({
              ...token,
              address: token.l1Address || token.address,
            })),
            syscoinL1TokensRaw.value
          )
        : tokensRaw.value;
    if (!sourceTokens) return undefined;
    return Object.fromEntries(
      sourceTokens
        .filter((e) => e.l1Address && (!isSyscoinBridge || e.isETH || e.l2Address))
        .map((token) => {
          const customBridgeToken = customBridgeTokens.find(
            (e) => eraNetwork.value.l1Network?.id === e.chainId && token.l1Address === e.l1Address
          );
          const name = customBridgeToken?.name || token.name;
          const symbol = customBridgeToken?.symbol || token.symbol;
          return [token.l1Address!, { ...token, name, symbol, l1Address: undefined, address: token.l1Address! }];
        })
    );
  });
  const baseToken = computed<Token | undefined>(() => {
    if (!tokensRaw.value) return undefined;
    return tokensRaw.value.find((token) => token.address.toUpperCase() === L2_BASE_TOKEN_ADDRESS.toUpperCase());
  });
  const ethToken = computed<Token | undefined>(() => {
    if (!tokensRaw.value) return undefined;
    return tokensRaw.value.find((token) => token.isETH);
  });

  return {
    l1Tokens,
    tokens,
    baseToken,
    ethToken,
    tokensRequestInProgress: computed(() => tokensRequestInProgress.value),
    tokensRequestError: computed(() => tokensRequestError.value),
    requestTokens,
    resetTokens: () => {
      syscoinL1TokensRaw.value = undefined;
      resetTokensRaw();
    },
  };
});
