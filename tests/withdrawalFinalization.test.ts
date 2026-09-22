import assert from "node:assert/strict";
import { createPinia, defineStore, setActivePinia, storeToRefs } from "pinia";
import { afterEach, beforeAll, beforeEach, describe, it, vi } from "vitest";
import { computed, effectScope, ref } from "vue";

import usePromise from "../composables/usePromise";
import useWithdrawalFinalization from "../composables/zksync/useWithdrawalFinalization";
import { formatError } from "../utils/formatters";
import { calculateFee, retry } from "../utils/helpers";

import type { TransactionInfo } from "../store/zksync/transactionStatus";

const mocks = vi.hoisted(() => ({
  getFinalizationParams: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("../composables/useSentryLogger", () => ({
  useSentryLogger: () => ({ captureException: mocks.captureException }),
}));
vi.mock("../utils/syscoinBridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/syscoinBridge")>()),
  getSyscoinFinalizeWithdrawalParams: mocks.getFinalizationParams,
}));

const withdrawalHash = `0x${"11".repeat(32)}` as const;
const claimHash = `0x${"22".repeat(32)}` as const;
const replacementHash = `0x${"33".repeat(32)}` as const;
const accountAddress = `0x${"44".repeat(20)}` as const;
const nullifierAddress = `0x${"55".repeat(20)}` as const;
const tokenAddress = "0x000000000000000000000000000000000000800a";

const publicClient = {
  getGasPrice: vi.fn(),
  estimateContractGas: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
  getTransactionReceipt: vi.fn(),
  readContract: vi.fn(),
};
const provider = { getTransactionReceipt: vi.fn() };
const writeContract = vi.fn();
const trackEvent = vi.fn();

let useTransactionStatusStore: typeof import("../store/zksync/transactionStatus").useZkSyncTransactionStatusStore;
let scope: ReturnType<typeof effectScope>;

const withdrawal = (info: Partial<TransactionInfo["info"]> = {}): TransactionInfo => ({
  type: "withdrawal",
  token: { address: tokenAddress, symbol: "TSYS", decimals: 18, amount: "100" },
  from: { address: accountAddress, destination: { label: "zkSYS", iconUrl: "" } },
  to: { address: accountAddress, destination: { label: "Tanenbaum", iconUrl: "" } },
  transactionHash: withdrawalHash,
  timestamp: new Date().toISOString(),
  info: { completed: false, withdrawalFinalizationAvailable: true, ...info },
});
const finalization = () => scope.run(() => useWithdrawalFinalization(computed(() => withdrawal())))!;
const storedClaim = (info: Partial<TransactionInfo["info"]> = {}) => {
  const store = scope.run(() => useTransactionStatusStore())!;
  const transaction = withdrawal({
    toTransactionHash: claimHash,
    toTransactionSubmittedTimestamp: new Date().toISOString(),
    ...info,
  });
  store.saveTransaction(transaction);
  return { store, transaction };
};

beforeAll(async () => {
  vi.stubGlobal("defineStore", defineStore);
  ({ useZkSyncTransactionStatusStore: useTransactionStatusStore } = await import("../store/zksync/transactionStatus"));
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  setActivePinia(createPinia());
  scope = effectScope();
  vi.stubGlobal("ref", ref);
  vi.stubGlobal("computed", computed);
  vi.stubGlobal("storeToRefs", storeToRefs);
  vi.stubGlobal("usePromise", usePromise);
  vi.stubGlobal("retry", retry);
  vi.stubGlobal("calculateFee", calculateFee);
  vi.stubGlobal("formatError", formatError);
  vi.stubGlobal("trackEvent", trackEvent);
  vi.stubGlobal(
    "useOnboardStore",
    defineStore("testOnboard", () => ({
      account: ref({ address: accountAddress }),
      isCorrectNetworkSet: ref(true),
      getPublicClient: () => publicClient,
      getWallet: () => Promise.resolve({ writeContract }),
    }))
  );
  vi.stubGlobal(
    "useZkSyncProviderStore",
    defineStore("testProvider", () => ({
      eraNetwork: ref({
        key: "test-syscoin",
        id: 57057,
        syscoinBridge: { l1NullifierAddress: nullifierAddress },
      }),
      requestProvider: () => Promise.resolve(provider),
    }))
  );
  vi.stubGlobal("useZkSyncWalletStore", () => ({}));
  vi.stubGlobal(
    "useZkSyncTokensStore",
    defineStore("testTokens", () => ({
      ethToken: ref({ address: tokenAddress, symbol: "TSYS", decimals: 18 }),
      requestTokens: vi.fn(),
    }))
  );
  mocks.getFinalizationParams.mockResolvedValue({
    chainId: 57057n,
    l2BatchNumber: 7n,
    l2MessageIndex: 2n,
    l2Sender: tokenAddress,
    l2TxNumberInBatch: 1,
    message: "0x1234",
    merkleProof: [],
  });
  publicClient.getGasPrice.mockResolvedValue(1n);
  publicClient.estimateContractGas.mockResolvedValue(100n);
  publicClient.waitForTransactionReceipt.mockResolvedValue({ status: "success", transactionHash: claimHash });
  publicClient.getTransactionReceipt.mockResolvedValue({ status: "reverted", transactionHash: claimHash });
  publicClient.readContract.mockResolvedValue(false);
  provider.getTransactionReceipt.mockResolvedValue({ status: 1 });
  writeContract.mockResolvedValue(claimHash);
});

afterEach(() => {
  scope.stop();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("withdrawal finalization receipts", () => {
  it("finishes and emits analytics for a successful claim", async () => {
    const claim = finalization();
    const receipt = await claim.commitTransaction();
    assert.equal(receipt?.status, "success");
    assert.equal(claim.status.value, "done");
    assert.equal(claim.transactionHash.value, claimHash);
    assert.equal(trackEvent.mock.calls[0]?.[0], "withdrawal-finalized");
  });

  it.each(["reverted", undefined])("does not complete a receipt with status %s", async (status) => {
    publicClient.waitForTransactionReceipt.mockResolvedValue({ status, transactionHash: claimHash });
    const claim = finalization();
    assert.equal(await claim.commitTransaction(), undefined);
    assert.equal(claim.status.value, "not-started");
    assert.ok(claim.error.value);
    assert.equal(trackEvent.mock.calls.length, 0);
  });

  it.each(["cancelled", "replaced"])("rejects a successful %s replacement", async (reason) => {
    publicClient.waitForTransactionReceipt.mockImplementation(({ onReplaced }) => {
      onReplaced({ reason, transaction: { hash: replacementHash } });
      return Promise.resolve({ status: "success", transactionHash: replacementHash });
    });
    const claim = finalization();
    assert.equal(await claim.commitTransaction(), undefined);
    assert.equal(claim.status.value, "not-started");
    assert.ok(claim.error.value);
    assert.equal(trackEvent.mock.calls.length, 0);
  });

  it("preserves successful repricing", async () => {
    publicClient.waitForTransactionReceipt.mockImplementation(({ onReplaced }) => {
      onReplaced({ reason: "repriced", transaction: { hash: replacementHash } });
      return Promise.resolve({ status: "success", transactionHash: replacementHash });
    });
    const claim = finalization();
    const receipt = await claim.commitTransaction();
    assert.equal(receipt?.transactionHash, replacementHash);
    assert.equal(claim.transactionHash.value, replacementHash);
    assert.equal(claim.status.value, "done");
    assert.equal(trackEvent.mock.calls.length, 1);
  });

  it("retains replacement rejection when receipt waiting retries", async () => {
    publicClient.waitForTransactionReceipt.mockImplementationOnce(({ onReplaced }) => {
      onReplaced({ reason: "cancelled", transaction: { hash: replacementHash } });
      return Promise.reject(new Error("Temporary receipt RPC failure"));
    });
    publicClient.waitForTransactionReceipt.mockResolvedValue({
      status: "success",
      transactionHash: replacementHash,
    });
    const claim = finalization();
    assert.equal(await claim.commitTransaction(), undefined);
    assert.equal(publicClient.waitForTransactionReceipt.mock.calls.length, 2);
    assert.equal(publicClient.waitForTransactionReceipt.mock.calls[1][0].hash, replacementHash);
    assert.equal(claim.status.value, "not-started");
    assert.ok(claim.error.value);
    assert.equal(trackEvent.mock.calls.length, 0);
  });

  it("retains a pending claim hash after receipt timeouts", async () => {
    publicClient.waitForTransactionReceipt.mockRejectedValue(new Error("Receipt wait timed out"));
    const claim = finalization();
    assert.equal(await claim.commitTransaction(), undefined);
    assert.equal(publicClient.waitForTransactionReceipt.mock.calls.length, 3);
    assert.equal(claim.transactionHash.value, claimHash);
    assert.equal(claim.status.value, "not-started");
    assert.ok(claim.error.value);
    assert.equal(trackEvent.mock.calls.length, 0);
  });
});

describe("persisted withdrawal claim recovery", () => {
  it.each(["reverted", "success"])("unlocks an unfinalized claim with a %s receipt", async (status) => {
    publicClient.getTransactionReceipt.mockResolvedValue({ status, transactionHash: claimHash });
    const { store, transaction } = storedClaim();
    const updated = await store.waitForCompletion(transaction);
    assert.equal(updated.info.completed, false);
    assert.equal(updated.info.failed, false);
    assert.equal(updated.info.withdrawalFinalizationAvailable, true);
    assert.equal(updated.info.toTransactionHash, undefined);
    assert.equal(updated.info.toTransactionSubmittedTimestamp, undefined);
  });

  it.each(["reverted", "success"])("repairs a stored false completion with a %s claim receipt", async (status) => {
    publicClient.getTransactionReceipt.mockResolvedValue({ status, transactionHash: claimHash });
    const { store, transaction } = storedClaim({ completed: true });
    await store.refreshSavedTransactionStatus(transaction);
    const updated = store.getTransaction(withdrawalHash)!;
    assert.equal(updated.info.completed, false);
    assert.equal(updated.info.withdrawalFinalizationAvailable, true);
    assert.equal(updated.info.toTransactionHash, undefined);
    assert.equal(updated.info.toTransactionSubmittedTimestamp, undefined);
  });

  it("preserves an actual finalized withdrawal", async () => {
    publicClient.readContract.mockResolvedValue(true);
    const { store, transaction } = storedClaim({ completed: true, withdrawalFinalizationAvailable: false });
    await store.refreshSavedTransactionStatus(transaction);
    const updated = store.getTransaction(withdrawalHash)!;
    assert.equal(updated.info.completed, true);
    assert.equal(updated.info.withdrawalFinalizationAvailable, false);
    assert.equal(updated.info.toTransactionHash, claimHash);
    assert.equal(publicClient.getTransactionReceipt.mock.calls.length, 0);
  });

  it("preserves completed state when the finalization RPC is unavailable", async () => {
    publicClient.readContract.mockRejectedValue(new Error("Temporary nullifier RPC failure"));
    const { store, transaction } = storedClaim({ completed: true, withdrawalFinalizationAvailable: false });
    await store.refreshSavedTransactionStatus(transaction);
    assert.deepEqual(store.getTransaction(withdrawalHash)!.info, transaction.info);
    assert.ok(publicClient.readContract.mock.calls.length > 0);
  });

  it("rechecks finalization after a successful receipt before unlocking a claim", async () => {
    publicClient.readContract.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    publicClient.getTransactionReceipt.mockResolvedValue({ status: "success", transactionHash: claimHash });
    const { store, transaction } = storedClaim();
    const updated = await store.waitForCompletion(transaction);
    assert.equal(updated.info.completed, true);
    assert.equal(updated.info.withdrawalFinalizationAvailable, false);
    assert.equal(updated.info.toTransactionHash, claimHash);
  });
});
