import { $fetch } from "ofetch";
import { utils } from "zksync-ethers";

import { customBridgeTokens } from "@/data/customBridgeTokens";
import { mapApiToken } from "@/utils/mappers";

import type { Api, Token } from "@/types";

export const useZkSyncTokensStore = defineStore("zkSyncTokens", () => {
  const providerStore = useZkSyncProviderStore();
  const walletStore = useZkSyncWalletStore();

  const { eraNetwork } = storeToRefs(providerStore);
  const onboardStore = useOnboardStore();
  const { account } = storeToRefs(onboardStore);

  watch(
    () => account.value.address,
    () => {
      resetTokens();
    }
  );

  const {
    result: tokensRaw,
    inProgress: tokensRequestInProgress,
    error: tokensRequestError,
    execute: requestTokens,
    reset: resetTokens,
  } = usePromise<Token[]>(async () => {
    const provider = await providerStore.requestProvider();
    const ethL2TokenAddress = await provider.l2TokenAddress(utils.ETH_ADDRESS);

    let baseToken: Token | undefined;
    let ethToken: Token | undefined;
    let explorerTokens: Token[] = [];
    let configTokens: Token[] = [];

    if (eraNetwork.value.blockExplorerApi) {
      if (!account.value.address) {
        // If account is not available, we can't fetch individual tokens
        explorerTokens = [];
      } else {
        try {
          console.log("Before the api call::");
          console.log("eraNetwork.value.blockExplorerApi", eraNetwork.value.blockExplorerApi);
          // New Etherscan-compatible API
          const response: Api.Response.AccountTokenBalanceResponse = await $fetch(
            `${eraNetwork.value.blockExplorerApi}/api?module=account&action=addresstokenbalance&address=${account.value.address}`
          );
          console.log("response", response);
          if (response.status === "1" && Array.isArray(response.result)) {
            explorerTokens = response.result.map((item) => ({
              address: item.TokenAddress,
              name: item.TokenName,
              symbol: item.TokenSymbol,
              decimals: Number(item.TokenDivisor),
              iconUrl: item.TokenIconURL || undefined,
              price: item.TokenPriceUSD ? parseFloat(item.TokenPriceUSD) : undefined,
              l1Address: item.l1Address || undefined,
            }));
          } else {
            // Fallback to old API or handle empty result
            explorerTokens = [];
          }
        } catch (error) {
          // Try old API as fallback if the new one fails (or if the URL structure is mixed)
          try {
            let page = 1;
            while (true) {
              const response: Api.Response.Collection<Api.Response.Token> = await $fetch(
                `${eraNetwork.value.blockExplorerApi}/tokens?minLiquidity=0&limit=100&page=${page}`
              );
              explorerTokens = [...explorerTokens, ...response.items.map(mapApiToken)];
              if (response.items.length < 100) break;
              page++;
            }
          } catch (e) {
            console.warn("Failed to fetch tokens from both APIs", e);
          }
        }
      }
      if (explorerTokens.length > 0) {
        baseToken = explorerTokens.find((token) => token.address.toUpperCase() === L2_BASE_TOKEN_ADDRESS.toUpperCase());
        ethToken = explorerTokens.find((token) => token.address.toUpperCase() === ethL2TokenAddress.toUpperCase());
      }
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

    // TODO: @zksyncos add helper for retrieving base token address for chainID
    if (!baseToken) {
      const l1VoidSigner = await walletStore.getL1VoidSigner(true);
      const baseTokenAddress = await l1VoidSigner.getBaseToken();
      baseToken =
        baseTokenAddress === L2_BASE_TOKEN_ADDRESS
          ? {
            address: L2_BASE_TOKEN_ADDRESS,
            l1Address: utils.ETH_ADDRESS,
            symbol: "ETH",
            name: "Ether",
            decimals: 18,
            iconUrl: "/img/eth.svg",
            isETH: true,
          }
          : {
            address: L2_BASE_TOKEN_ADDRESS,
            l1Address: baseTokenAddress,
            symbol: "BASETOKEN",
            name: "Base Token",
            decimals: 18,
            iconUrl: "/img/base.svg",
            isETH: false,
          };
    }
    if (!ethToken && !baseToken.isETH) {
      ethToken = {
        address: ethL2TokenAddress,
        l1Address: utils.ETH_ADDRESS,
        symbol: "ETH",
        name: "Ether",
        decimals: 18,
        iconUrl: "/img/eth.svg",
      };
    }

    const tokensListToUse = explorerTokens.length ? explorerTokens : configTokens;
    const nonBaseOrEthExplorerTokens = tokensListToUse.filter(
      (token) => token.address !== L2_BASE_TOKEN_ADDRESS && token.address !== ethL2TokenAddress
    );
    const finalTokensList = [baseToken, ethToken, ...nonBaseOrEthExplorerTokens].filter(Boolean) as Token[];
    return finalTokensList;
  });

  const tokens = computed<{ [tokenAddress: string]: Token } | undefined>(() => {
    if (!tokensRaw.value) return undefined;
    const list = Object.fromEntries(tokensRaw.value.map((token) => [token.address, token]));
    return list;
  });
  const l1Tokens = computed<{ [tokenAddress: string]: Token } | undefined>(() => {
    if (!tokensRaw.value) return undefined;
    const list = Object.fromEntries(
      tokensRaw.value
        .filter((e) => e.l1Address)
        .map((token) => {
          const customBridgeToken = customBridgeTokens.find(
            (e) => eraNetwork.value.l1Network?.id === e.chainId && token.l1Address === e.l1Address
          );
          const name = customBridgeToken?.name || token.name;
          const symbol = customBridgeToken?.symbol || token.symbol;
          return [token.l1Address!, { ...token, name, symbol, l1Address: undefined, address: token.l1Address! }];
        })
    );
    return list;
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
    resetTokens,
  };
});
