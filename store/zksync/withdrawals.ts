import { $fetch } from "ofetch";
import { getAddress, isAddressEqual, type Address, type Hex } from "viem";

import { customBridgeTokens } from "@/data/customBridgeTokens";
import { L2_ASSET_ROUTER_ADDRESS, L2_BASE_TOKEN_ADDRESS } from "@/utils/constants";
import {
  SYSCOIN_L1_NULLIFIER_ABI,
  getSyscoinFinalizeWithdrawalParams,
  isSyscoinBridgeNetwork,
  parseSyscoinAssetRouterWithdrawalMessage,
  parseSyscoinBaseTokenWithdrawalMessage,
} from "@/utils/syscoinBridge";

import type { Api, TokenAmount } from "@/types";

const FETCH_TIME_LIMIT = 31 * 24 * 60 * 60 * 1000; // 31 days
const SYSCOIN_BLOCKSCOUT_WITHDRAWAL_FETCH_CACHE_MS = 60 * 1000;

type SyscoinBlockscoutTransaction = {
  hash: Hex;
  result?: string | null;
  status?: string | null;
  timestamp: string;
  from?: { hash: Address } | null;
  to?: { hash: Address } | null;
};
type SyscoinBlockscoutTransactionsResponse = {
  items: SyscoinBlockscoutTransaction[];
  next_page_params?: Record<string, string | number | boolean | null> | null;
};
type SyscoinBlockscoutTransactionsCache = {
  key: string;
  fetchedAt: number;
  items: SyscoinBlockscoutTransaction[];
};

const SYSCOIN_BLOCKSCOUT_WITHDRAWAL_FETCH_MAX_PAGES = 20;

export const useZkSyncWithdrawalsStore = defineStore("zkSyncWithdrawals", () => {
  const onboardStore = useOnboardStore();
  const providerStore = useZkSyncProviderStore();
  const transactionStatusStore = useZkSyncTransactionStatusStore();
  const { account, isConnected } = storeToRefs(onboardStore);
  const { eraNetwork } = storeToRefs(providerStore);
  const { userTransactions } = storeToRefs(transactionStatusStore);
  const { destinations } = storeToRefs(useDestinationsStore());
  let syscoinBlockscoutTransactionsCache: SyscoinBlockscoutTransactionsCache | undefined;

  const fetchSyscoinBlockscoutTransactions = async (baseUrl: URL, cacheKey: string) => {
    const now = Date.now();
    if (
      syscoinBlockscoutTransactionsCache?.key === cacheKey &&
      now - syscoinBlockscoutTransactionsCache.fetchedAt < SYSCOIN_BLOCKSCOUT_WITHDRAWAL_FETCH_CACHE_MS
    ) {
      return syscoinBlockscoutTransactionsCache.items;
    }

    const items: SyscoinBlockscoutTransaction[] = [];
    let nextPageParams: SyscoinBlockscoutTransactionsResponse["next_page_params"] = {};
    const seenPageCursors = new Set<string>();
    for (let page = 0; page < SYSCOIN_BLOCKSCOUT_WITHDRAWAL_FETCH_MAX_PAGES && nextPageParams !== null; page++) {
      const url = new URL(baseUrl.toString());
      for (const [key, value] of Object.entries(nextPageParams ?? {})) {
        url.searchParams.set(key, value == null ? "" : String(value));
      }

      const cursor = url.searchParams.toString();
      if (seenPageCursors.has(cursor)) break;
      seenPageCursors.add(cursor);

      const response: SyscoinBlockscoutTransactionsResponse = await $fetch(url.toString());
      items.push(...response.items);
      const oldestTx = response.items[response.items.length - 1];
      if (oldestTx && new Date(oldestTx.timestamp).getTime() < Date.now() - FETCH_TIME_LIMIT) break;
      nextPageParams = response.next_page_params ?? null;
    }

    syscoinBlockscoutTransactionsCache = {
      key: cacheKey,
      fetchedAt: now,
      items,
    };
    return items;
  };

  const findSyscoinWithdrawalToken = (l1Token: Address): Omit<TokenAmount, "amount"> | undefined => {
    const network = eraNetwork.value;
    if (!isSyscoinBridgeNetwork(network)) return undefined;

    const officialToken = (network.syscoinBridge.officialTokens ?? []).find(
      (token) => token.l1Address && isAddressEqual(getAddress(token.l1Address), l1Token)
    );
    if (officialToken) return officialToken;

    const customToken = customBridgeTokens.find(
      (token) => token.chainId === network.l1Network?.id && isAddressEqual(getAddress(token.l1Address), l1Token)
    );
    if (!customToken) return undefined;

    return {
      address: customToken.l2Address,
      l1Address: customToken.l1Address,
      l2Address: customToken.l2Address,
      symbol: customToken.bridgedSymbol || customToken.symbol,
      name: customToken.name,
      decimals: customToken.decimals,
      iconUrl: customToken.iconUrl,
      l1BridgeAddress: customToken.l1BridgeAddress,
      l2BridgeAddress: customToken.l2BridgeAddress,
    };
  };

  const updateSyscoinWithdrawals = async () => {
    const network = eraNetwork.value;
    if (!isSyscoinBridgeNetwork(network)) return;
    if (!account.value.address) throw new Error("Account is not available");
    const accountAddress = getAddress(account.value.address);

    const blockscoutApiUrl = network.syscoinBridge.l2BlockscoutApiUrl.endsWith("/")
      ? network.syscoinBridge.l2BlockscoutApiUrl
      : `${network.syscoinBridge.l2BlockscoutApiUrl}/`;
    const url = new URL(`addresses/${accountAddress}/transactions`, blockscoutApiUrl);
    const transactions = await fetchSyscoinBlockscoutTransactions(url, `${network.key}:${accountAddress}`);
    const provider = await providerStore.requestProvider();
    const publicClient = onboardStore.getPublicClient();
    const baseToken = (network.syscoinBridge.officialTokens ?? []).find((token) =>
      isAddressEqual(getAddress(token.address), getAddress(L2_BASE_TOKEN_ADDRESS))
    );
    if (!baseToken) throw new Error("Syscoin base token is not configured");

    for (const tx of transactions) {
      if (!tx.hash || !tx.timestamp) continue;
      if (new Date(tx.timestamp).getTime() < Date.now() - FETCH_TIME_LIMIT) break;
      if (tx.result && tx.result !== "success") continue;
      if (tx.status && tx.status !== "ok") continue;
      if (!tx.from?.hash || !isAddressEqual(getAddress(tx.from.hash), accountAddress)) continue;
      if (
        !tx.to?.hash ||
        (!isAddressEqual(getAddress(tx.to.hash), getAddress(L2_BASE_TOKEN_ADDRESS)) &&
          !isAddressEqual(getAddress(tx.to.hash), getAddress(L2_ASSET_ROUTER_ADDRESS)))
      ) {
        continue;
      }

      const transactionFromStorage = transactionStatusStore.getTransaction(tx.hash);
      if (transactionFromStorage?.info.completed) continue;

      let finalizeParams;
      try {
        finalizeParams = await getSyscoinFinalizeWithdrawalParams(provider, tx.hash, network.id);
      } catch (err) {
        if ((err as Error).message.includes("not available yet")) continue;
        throw err;
      }
      if (
        !isAddressEqual(finalizeParams.l2Sender, getAddress(L2_BASE_TOKEN_ADDRESS)) &&
        !isAddressEqual(finalizeParams.l2Sender, getAddress(L2_ASSET_ROUTER_ADDRESS))
      ) {
        continue;
      }

      let parsedWithdrawal: { l1Receiver: Address; amount: bigint };
      let token: Omit<TokenAmount, "amount"> | undefined = baseToken;
      try {
        if (isAddressEqual(finalizeParams.l2Sender, getAddress(L2_BASE_TOKEN_ADDRESS))) {
          parsedWithdrawal = parseSyscoinBaseTokenWithdrawalMessage(finalizeParams.message);
        } else {
          const assetRouterWithdrawal = parseSyscoinAssetRouterWithdrawalMessage(finalizeParams.message);
          token = findSyscoinWithdrawalToken(assetRouterWithdrawal.l1Token);
          if (!token) continue;
          parsedWithdrawal = {
            l1Receiver: assetRouterWithdrawal.l1Receiver,
            amount: assetRouterWithdrawal.amount,
          };
        }
      } catch {
        continue;
      }
      const isFinalized = await publicClient
        .readContract({
          address: network.syscoinBridge.l1NullifierAddress,
          abi: SYSCOIN_L1_NULLIFIER_ABI,
          functionName: "isWithdrawalFinalized",
          args: [finalizeParams.chainId, finalizeParams.l2BatchNumber, finalizeParams.l2MessageIndex],
        })
        .catch(() => false);

      transactionStatusStore.saveTransaction({
        type: "withdrawal",
        transactionHash: tx.hash,
        timestamp: tx.timestamp,
        token: {
          ...token,
          amount: parsedWithdrawal.amount.toString(),
        },
        from: {
          address: getAddress(tx.from.hash),
          destination: destinations.value.era,
        },
        to: {
          address: parsedWithdrawal.l1Receiver,
          destination: destinations.value.ethereum,
        },
        info: {
          expectedCompleteTimestamp: new Date(new Date(tx.timestamp).getTime() + WITHDRAWAL_DELAY).toISOString(),
          completed: isFinalized,
          withdrawalFinalizationAvailable: !isFinalized,
        },
      });
    }
  };

  const updateWithdrawals = async () => {
    if (!isConnected.value) throw new Error("Account is not available");
    if (isSyscoinBridgeNetwork(eraNetwork.value)) {
      await updateSyscoinWithdrawals();
      return;
    }
    if (!eraNetwork.value.blockExplorerApi)
      throw new Error(`Block Explorer API is not available on ${eraNetwork.value.name}`);

    const response: Api.Response.Collection<Api.Response.Transfer> = await $fetch(
      `${eraNetwork.value.blockExplorerApi}/address/${account.value.address}/transfers?type=withdrawal`
    );

    for (const withdrawal of response.items.map(mapApiTransfer)) {
      if (!withdrawal.transactionHash) continue;

      const transactionFromStorage = transactionStatusStore.getTransaction(withdrawal.transactionHash);
      if (transactionFromStorage?.info.completed) continue;

      if (new Date(withdrawal.timestamp).getTime() < Date.now() - FETCH_TIME_LIMIT) break;
      const transactionDetails = await retry(() =>
        providerStore.requestProvider().then((provider) => provider.getTransactionDetails(withdrawal.transactionHash!))
      );

      const withdrawalFinalizationAvailable = transactionDetails.status === "verified";
      const isFinalized = withdrawalFinalizationAvailable
        ? await useZkSyncWalletStore()
            .getL1VoidSigner(true)
            .then((signer) => signer.isWithdrawalFinalized(withdrawal.transactionHash!))
            .catch(() => false)
        : false;

      transactionStatusStore.saveTransaction({
        type: "withdrawal",
        transactionHash: withdrawal.transactionHash,
        timestamp: withdrawal.timestamp,
        token: {
          ...withdrawal.token!,
          amount: withdrawal.amount!,
        },
        from: {
          address: withdrawal.from,
          destination: destinations.value.era,
        },
        to: {
          address: withdrawal.to,
          destination: destinations.value.ethereum,
        },
        info: {
          expectedCompleteTimestamp: new Date(
            new Date(withdrawal.timestamp).getTime() + WITHDRAWAL_DELAY
          ).toISOString(),
          completed: isFinalized,
          withdrawalFinalizationAvailable,
        },
      });
    }
  };

  const withdrawalsAvailableForClaiming = computed(() =>
    userTransactions.value.filter(
      (tx) => tx.type === "withdrawal" && !tx.info.completed && tx.info.withdrawalFinalizationAvailable
    )
  );

  const updateWithdrawalsIfPossible = async () => {
    if (!isConnected.value || (!isSyscoinBridgeNetwork(eraNetwork.value) && !eraNetwork.value.blockExplorerApi)) {
      return;
    }
    await updateWithdrawals();
  };
  const { reset: resetAutoUpdate, stop: stopAutoUpdate } = useInterval(() => {
    updateWithdrawalsIfPossible();
  }, 60_000);

  onboardStore.subscribeOnAccountChange((account) => {
    if (account) {
      resetAutoUpdate();
      updateWithdrawalsIfPossible();
    } else {
      stopAutoUpdate();
    }
  });

  return {
    withdrawalsAvailableForClaiming,
    updateWithdrawals,
    updateWithdrawalsIfPossible,
  };
});
