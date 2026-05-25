import { readContract, getAccount, writeContract, waitForTransactionReceipt } from "@wagmi/core";

import { IERC20_ABI } from "@/data/abis/ierc20Abi";
import { L2_NATIVE_TOKEN_VAULT_ABI } from "@/data/abis/nativeTokenVaultAbi";
import { wagmiConfig } from "@/data/wagmi";

import { useSentryLogger } from "../useSentryLogger";

import type { Hash } from "@/types";
import type { Address } from "viem";

export const useNativeAllowance = (tokenAddress: Ref<string | undefined>, amount: Ref<bigint>) => {
  const providerStore = useZkSyncProviderStore();
  const { eraNetwork } = storeToRefs(providerStore);
  const { captureException } = useSentryLogger();

  const isNativeToken = ref<boolean | null>(null);
  const allowanceCheckInProgress = ref<boolean>(false);
  const assetId = ref<null | string>(null);
  const approvedAllowance = ref<null | bigint>(null);
  let allowanceCheckNonce = 0;

  watch(
    [tokenAddress],
    async () => {
      const nonce = ++allowanceCheckNonce;
      assetId.value = null;
      approvedAllowance.value = null;

      if (!tokenAddress.value) {
        isNativeToken.value = null;
        allowanceCheckInProgress.value = false;
        return;
      }
      if (tokenAddress.value === L2_BASE_TOKEN_ADDRESS) {
        isNativeToken.value = false;
        allowanceCheckInProgress.value = false;
        return;
      }
      allowanceCheckInProgress.value = true;
      try {
        const checkedAssetId = (await readContract(wagmiConfig, {
          address: L2_NATIVE_TOKEN_VAULT_ADDRESS,
          abi: L2_NATIVE_TOKEN_VAULT_ABI,
          functionName: "assetId",
          args: [tokenAddress.value],
          chainId: eraNetwork.value.id,
        })) as string;
        const originChainId: bigint = (await readContract(wagmiConfig, {
          address: L2_NATIVE_TOKEN_VAULT_ADDRESS,
          abi: L2_NATIVE_TOKEN_VAULT_ABI,
          functionName: "originChainId",
          args: [checkedAssetId],
          chainId: eraNetwork.value.id,
        })) as bigint;

        if (nonce !== allowanceCheckNonce) return;
        assetId.value = checkedAssetId;
        isNativeToken.value = BigInt(eraNetwork.value.id) === originChainId;

        if (!isNativeToken.value) {
          // SYSCOIN: L1-origin bridge tokens can have vault metadata before an
          // L2 ERC20 contract exists, so only native tokens need allowance().
          return;
        }

        const accountAddress = getAccount(wagmiConfig).address;
        const allowance = (await readContract(wagmiConfig, {
          chainId: eraNetwork.value.id,
          address: tokenAddress.value as Address,
          abi: IERC20_ABI,
          functionName: "allowance",
          args: [accountAddress, L2_NATIVE_TOKEN_VAULT_ADDRESS],
        })) as bigint;

        if (nonce !== allowanceCheckNonce) return;
        approvedAllowance.value = allowance;
      } catch (error) {
        if (nonce !== allowanceCheckNonce) return;
        captureException({
          error: error as Error,
          parentFunctionName: "useNativeAllowance",
          parentFunctionParams: [tokenAddress.value, amount.value.toString()],
          filePath: "composables/transaction/useNativeAllowance.ts",
        });
        isNativeToken.value = null;
      } finally {
        if (nonce === allowanceCheckNonce) {
          allowanceCheckInProgress.value = false;
        }
      }
    },
    { immediate: true }
  );

  const amountToTransferIsApproved = computed(() => {
    if (approvedAllowance.value == null || amount.value == null) {
      return false;
    }
    if (approvedAllowance.value >= amount.value) {
      return true;
    } else {
      return false;
    }
  });

  const hideBasedOnAllowance = computed(() => {
    if (isNativeToken.value == null) {
      return true;
    }
    if (allowanceCheckInProgress.value) {
      return true;
    }
    return isNativeToken.value;
  });

  const setAllowanceStatus = ref<"not-started" | "processing" | "waiting-for-signature" | "sending" | "done">(
    "not-started"
  );
  const setAllowanceTransactionHashes = ref<(Hash | undefined)[]>([]);
  const {
    result: approveAllowanceReceipt,
    inProgress: approveAllowanceInProgress,
    error: approveAllowanceError,
    execute: executeApproveAllowance,
    reset: resetExecuteApproveAllowance,
  } = usePromise(
    async () => {
      try {
        setAllowanceStatus.value = "processing";
        const accountAddress = getAccount(wagmiConfig).address;

        setAllowanceStatus.value = "waiting-for-signature";
        const txApproveHash = await writeContract(wagmiConfig, {
          chainId: eraNetwork.value.id,
          address: tokenAddress.value as Address,
          abi: IERC20_ABI,
          functionName: "approve",
          args: [L2_NATIVE_TOKEN_VAULT_ADDRESS, amount.value],
        });

        setAllowanceTransactionHashes.value.push(txApproveHash);
        setAllowanceStatus.value = "sending";

        const receipt = await retry(
          () =>
            waitForTransactionReceipt(wagmiConfig, {
              chainId: eraNetwork.value.id,
              hash: txApproveHash,
              onReplaced: (replacement) => {
                setAllowanceTransactionHashes.value[0] = replacement.transaction.hash;
              },
            }),
          {
            retries: 3,
            delay: 5_000,
          }
        );

        approvedAllowance.value = (await readContract(wagmiConfig, {
          chainId: eraNetwork.value.id,
          address: tokenAddress.value as Address,
          abi: IERC20_ABI,
          functionName: "allowance",
          args: [accountAddress, L2_NATIVE_TOKEN_VAULT_ADDRESS],
        })) as bigint;

        setAllowanceStatus.value = "done";
        return [receipt];
      } catch (err) {
        setAllowanceStatus.value = "not-started";
        captureException({
          error: err as Error,
          parentFunctionName: "executeSetAllowance",
          parentFunctionParams: [],
          filePath: "composables/transaction/useCheckNativeAllowance.ts",
        });
        throw err;
      }
    },
    { cache: false }
  );

  const showAllowanceProcess = computed(() => {
    if (
      isNativeToken.value &&
      approvedAllowance.value != null &&
      amount.value > 0 &&
      amount.value > approvedAllowance.value
    ) {
      return true;
    }
    return false;
  });

  return {
    isNativeToken,
    allowanceCheckInProgress,
    amountToTransferIsApproved,
    approvedAllowance,
    assetId,
    hideBasedOnAllowance,
    setAllowanceStatus,
    showAllowanceProcess,

    approveAllowanceReceipt,
    approveAllowanceInProgress,
    approveAllowanceError,
    executeApproveAllowance,
    resetExecuteApproveAllowance,
    setAllowanceTransactionHashes,
  };
};
