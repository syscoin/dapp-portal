import { readContract, getAccount, writeContract, waitForTransactionReceipt } from "@wagmi/core";

import { IERC20_ABI } from "@/data/abis/ierc20Abi";
import { L2_NATIVE_TOKEN_VAULT_ABI } from "@/data/abis/nativeTokenVaultAbi";
import { wagmiConfig } from "@/data/wagmi";
import {
  L2_ASSET_TRACKER_ADDRESS,
  L2_BASE_TOKEN_ADDRESS,
  L2_NATIVE_TOKEN_VAULT_ADDRESS,
  L2_SYSTEM_CONTEXT_ADDRESS,
} from "@/utils/constants";
import {
  SYSCOIN_L2_ASSET_TRACKER_ABI,
  SYSCOIN_L2_SYSTEM_CONTEXT_ABI,
  isSyscoinBridgeNetwork,
} from "@/utils/syscoinBridge";

import { useSentryLogger } from "../useSentryLogger";

import type { Hash } from "@/types";
import type { Address } from "viem";

// SYSCOIN: v31 NativeTokenVault uses zero bytes32 as the "not registered"
// sentinel for asset-id withdrawals.
const ZERO_HASH = "0x0000000000000000000000000000000000000000000000000000000000000000";

export const useNativeAllowance = (tokenAddress: Ref<string | undefined>, amount: Ref<bigint>) => {
  const providerStore = useZkSyncProviderStore();
  const { eraNetwork } = storeToRefs(providerStore);
  const { captureException } = useSentryLogger();

  const isNativeToken = ref<boolean | null>(null);
  // SYSCOIN: keep asset-id withdrawal routing separate from allowance gating.
  // Registered L1-origin tokens can use the asset-id route without requiring
  // NativeTokenVault approval; unregistered/current-chain-native tokens do.
  const usesAssetIdWithdrawal = ref(false);
  const allowanceCheckInProgress = ref<boolean>(false);
  const assetId = ref<null | string>(null);
  const tokenRegistrationRequired = ref(false);
  const tokenMigrationRequired = ref(false);
  const tokenMigrationInitiated = ref(false);
  const approvedAllowance = ref<null | bigint>(null);
  const setAllowanceStatus = ref<"not-started" | "processing" | "waiting-for-signature" | "sending" | "done">(
    "not-started"
  );
  const setAllowanceTransactionHashes = ref<(Hash | undefined)[]>([]);
  let allowanceCheckNonce = 0;

  const currentSettlementLayerChainId = async () => {
    if (!isSyscoinBridgeNetwork(eraNetwork.value)) return BigInt(eraNetwork.value.l1Network?.id ?? 0);
    return (await readContract(wagmiConfig, {
      address: L2_SYSTEM_CONTEXT_ADDRESS,
      abi: SYSCOIN_L2_SYSTEM_CONTEXT_ABI,
      functionName: "currentSettlementLayerChainId",
      chainId: eraNetwork.value.id,
    })) as bigint;
  };

  const checkTokenMigrationRequired = async (checkedAssetId: string) => {
    if (!isSyscoinBridgeNetwork(eraNetwork.value)) return false;
    const l1ChainId = BigInt(eraNetwork.value.l1Network?.id ?? 0);
    const settlementLayerChainId = await currentSettlementLayerChainId();
    if (settlementLayerChainId === l1ChainId) return false;

    const tokenMigratedThisChain = (await readContract(wagmiConfig, {
      address: L2_ASSET_TRACKER_ADDRESS,
      abi: SYSCOIN_L2_ASSET_TRACKER_ABI,
      functionName: "tokenMigratedThisChain",
      args: [checkedAssetId as `0x${string}`],
      chainId: eraNetwork.value.id,
    })) as boolean;

    return !tokenMigratedThisChain;
  };

  watch(
    [tokenAddress],
    async () => {
      const nonce = ++allowanceCheckNonce;
      usesAssetIdWithdrawal.value = false;
      assetId.value = null;
      tokenRegistrationRequired.value = false;
      tokenMigrationRequired.value = false;
      tokenMigrationInitiated.value = false;
      approvedAllowance.value = null;
      setAllowanceStatus.value = "not-started";
      setAllowanceTransactionHashes.value = [];

      if (!tokenAddress.value) {
        isNativeToken.value = null;
        allowanceCheckInProgress.value = false;
        return;
      }
      if (tokenAddress.value === L2_BASE_TOKEN_ADDRESS) {
        isNativeToken.value = false;
        usesAssetIdWithdrawal.value = false;
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
        let originChainId: bigint | undefined;
        if (needsRegistration) {
          // SYSCOIN: unregistered v31 tokens such as freshly deployed zkSYS
          // need a persisted asset id before the asset-router withdrawal can
          // be estimated or submitted.
          checkedAssetId = (await readContract(wagmiConfig, {
            address: L2_NATIVE_TOKEN_VAULT_ADDRESS,
            abi: L2_NATIVE_TOKEN_VAULT_ABI,
            functionName: "ensureTokenIsRegistered",
            args: [tokenAddress.value],
            chainId: eraNetwork.value.id,
          })) as string;
        } else {
          originChainId = (await readContract(wagmiConfig, {
            address: L2_NATIVE_TOKEN_VAULT_ADDRESS,
            abi: L2_NATIVE_TOKEN_VAULT_ABI,
            functionName: "originChainId",
            args: [checkedAssetId],
            chainId: eraNetwork.value.id,
          })) as bigint;
        }
        const migrationRequired =
          needsRegistration && isSyscoinBridgeNetwork(eraNetwork.value)
            ? (await currentSettlementLayerChainId()) !== BigInt(eraNetwork.value.l1Network?.id ?? 0)
            : await checkTokenMigrationRequired(checkedAssetId);
        if (nonce !== allowanceCheckNonce) return;
        assetId.value = checkedAssetId;
        tokenRegistrationRequired.value = needsRegistration;
        tokenMigrationRequired.value = migrationRequired;
        // SYSCOIN: fresh v31 withdrawals use asset ids for non-base ERC20s.
        // The separate `isNativeToken` flag only tracks whether the user must
        // approve the NativeTokenVault before withdrawing.
        usesAssetIdWithdrawal.value = true;
        isNativeToken.value = needsRegistration || originChainId === BigInt(eraNetwork.value.id);

        if (!isNativeToken.value) {
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
    if (tokenRegistrationRequired.value || tokenMigrationRequired.value) {
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
        const selectionMatches = (selectedTokenAddress: string | undefined, selectedAssetId?: string | null) => {
          return (
            tokenAddress.value === selectedTokenAddress &&
            (selectedAssetId == null || assetId.value === selectedAssetId)
          );
        };
        const stopStalePreparation = () => {
          setAllowanceStatus.value = "not-started";
          return receipts;
        };

        if (tokenRegistrationRequired.value) {
          const registeredTokenAddress = tokenAddress.value;
          if (!registeredTokenAddress) return stopStalePreparation();
          // SYSCOIN: registration is permissionless but state-changing; include
          // it in the approval flow so the later withdrawal has a stable asset id.
          setAllowanceStatus.value = "waiting-for-signature";
          const txRegisterHash = await writeContract(wagmiConfig, {
            chainId: eraNetwork.value.id,
            address: L2_NATIVE_TOKEN_VAULT_ADDRESS,
            abi: L2_NATIVE_TOKEN_VAULT_ABI,
            functionName: "ensureTokenIsRegistered",
            args: [registeredTokenAddress as Address],
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
          if (!selectionMatches(registeredTokenAddress)) return stopStalePreparation();
          tokenRegistrationRequired.value = false;
          const registeredAssetId = (await readContract(wagmiConfig, {
            address: L2_NATIVE_TOKEN_VAULT_ADDRESS,
            abi: L2_NATIVE_TOKEN_VAULT_ABI,
            functionName: "assetId",
            args: [registeredTokenAddress],
            chainId: eraNetwork.value.id,
          })) as string;
          const migrationRequired = await checkTokenMigrationRequired(registeredAssetId);
          if (!selectionMatches(registeredTokenAddress)) return stopStalePreparation();
          assetId.value = registeredAssetId;
          tokenMigrationRequired.value = migrationRequired;
        }

        const migrationAssetId = assetId.value;
        const migrationTokenAddress = tokenAddress.value;
        if (tokenMigrationRequired.value && migrationAssetId) {
          if (!tokenMigrationInitiated.value) {
            // SYSCOIN: v31 Gateway-settled chains require each asset's balance
            // accounting to be migrated before withdrawals / interop can leave
            // the chain. The initiation is permissionless but confirmation is
            // completed later by the system service transaction.
            setAllowanceStatus.value = "waiting-for-signature";
            const txMigrationHash = await writeContract(wagmiConfig, {
              chainId: eraNetwork.value.id,
              address: L2_ASSET_TRACKER_ADDRESS,
              abi: SYSCOIN_L2_ASSET_TRACKER_ABI,
              functionName: "initiateL1ToGatewayMigrationOnL2",
              args: [migrationAssetId as `0x${string}`],
            });

            setAllowanceTransactionHashes.value.push(txMigrationHash);
            setAllowanceStatus.value = "sending";
            receipts.push(
              await retry(
                () =>
                  waitForTransactionReceipt(wagmiConfig, {
                    chainId: eraNetwork.value.id,
                    hash: txMigrationHash,
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
            if (!selectionMatches(migrationTokenAddress, migrationAssetId)) return stopStalePreparation();
            tokenMigrationInitiated.value = true;
          }

          const migrationRequired = await checkTokenMigrationRequired(migrationAssetId);
          if (!selectionMatches(migrationTokenAddress, migrationAssetId)) return stopStalePreparation();
          tokenMigrationRequired.value = migrationRequired;
          if (migrationRequired) {
            setAllowanceStatus.value = "done";
            return receipts;
          }
        }

        if (isNativeToken.value && amount.value > (approvedAllowance.value ?? 0n)) {
          const approvalTokenAddress = tokenAddress.value;
          if (!approvalTokenAddress) return stopStalePreparation();
          setAllowanceStatus.value = "waiting-for-signature";
          const txApproveHash = await writeContract(wagmiConfig, {
            chainId: eraNetwork.value.id,
            address: approvalTokenAddress as Address,
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
          if (!selectionMatches(approvalTokenAddress)) return stopStalePreparation();
        }

        if (isNativeToken.value) {
          const allowanceTokenAddress = tokenAddress.value;
          if (!allowanceTokenAddress) return stopStalePreparation();
          const allowance = (await readContract(wagmiConfig, {
            chainId: eraNetwork.value.id,
            address: allowanceTokenAddress as Address,
            abi: IERC20_ABI,
            functionName: "allowance",
            args: [accountAddress, L2_NATIVE_TOKEN_VAULT_ADDRESS],
          })) as bigint;
          if (!selectionMatches(allowanceTokenAddress)) return stopStalePreparation();
          approvedAllowance.value = allowance;
        }

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
    if (tokenRegistrationRequired.value || tokenMigrationRequired.value) {
      return amount.value > 0;
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
    usesAssetIdWithdrawal,
    allowanceCheckInProgress,
    amountToTransferIsApproved,
    approvedAllowance,
    assetId,
    tokenRegistrationRequired,
    tokenMigrationRequired,
    tokenMigrationInitiated,
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
