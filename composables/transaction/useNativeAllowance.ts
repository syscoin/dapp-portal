import { readContract, getAccount, writeContract, waitForTransactionReceipt } from "@wagmi/core";

import { IERC20_ABI } from "@/data/abis/ierc20Abi";
import { L2_NATIVE_TOKEN_VAULT_ABI } from "@/data/abis/nativeTokenVaultAbi";
import { wagmiConfig } from "@/data/wagmi";

import { useSentryLogger } from "../useSentryLogger";

import type { Hash } from "@/types";
import type { Address } from "viem";

const ZERO_HASH = "0x0000000000000000000000000000000000000000000000000000000000000000";

export const useNativeAllowance = (tokenAddress: Ref<string | undefined>, amount: Ref<bigint>) => {
  const providerStore = useZkSyncProviderStore();
  const { eraNetwork } = storeToRefs(providerStore);
  const { captureException } = useSentryLogger();

  const isNativeToken = ref<boolean | null>(null);
  const allowanceCheckInProgress = ref<boolean>(false);
  const assetId = ref<null | string>(null);
  const tokenRegistrationRequired = ref(false);
  const approvedAllowance = ref<null | bigint>(null);
  let allowanceCheckNonce = 0;

  watch(
    [tokenAddress],
    async () => {
      const nonce = ++allowanceCheckNonce;
      assetId.value = null;
      tokenRegistrationRequired.value = false;
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
        let checkedAssetId = (await readContract(wagmiConfig, {
          address: L2_NATIVE_TOKEN_VAULT_ADDRESS,
          abi: L2_NATIVE_TOKEN_VAULT_ABI,
          functionName: "assetId",
          args: [tokenAddress.value],
          chainId: eraNetwork.value.id,
        })) as string;
        const needsRegistration = checkedAssetId === ZERO_HASH;
        if (needsRegistration) {
          checkedAssetId = (await readContract(wagmiConfig, {
            address: L2_NATIVE_TOKEN_VAULT_ADDRESS,
            abi: L2_NATIVE_TOKEN_VAULT_ABI,
            functionName: "ensureTokenIsRegistered",
            args: [tokenAddress.value],
            chainId: eraNetwork.value.id,
          })) as string;
        }
        if (nonce !== allowanceCheckNonce) return;
        assetId.value = checkedAssetId;
        tokenRegistrationRequired.value = needsRegistration;
        // SYSCOIN: v31 withdrawals use the NativeTokenVault asset-id path for
        // non-base ERC20s, regardless of whether the origin chain is L1 or L2.
        isNativeToken.value = true;

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
    if (tokenRegistrationRequired.value) {
      return false;
    }
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
        const receipts = [];

        if (tokenRegistrationRequired.value) {
          setAllowanceStatus.value = "waiting-for-signature";
          const txRegisterHash = await writeContract(wagmiConfig, {
            chainId: eraNetwork.value.id,
            address: L2_NATIVE_TOKEN_VAULT_ADDRESS,
            abi: L2_NATIVE_TOKEN_VAULT_ABI,
            functionName: "ensureTokenIsRegistered",
            args: [tokenAddress.value as Address],
          });

          setAllowanceTransactionHashes.value.push(txRegisterHash);
          setAllowanceStatus.value = "sending";
          receipts.push(
            await retry(
              () =>
                waitForTransactionReceipt(wagmiConfig, {
                  chainId: eraNetwork.value.id,
                  hash: txRegisterHash,
                  onReplaced: (replacement) => {
                    setAllowanceTransactionHashes.value[0] = replacement.transaction.hash;
                  },
                }),
              {
                retries: 3,
                delay: 5_000,
              }
            )
          );
          tokenRegistrationRequired.value = false;
          assetId.value = (await readContract(wagmiConfig, {
            address: L2_NATIVE_TOKEN_VAULT_ADDRESS,
            abi: L2_NATIVE_TOKEN_VAULT_ABI,
            functionName: "assetId",
            args: [tokenAddress.value],
            chainId: eraNetwork.value.id,
          })) as string;
        }

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

        receipts.push(
          await retry(
            () =>
              waitForTransactionReceipt(wagmiConfig, {
                chainId: eraNetwork.value.id,
                hash: txApproveHash,
                onReplaced: (replacement) => {
                  setAllowanceTransactionHashes.value[setAllowanceTransactionHashes.value.length - 1] =
                    replacement.transaction.hash;
                },
              }),
            {
              retries: 3,
              delay: 5_000,
            }
          )
        );

        approvedAllowance.value = (await readContract(wagmiConfig, {
          chainId: eraNetwork.value.id,
          address: tokenAddress.value as Address,
          abi: IERC20_ABI,
          functionName: "allowance",
          args: [accountAddress, L2_NATIVE_TOKEN_VAULT_ADDRESS],
        })) as bigint;

        setAllowanceStatus.value = "done";
        return receipts;
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
    if (isNativeToken.value && tokenRegistrationRequired.value && amount.value > 0) {
      return true;
    }
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
