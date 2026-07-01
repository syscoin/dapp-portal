import { readContract, getAccount, writeContract, waitForTransactionReceipt } from "@wagmi/core";
import { encodeFunctionData, type Address, type Hex } from "viem";

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
  SYSCOIN_BRIDGEHUB_ABI,
  SYSCOIN_L1_ASSET_TRACKER_ABI,
  SYSCOIN_L1_RECEIPT_TIMEOUT,
  SYSCOIN_L2_ASSET_TRACKER_ABI,
  SYSCOIN_L2_SYSTEM_CONTEXT_ABI,
  getSyscoinGatewayMigrationFinalizeParams,
  isSyscoinBridgeNetwork,
  type SyscoinFinalizeWithdrawalParams,
} from "@/utils/syscoinBridge";

import { useSentryLogger } from "../useSentryLogger";

import type { Hash } from "@/types";

// SYSCOIN: v31 NativeTokenVault uses zero bytes32 as the "not registered"
// sentinel for asset-id withdrawals.
const ZERO_HASH = "0x0000000000000000000000000000000000000000000000000000000000000000";
// SYSCOIN: Gateway migration legs can outlive a browser session; persist tx
// hashes only as recoverable hints and validate them on-chain before reuse.
const TOKEN_MIGRATION_INITIATION_STORAGE_PREFIX = "zksys-token-migration-initiation";
const TOKEN_MIGRATION_FINALIZATION_STORAGE_PREFIX = "zksys-token-migration-finalization";
const isL2BaseTokenAddress = (address: string | undefined) => {
  return address?.toLowerCase() === L2_BASE_TOKEN_ADDRESS.toLowerCase();
};
const isTransactionHash = (value: unknown): value is Hash => {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
};
const isReceiptReverted = (status: unknown) => status === 0 || status === "0x0" || status === "reverted";

type StoredTokenMigrationTransaction = {
  hash: Hash;
  createdAt: number;
};
type RpcTransaction = {
  to?: string;
  input?: Hex;
  data?: Hex;
};

const getTokenMigrationStorageKey = (prefix: string, chainId: number, account: string, assetId: string) => {
  return [prefix, chainId.toString(), account.toLowerCase(), assetId.toLowerCase()].join(":");
};

const readStoredTokenMigrationHash = (
  prefix: string,
  chainId: number,
  account: string | undefined,
  assetId: string
) => {
  if (typeof window === "undefined" || !account) return undefined;
  try {
    const rawValue = window.localStorage.getItem(getTokenMigrationStorageKey(prefix, chainId, account, assetId));
    if (!rawValue) return undefined;
    const parsedValue = JSON.parse(rawValue) as Partial<StoredTokenMigrationTransaction>;
    return isTransactionHash(parsedValue.hash) ? parsedValue.hash : undefined;
  } catch {
    return undefined;
  }
};

const writeStoredTokenMigrationHash = (
  prefix: string,
  chainId: number,
  account: string | undefined,
  assetId: string,
  hash: Hash
) => {
  if (typeof window === "undefined" || !account) return;
  const value: StoredTokenMigrationTransaction = { hash, createdAt: Date.now() };
  window.localStorage.setItem(getTokenMigrationStorageKey(prefix, chainId, account, assetId), JSON.stringify(value));
};

const clearStoredTokenMigrationHash = (
  prefix: string,
  chainId: number,
  account: string | undefined,
  assetId: string
) => {
  if (typeof window === "undefined" || !account) return;
  window.localStorage.removeItem(getTokenMigrationStorageKey(prefix, chainId, account, assetId));
};

export const useNativeAllowance = (tokenAddress: Ref<string | undefined>, amount: Ref<bigint>) => {
  const onboardStore = useOnboardStore();
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
  const tokenMigrationInitiationHash = ref<Hash | undefined>();
  const tokenMigrationFinalizationHash = ref<Hash | undefined>();
  const approvedAllowance = ref<null | bigint>(null);
  const setAllowanceStatus = ref<"not-started" | "processing" | "waiting-for-signature" | "sending" | "done">(
    "not-started"
  );
  const setAllowanceTransactionHashes = ref<(Hash | undefined)[]>([]);
  const approveAllowanceReceipt = ref<{ transactionHash: Hash }[] | undefined>();
  const approveAllowanceInProgress = ref(false);
  const approveAllowanceError = ref<Error | undefined>();
  let allowanceCheckNonce = 0;
  let approveAllowanceNonce = 0;

  const resetExecuteApproveAllowance = () => {
    approveAllowanceNonce++;
    approveAllowanceReceipt.value = undefined;
    approveAllowanceError.value = undefined;
    approveAllowanceInProgress.value = false;
  };

  // SYSCOIN: keep the initiation tx hash recoverable across refreshes, but do
  // not let local storage become authoritative for migration state.
  const trackTokenMigrationInitiationHash = (hash: Hash, migrationAssetId: string, accountAddress?: string) => {
    tokenMigrationInitiationHash.value = hash;
    tokenMigrationInitiated.value = true;
    if (!setAllowanceTransactionHashes.value.includes(hash)) {
      setAllowanceTransactionHashes.value.push(hash);
    }
    writeStoredTokenMigrationHash(
      TOKEN_MIGRATION_INITIATION_STORAGE_PREFIX,
      eraNetwork.value.id,
      accountAddress,
      migrationAssetId,
      hash
    );
  };

  const clearTokenMigrationInitiationHash = (migrationAssetId: string, accountAddress?: string) => {
    const hash = tokenMigrationInitiationHash.value;
    tokenMigrationInitiationHash.value = undefined;
    tokenMigrationInitiated.value = false;
    if (hash) {
      setAllowanceTransactionHashes.value = setAllowanceTransactionHashes.value.filter((value) => value !== hash);
    }
    clearStoredTokenMigrationHash(
      TOKEN_MIGRATION_INITIATION_STORAGE_PREFIX,
      eraNetwork.value.id,
      accountAddress,
      migrationAssetId
    );
  };

  const restoreTokenMigrationInitiationHash = (migrationAssetId: string, accountAddress?: string) => {
    const storedHash = readStoredTokenMigrationHash(
      TOKEN_MIGRATION_INITIATION_STORAGE_PREFIX,
      eraNetwork.value.id,
      accountAddress,
      migrationAssetId
    );
    if (storedHash) {
      trackTokenMigrationInitiationHash(storedHash, migrationAssetId, accountAddress);
    }
  };

  const trackTokenMigrationFinalizationHash = (
    hash: Hash,
    migrationAssetId: string,
    l1ChainId: number,
    accountAddress?: string
  ) => {
    tokenMigrationFinalizationHash.value = hash;
    if (!setAllowanceTransactionHashes.value.includes(hash)) {
      setAllowanceTransactionHashes.value.push(hash);
    }
    writeStoredTokenMigrationHash(
      TOKEN_MIGRATION_FINALIZATION_STORAGE_PREFIX,
      l1ChainId,
      accountAddress,
      migrationAssetId,
      hash
    );
  };

  const clearTokenMigrationFinalizationHash = (
    migrationAssetId: string,
    l1ChainId: number,
    accountAddress?: string
  ) => {
    const hash = tokenMigrationFinalizationHash.value;
    tokenMigrationFinalizationHash.value = undefined;
    if (hash) {
      setAllowanceTransactionHashes.value = setAllowanceTransactionHashes.value.filter((value) => value !== hash);
    }
    clearStoredTokenMigrationHash(
      TOKEN_MIGRATION_FINALIZATION_STORAGE_PREFIX,
      l1ChainId,
      accountAddress,
      migrationAssetId
    );
  };

  const restoreTokenMigrationFinalizationHash = (
    migrationAssetId: string,
    l1ChainId: number,
    accountAddress?: string
  ) => {
    const storedHash = readStoredTokenMigrationHash(
      TOKEN_MIGRATION_FINALIZATION_STORAGE_PREFIX,
      l1ChainId,
      accountAddress,
      migrationAssetId
    );
    if (storedHash) {
      trackTokenMigrationFinalizationHash(storedHash, migrationAssetId, l1ChainId, accountAddress);
    }
  };

  const validateTokenMigrationInitiationHash = async (
    provider: { send: (method: string, params: unknown[]) => Promise<any> },
    hash: Hash,
    migrationAssetId: string
  ) => {
    const transaction = (await provider.send("eth_getTransactionByHash", [hash])) as RpcTransaction | null;
    if (!transaction) return false;
    const input = transaction.input ?? transaction.data;
    const expectedInput = encodeFunctionData({
      abi: SYSCOIN_L2_ASSET_TRACKER_ABI,
      functionName: "initiateL1ToGatewayMigrationOnL2",
      args: [migrationAssetId as `0x${string}`],
    });
    if (!transaction.to || transaction.to.toLowerCase() !== L2_ASSET_TRACKER_ADDRESS.toLowerCase()) return false;
    if (input?.toLowerCase() !== expectedInput.toLowerCase()) return false;

    const receipt = await provider.send("eth_getTransactionReceipt", [hash]);
    // A just-submitted tx can be pending after refresh; keep the hash and let
    // proof retrieval report "not mined yet" instead of starting a duplicate tx.
    if (!receipt) return true;
    if (receipt.status !== "0x1") return false;
    if (!receipt.to || receipt.to.toLowerCase() !== L2_ASSET_TRACKER_ADDRESS.toLowerCase()) return false;
    return true;
  };

  const validateTokenMigrationFinalizationHash = async (
    hash: Hash,
    l1AssetTrackerAddress: Address,
    finalizeMigrationParams: SyscoinFinalizeWithdrawalParams
  ) => {
    const publicClient = onboardStore.getPublicClient();
    const transaction = await publicClient.getTransaction({ hash }).catch(() => undefined);
    if (!transaction) return false;
    const expectedInput = encodeFunctionData({
      abi: SYSCOIN_L1_ASSET_TRACKER_ABI,
      functionName: "receiveL1ToGatewayMigrationOnL1",
      args: [finalizeMigrationParams],
    });
    if (!transaction.to || transaction.to.toLowerCase() !== l1AssetTrackerAddress.toLowerCase()) return false;
    if (transaction.input?.toLowerCase() !== expectedInput.toLowerCase()) return false;

    const receipt = await publicClient.getTransactionReceipt({ hash }).catch(() => undefined);
    // Pending L1 finalization should block duplicate submission after refresh.
    if (!receipt) return true;
    return !isReceiptReverted(receipt.status);
  };

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
      tokenMigrationInitiationHash.value = undefined;
      tokenMigrationFinalizationHash.value = undefined;
      approvedAllowance.value = null;
      setAllowanceStatus.value = "not-started";
      setAllowanceTransactionHashes.value = [];
      resetExecuteApproveAllowance();

      if (!tokenAddress.value) {
        isNativeToken.value = null;
        allowanceCheckInProgress.value = false;
        return;
      }
      if (isL2BaseTokenAddress(tokenAddress.value)) {
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

        const accountAddress = getAccount(wagmiConfig).address;
        if (migrationRequired) {
          restoreTokenMigrationInitiationHash(checkedAssetId, accountAddress);
        } else {
          clearStoredTokenMigrationHash(
            TOKEN_MIGRATION_INITIATION_STORAGE_PREFIX,
            eraNetwork.value.id,
            accountAddress,
            checkedAssetId
          );
          if (eraNetwork.value.l1Network) {
            clearStoredTokenMigrationHash(
              TOKEN_MIGRATION_FINALIZATION_STORAGE_PREFIX,
              eraNetwork.value.l1Network.id,
              accountAddress,
              checkedAssetId
            );
          }
        }

        if (!isNativeToken.value) {
          return;
        }

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

  const executeApproveAllowance = async () => {
    const preparationNonce = ++approveAllowanceNonce;
    approveAllowanceInProgress.value = true;
    approveAllowanceError.value = undefined;

    const accountAddress = getAccount(wagmiConfig).address;
    const receipts: { transactionHash: Hash }[] = [];
    const preparationIsCurrent = (selectedTokenAddress: string | undefined, selectedAssetId?: string | null) => {
      return (
        preparationNonce === approveAllowanceNonce &&
        tokenAddress.value === selectedTokenAddress &&
        (selectedAssetId == null || assetId.value === selectedAssetId)
      );
    };
    const stopStalePreparation = () => receipts;

    try {
      setAllowanceStatus.value = "processing";

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

        if (!preparationIsCurrent(registeredTokenAddress)) return stopStalePreparation();
        setAllowanceTransactionHashes.value.push(txRegisterHash);
        setAllowanceStatus.value = "sending";
        receipts.push(
          await retry(
            () =>
              waitForTransactionReceipt(wagmiConfig, {
                chainId: eraNetwork.value.id,
                hash: txRegisterHash,
                onReplaced: (replacement) => {
                  if (preparationIsCurrent(registeredTokenAddress)) {
                    setAllowanceTransactionHashes.value[0] = replacement.transaction.hash;
                  }
                },
              }),
            {
              retries: 3,
              delay: 5_000,
            }
          )
        );
        if (!preparationIsCurrent(registeredTokenAddress)) return stopStalePreparation();
        tokenRegistrationRequired.value = false;
        const registeredAssetId = (await readContract(wagmiConfig, {
          address: L2_NATIVE_TOKEN_VAULT_ADDRESS,
          abi: L2_NATIVE_TOKEN_VAULT_ABI,
          functionName: "assetId",
          args: [registeredTokenAddress],
          chainId: eraNetwork.value.id,
        })) as string;
        const migrationRequired = await checkTokenMigrationRequired(registeredAssetId);
        if (!preparationIsCurrent(registeredTokenAddress)) return stopStalePreparation();
        assetId.value = registeredAssetId;
        tokenMigrationRequired.value = migrationRequired;
      }

      const migrationAssetId = assetId.value;
      const migrationTokenAddress = tokenAddress.value;
      if (tokenMigrationRequired.value && migrationAssetId) {
        if (!tokenMigrationInitiationHash.value) {
          restoreTokenMigrationInitiationHash(migrationAssetId, accountAddress);
        }
        if (tokenMigrationInitiationHash.value) {
          const l2Provider = await providerStore.requestProvider();
          const migrationInitiationIsValid = await validateTokenMigrationInitiationHash(
            l2Provider,
            tokenMigrationInitiationHash.value,
            migrationAssetId
          );
          if (!migrationInitiationIsValid) {
            clearTokenMigrationInitiationHash(migrationAssetId, accountAddress);
          }
        }

        if (!tokenMigrationInitiationHash.value) {
          // SYSCOIN: v31 Gateway-settled chains require each asset's balance
          // accounting to be migrated before withdrawals / interop can leave
          // the chain. This first leg emits the L2->settlement-layer message.
          setAllowanceStatus.value = "waiting-for-signature";
          const txMigrationHash = await writeContract(wagmiConfig, {
            chainId: eraNetwork.value.id,
            address: L2_ASSET_TRACKER_ADDRESS,
            abi: SYSCOIN_L2_ASSET_TRACKER_ABI,
            functionName: "initiateL1ToGatewayMigrationOnL2",
            args: [migrationAssetId as `0x${string}`],
          });

          if (!preparationIsCurrent(migrationTokenAddress, migrationAssetId)) return stopStalePreparation();
          trackTokenMigrationInitiationHash(txMigrationHash, migrationAssetId, accountAddress);
          setAllowanceStatus.value = "sending";
          receipts.push(
            await retry(
              () =>
                waitForTransactionReceipt(wagmiConfig, {
                  chainId: eraNetwork.value.id,
                  hash: txMigrationHash,
                  onReplaced: (replacement) => {
                    if (preparationIsCurrent(migrationTokenAddress, migrationAssetId)) {
                      if (replacement.reason === "cancelled") {
                        clearTokenMigrationInitiationHash(migrationAssetId, accountAddress);
                        throw new Error("L2 Gateway migration initiation transaction was cancelled");
                      }
                      setAllowanceTransactionHashes.value[setAllowanceTransactionHashes.value.length - 1] =
                        replacement.transaction.hash;
                      trackTokenMigrationInitiationHash(replacement.transaction.hash, migrationAssetId, accountAddress);
                    }
                  },
                }),
              {
                retries: 3,
                delay: 5_000,
              }
            )
          );
          if (!preparationIsCurrent(migrationTokenAddress, migrationAssetId)) return stopStalePreparation();
          tokenMigrationInitiated.value = true;
        }

        if (isSyscoinBridgeNetwork(eraNetwork.value) && tokenMigrationInitiationHash.value) {
          const l1Network = eraNetwork.value.l1Network;
          if (!l1Network) throw new Error(`L1 network is not available on ${eraNetwork.value.name}`);
          const l1ChainId = l1Network.id;

          const l2Provider = await providerStore.requestProvider();
          let finalizeMigrationParams;
          try {
            finalizeMigrationParams = await retry(
              () =>
                getSyscoinGatewayMigrationFinalizeParams(
                  l2Provider,
                  tokenMigrationInitiationHash.value as `0x${string}`,
                  eraNetwork.value.id
                ),
              {
                retries: 3,
                delay: 10_000,
              }
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (
              message.includes("proof is not available") ||
              message.includes("not mined yet") ||
              message.includes("log is not available yet")
            ) {
              setAllowanceStatus.value = "done";
              approveAllowanceReceipt.value = receipts;
              return receipts;
            }
            throw error;
          }

          const l1AssetTrackerAddress = (await readContract(wagmiConfig, {
            chainId: l1ChainId,
            address: eraNetwork.value.syscoinBridge.bridgehubAddress,
            abi: SYSCOIN_BRIDGEHUB_ABI,
            functionName: "chainAssetHandler",
          })) as Address;

          if (!tokenMigrationFinalizationHash.value) {
            restoreTokenMigrationFinalizationHash(migrationAssetId, l1ChainId, accountAddress);
          }
          if (tokenMigrationFinalizationHash.value) {
            const migrationFinalizationIsValid = await validateTokenMigrationFinalizationHash(
              tokenMigrationFinalizationHash.value,
              l1AssetTrackerAddress,
              finalizeMigrationParams
            );
            if (!migrationFinalizationIsValid) {
              clearTokenMigrationFinalizationHash(migrationAssetId, l1ChainId, accountAddress);
            }
          }

          if (!tokenMigrationFinalizationHash.value) {
            let switchedToL1 = false;
            try {
              await onboardStore.switchNetworkById(l1ChainId, l1Network.name);
              switchedToL1 = true;
              setAllowanceStatus.value = "waiting-for-signature";
              const txFinalizeHash = await writeContract(wagmiConfig, {
                chainId: l1ChainId,
                address: l1AssetTrackerAddress,
                abi: SYSCOIN_L1_ASSET_TRACKER_ABI,
                functionName: "receiveL1ToGatewayMigrationOnL1",
                args: [finalizeMigrationParams],
              });

              if (!preparationIsCurrent(migrationTokenAddress, migrationAssetId)) return stopStalePreparation();
              trackTokenMigrationFinalizationHash(txFinalizeHash, migrationAssetId, l1ChainId, accountAddress);
              setAllowanceStatus.value = "sending";
              const finalizationReceipt = await retry(
                () =>
                  waitForTransactionReceipt(wagmiConfig, {
                    chainId: l1ChainId,
                    hash: txFinalizeHash,
                    timeout: SYSCOIN_L1_RECEIPT_TIMEOUT,
                    onReplaced: (replacement) => {
                      if (!preparationIsCurrent(migrationTokenAddress, migrationAssetId)) return;
                      if (replacement.reason === "cancelled") {
                        clearTokenMigrationFinalizationHash(migrationAssetId, l1ChainId, accountAddress);
                        throw new Error("L1 Gateway migration finalization transaction was cancelled");
                      }
                      setAllowanceTransactionHashes.value[setAllowanceTransactionHashes.value.length - 1] =
                        replacement.transaction.hash;
                      trackTokenMigrationFinalizationHash(
                        replacement.transaction.hash,
                        migrationAssetId,
                        l1ChainId,
                        accountAddress
                      );
                    },
                  }),
                {
                  retries: 3,
                  delay: 5_000,
                }
              );
              if (isReceiptReverted(finalizationReceipt.status)) {
                clearTokenMigrationFinalizationHash(migrationAssetId, l1ChainId, accountAddress);
                throw new Error("L1 Gateway migration finalization transaction reverted");
              }
              receipts.push(finalizationReceipt);
            } finally {
              if (switchedToL1) {
                await onboardStore.switchNetworkById(eraNetwork.value.id, eraNetwork.value.name).catch(() => undefined);
              }
            }
          }
        }

        const migrationRequired = await checkTokenMigrationRequired(migrationAssetId);
        if (!preparationIsCurrent(migrationTokenAddress, migrationAssetId)) return stopStalePreparation();
        tokenMigrationRequired.value = migrationRequired;
        if (!migrationRequired) {
          clearTokenMigrationInitiationHash(migrationAssetId, accountAddress);
          if (eraNetwork.value.l1Network) {
            clearTokenMigrationFinalizationHash(migrationAssetId, eraNetwork.value.l1Network.id, accountAddress);
          }
        }
        if (migrationRequired) {
          setAllowanceStatus.value = "done";
          approveAllowanceReceipt.value = receipts;
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

        if (!preparationIsCurrent(approvalTokenAddress)) return stopStalePreparation();
        setAllowanceTransactionHashes.value.push(txApproveHash);
        setAllowanceStatus.value = "sending";

        receipts.push(
          await retry(
            () =>
              waitForTransactionReceipt(wagmiConfig, {
                chainId: eraNetwork.value.id,
                hash: txApproveHash,
                onReplaced: (replacement) => {
                  if (preparationIsCurrent(approvalTokenAddress)) {
                    setAllowanceTransactionHashes.value[setAllowanceTransactionHashes.value.length - 1] =
                      replacement.transaction.hash;
                  }
                },
              }),
            {
              retries: 3,
              delay: 5_000,
            }
          )
        );
        if (!preparationIsCurrent(approvalTokenAddress)) return stopStalePreparation();
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
        if (!preparationIsCurrent(allowanceTokenAddress)) return stopStalePreparation();
        approvedAllowance.value = allowance;
      }

      setAllowanceStatus.value = "done";
      approveAllowanceReceipt.value = receipts;
      return receipts;
    } catch (err) {
      if (preparationNonce !== approveAllowanceNonce) return stopStalePreparation();
      setAllowanceStatus.value = "not-started";
      const error = formatError(err as Error);
      if (error) {
        approveAllowanceError.value = error;
        captureException({
          error,
          parentFunctionName: "executeSetAllowance",
          parentFunctionParams: [],
          filePath: "composables/transaction/useCheckNativeAllowance.ts",
        });
        throw error;
      }
    } finally {
      if (preparationNonce === approveAllowanceNonce) {
        approveAllowanceInProgress.value = false;
      }
    }
  };

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
