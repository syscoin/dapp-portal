import usePaginatedRequest from "@/composables/zksync/usePaginatedRequest";
import { isSyscoinBridgeNetwork } from "@/utils/syscoinBridge";

import type { TransactionInfo } from "@/store/zksync/transactionStatus";
import type { Api } from "@/types";

const TRANSACTIONS_FETCH_LIMIT = 50;

export const useZkSyncTransfersHistoryStore = defineStore("zkSyncTransfersHistory", () => {
  const onboardStore = useOnboardStore();
  const transactionStatusStore = useZkSyncTransactionStatusStore();
  const { eraNetwork } = storeToRefs(useZkSyncProviderStore());
  const { account } = storeToRefs(onboardStore);
  const { userTransactions } = storeToRefs(transactionStatusStore);

  const filterOutDuplicateTransfers = (transfers: Transfer[]) => {
    /*
      Currently BE API Deposit and Withdrawal transaction generate 2 logs:
        1 "transfer" and 1 "deposit" / "withdrawal" depending on the type of the transaction.
      We want to remove the "transfer" from the list for user convenience.
    */
    const transactions = transfers.reduce((acc, transfer) => {
      if (!transfer.transactionHash) {
        return acc;
      }
      if (!acc[transfer.transactionHash]) {
        acc[transfer.transactionHash] = [];
      }
      acc[transfer.transactionHash].push(transfer);
      return acc;
    }, {} as Record<string, Transfer[]>);

    const filteredTransfers = Object.values(transactions).reduce((acc, transfers) => {
      const transfer = transfers.find((e) => e.type === "transfer");
      const depositOrWithdrawal = transfers.find((e) => e.type === "deposit" || e.type === "withdrawal");
      if (
        transfer &&
        depositOrWithdrawal &&
        depositOrWithdrawal.token?.address === transfer.token?.address &&
        depositOrWithdrawal.amount === transfer.amount &&
        ((depositOrWithdrawal.type === "deposit" && depositOrWithdrawal.to === transfer.to) ||
          (depositOrWithdrawal.type === "withdrawal" && depositOrWithdrawal.from === transfer.from))
      ) {
        acc.push(depositOrWithdrawal);
        return acc;
      }
      acc.push(...transfers);
      return acc;
    }, [] as Transfer[]);
    return filteredTransfers.sort((a, b) => new Date(b.timestamp).valueOf() - new Date(a.timestamp).valueOf());
  };
  const mapLocalBridgeTransaction = (transaction: TransactionInfo): Transfer => {
    return {
      transactionHash:
        transaction.type === "deposit"
          ? transaction.info.toTransactionHash || transaction.transactionHash
          : transaction.transactionHash,
      type: transaction.type,
      from: transaction.from.address,
      to: transaction.to.address,
      fromNetwork: transaction.type === "deposit" ? "L1" : "L2",
      toNetwork: transaction.type === "withdrawal" ? "L1" : "L2",
      amount: transaction.token.amount.toString(),
      token: transaction.token,
      timestamp: transaction.timestamp,
    };
  };

  const getSyscoinCompletedTransfers = () => {
    // SYSCOIN: Blockscout does not expose ZKsync explorer's
    // /address/:addr/transfers API. Use the persisted bridge-operation state
    // that already tracks completion via L1 receipt + L2 receipt polling.
    return userTransactions.value
      .filter((transaction) => transaction.info.completed && !transaction.info.failed)
      .map(mapLocalBridgeTransaction);
  };
  const displayedTransfers = computed(() => {
    if (isSyscoinBridgeNetwork(eraNetwork.value)) {
      return filterOutDuplicateTransfers(getSyscoinCompletedTransfers());
    }
    return transfers.value;
  });
  const refreshSyscoinCompletedTransfers = () => {
    transfers.value = filterOutDuplicateTransfers(getSyscoinCompletedTransfers());
  };
  const refreshSyscoinLocalBridgeTransactions = () => {
    for (const transaction of userTransactions.value.filter(
      (transaction) => !transaction.info.completed || transaction.info.failed
    )) {
      transactionStatusStore
        .refreshSavedTransactionStatus(transaction)
        .then(refreshSyscoinCompletedTransfers)
        .catch(() => undefined);
    }
  };

  const {
    canLoadMore,
    loadNext,
    reset: resetPaginatedRequest,
  } = usePaginatedRequest<Api.Response.Transfer>(() => {
    if (!eraNetwork.value.blockExplorerApi)
      throw new Error(`Block Explorer API is not available on ${eraNetwork.value.name}`);

    const url = new URL(`/address/${account.value.address}/transfers`, eraNetwork.value.blockExplorerApi);
    url.searchParams.set("limit", TRANSACTIONS_FETCH_LIMIT.toString());
    return url;
  });
  const transfers = ref<Transfer[]>([]);

  const {
    inProgress: recentTransfersRequestInProgress,
    error: recentTransfersRequestError,
    execute: requestRecentTransfers,
    reset: resetRecentTransfersRequest,
    reload: reloadRecentTransfers,
  } = usePromise(
    async () => {
      if (isSyscoinBridgeNetwork(eraNetwork.value)) {
        resetPaginatedRequest();
        refreshSyscoinCompletedTransfers();
        refreshSyscoinLocalBridgeTransactions();
        return;
      }

      if (transfers.value.length) {
        resetPaginatedRequest();
      }
      const response = await loadNext();
      const mappedTransfers = response.items.map(mapApiTransfer);
      transfers.value = filterOutDuplicateTransfers(mappedTransfers);
    },
    { cache: 30000 }
  );

  const {
    inProgress: previousTransfersRequestInProgress,
    error: previousTransfersRequestError,
    execute: requestPreviousTransfers,
    reset: resetPreviousTransfersRequest,
  } = usePromise(
    async () => {
      if (isSyscoinBridgeNetwork(eraNetwork.value)) {
        resetPaginatedRequest();
        refreshSyscoinCompletedTransfers();
        refreshSyscoinLocalBridgeTransactions();
        return;
      }

      const oldestTransferInTheList = transfers.value[transfers.value.length - 1];
      if (!oldestTransferInTheList) {
        return requestRecentTransfers();
      }
      const response = await loadNext();
      const mappedTransfers = response.items.map((e) => mapApiTransfer(e));
      transfers.value = filterOutDuplicateTransfers([...transfers.value, ...mappedTransfers]);
    },
    { cache: false }
  );

  onboardStore.subscribeOnAccountChange(() => {
    transfers.value = [];
    resetRecentTransfersRequest();
    resetPreviousTransfersRequest();
    resetPaginatedRequest();
  });

  return {
    transfers: displayedTransfers,

    recentTransfersRequestInProgress,
    recentTransfersRequestError,
    requestRecentTransfers,
    reloadRecentTransfers,

    canLoadMore,
    previousTransfersRequestInProgress,
    previousTransfersRequestError,
    requestPreviousTransfers,
  };
});
