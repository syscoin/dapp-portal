import { useStorage } from "@vueuse/core";
import { decodeEventLog } from "viem";
import IZkSyncHyperchain from "zksync-ethers/abi/IZkSyncHyperchain.json";

import type { FeeEstimationParams } from "@/composables/zksync/useFee";
import type { TokenAmount, Hash } from "@/types";

export type TransactionInfo = {
  type: FeeEstimationParams["type"] | "deposit";
  token: TokenAmount;
  from: { address: string; destination: TransactionDestination };
  to: { address: string; destination: TransactionDestination };
  transactionHash: string;
  timestamp: string;
  info: {
    toTransactionHash?: string;
    expectedCompleteTimestamp?: string;
    withdrawalFinalizationAvailable?: boolean;
    failed?: boolean;
    completed: boolean;
  };
};

export const ESTIMATED_DEPOSIT_DELAY = 15 * 60 * 1000; // 15 minutes
export const WITHDRAWAL_DELAY = 6 * 60 * 60 * 1000; // 6 hours

export const useZkSyncTransactionStatusStore = defineStore("zkSyncTransactionStatus", () => {
  const onboardStore = useOnboardStore();
  const providerStore = useZkSyncProviderStore();
  const { account } = storeToRefs(onboardStore);
  const { eraNetwork } = storeToRefs(providerStore);

  const storageSavedTransactions = useStorage<{ [networkKey: string]: TransactionInfo[] }>(
    "zksync-bridge-transactions",
    {}
  );
  const savedTransactions = computed<TransactionInfo[]>({
    get: () => {
      return storageSavedTransactions.value[eraNetwork.value.key] || [];
    },
    set: (transactions: TransactionInfo[]) => {
      storageSavedTransactions.value[eraNetwork.value.key] = transactions;
    },
  });
  const userTransactions = computed(() =>
    savedTransactions.value.filter(
      (tx) =>
        tx.from.address === account.value.address ||
        (tx.type === "withdrawal" && tx.to.address === account.value.address)
    )
  );

  const getDepositL2TransactionHash = (l1Receipt: any) => {
    for (const log of l1Receipt.logs) {
      try {
        const { args, eventName } = decodeEventLog({
          abi: IZkSyncHyperchain,
          data: log.data,
          topics: log.topics,
        });
        if (eventName === "NewPriorityRequest") {
          return (args as unknown as { txHash: Hash }).txHash;
        }
      } catch {
        // ignore failed decoding
      }
    }
    throw new Error("No L2 transaction hash found");
  };
  const isTransactionNotFoundError = (error: Error) => {
    const message = error.message.toLowerCase();
    const isReceiptOrTransactionError = message.includes("transaction") || message.includes("receipt");
    return (
      (isReceiptOrTransactionError && (message.includes("not found") || message.includes("could not find"))) ||
      message.includes("unknown transaction") ||
      message.includes("missing transaction")
    );
  };
  const getDepositStatus = async (transaction: TransactionInfo) => {
    // Get L1 transaction receipt with retry logic for consistency
    const publicClient = onboardStore.getPublicClient();
    const l1Receipt = await retry(() =>
      publicClient.waitForTransactionReceipt({
        hash: transaction.transactionHash as Hash,
      })
    );

    // Create a copy to avoid mutating the input parameter
    const updatedTransaction = { ...transaction, info: { ...transaction.info } };

    // If L1 transaction failed, mark the deposit as failed
    if (l1Receipt.status === "reverted") {
      updatedTransaction.info.failed = true;
      updatedTransaction.info.completed = true;
      return updatedTransaction;
    }

    // L1 transaction succeeded, extract L2 transaction hash from the same receipt
    let l2TransactionHash: Hash;
    try {
      l2TransactionHash = getDepositL2TransactionHash(l1Receipt);
    } catch {
      // SYSCOIN: a successful L1 deposit without a priority request hash cannot
      // be tracked to L2; keep it terminally failed instead of rejecting polling.
      updatedTransaction.info.failed = true;
      updatedTransaction.info.completed = true;
      return updatedTransaction;
    }
    // SYSCOIN: if this is a re-check of an older false-failed deposit, a
    // successful L1 receipt means the operation is pending until L2 proves otherwise.
    updatedTransaction.info.failed = false;
    updatedTransaction.info.completed = false;
    const provider = await providerStore.requestProvider();
    let l2TransactionReceipt;
    try {
      l2TransactionReceipt = await provider.getTransactionReceipt(l2TransactionHash);
    } catch (err) {
      // SYSCOIN: priority deposits can take longer than the UI estimate to
      // appear on L2. A missing L2 receipt is pending, not failed.
      if (isTransactionNotFoundError(err as Error)) return updatedTransaction;
      throw err;
    }
    if (!l2TransactionReceipt) return updatedTransaction;

    updatedTransaction.info.toTransactionHash = l2TransactionHash;
    if (l2TransactionReceipt.status === 0 || l2TransactionReceipt.status === "reverted") {
      updatedTransaction.info.failed = true;
    } else {
      updatedTransaction.info.failed = false;
    }
    updatedTransaction.info.completed = true;
    return updatedTransaction;
  };
  const getWithdrawalStatus = async (transaction: TransactionInfo) => {
    if (!transaction.info.withdrawalFinalizationAvailable) {
      const provider = await providerStore.requestProvider();
      const transactionDetails = await provider.getTransactionDetails(transaction.transactionHash);
      if (transactionDetails.status === "failed") {
        transaction.info.withdrawalFinalizationAvailable = false;
        transaction.info.failed = true;
        transaction.info.completed = true;
        return transaction;
      }
      if (transactionDetails.status !== "verified") {
        return transaction;
      }
    }
    const isFinalized = await useZkSyncWalletStore()
      .getL1VoidSigner(true)
      .then((signer) => signer.isWithdrawalFinalized(transaction.transactionHash))
      .catch(() => false);
    transaction.info.withdrawalFinalizationAvailable = true;
    transaction.info.completed = isFinalized;
    return transaction;
  };
  const getTransferStatus = async (transaction: TransactionInfo) => {
    const provider = await providerStore.requestProvider();
    const transactionReceipt = await provider.getTransactionReceipt(transaction.transactionHash);
    if (!transactionReceipt) return transaction;
    const transactionDetails = await provider.getTransactionDetails(transaction.transactionHash);
    if (transactionDetails.status === "failed") {
      transaction.info.failed = true;
    }
    transaction.info.completed = true;
    return transaction;
  };
  const waitForCompletion = async (transaction: TransactionInfo) => {
    // SYSCOIN: older local state may have marked a delayed deposit as failed
    // while the L2 priority transaction was still pending. Re-check failed
    // deposits so opening the transaction can recover and persist success.
    if (transaction.info.completed && !(transaction.type === "deposit" && transaction.info.failed)) return transaction;
    if (transaction.type === "deposit") {
      transaction = await getDepositStatus(transaction);
    } else if (transaction.type === "withdrawal") {
      transaction = await getWithdrawalStatus(transaction);
    } else if (transaction.type === "transfer") {
      transaction = await getTransferStatus(transaction);
    }
    if (!transaction.info.completed) {
      const timeoutByType: Record<TransactionInfo["type"], number> = {
        deposit: 15_000,
        withdrawal: 30_000,
        transfer: 2_000,
      };
      await new Promise((resolve) => setTimeout(resolve, timeoutByType[transaction.type]));
      transaction = await waitForCompletion(transaction);
    }
    return transaction;
  };

  const saveTransaction = (transaction: TransactionInfo) => {
    if (
      savedTransactions.value.some(
        (existingTransaction) => existingTransaction.transactionHash === transaction.transactionHash
      )
    ) {
      updateTransactionData(transaction.transactionHash, transaction);
    } else {
      savedTransactions.value = [...savedTransactions.value, transaction];
    }
  };
  const updateTransactionData = (transactionHash: string, replaceTransaction: TransactionInfo) => {
    const transaction = savedTransactions.value.find((transaction) => transaction.transactionHash === transactionHash);
    if (!transaction) throw new Error("Transaction not found");
    const index = savedTransactions.value.indexOf(transaction);
    const newSavedTransactions = [...savedTransactions.value];
    newSavedTransactions[index] = replaceTransaction;
    savedTransactions.value = newSavedTransactions;
    return replaceTransaction;
  };
  const getTransaction = (transactionHash: string) => {
    transactionHash = transactionHash.toLowerCase();
    return savedTransactions.value.find((transaction) => transaction.transactionHash.toLowerCase() === transactionHash);
  };

  return {
    savedTransactions,
    userTransactions,
    waitForCompletion,
    saveTransaction,
    updateTransactionData,
    getTransaction,
  };
});
