import { writeContract } from "@wagmi/core";
import { L1Signer, utils } from "zksync-ethers";
import IERC20 from "zksync-ethers/abi/IERC20.json";

import { wagmiConfig } from "@/data/wagmi";
import { SYSCOIN_L1_RECEIPT_TIMEOUT, isSyscoinBridgeNetwork, isSyscoinNativeToken } from "@/utils/syscoinBridge";

import { useSentryLogger } from "../useSentryLogger";

import type { DepositFeeValues } from "../zksync/deposit/useFee";
import type { Hash, TokenAllowance } from "@/types";
import type { BigNumberish } from "ethers";
import type { TransactionReceipt } from "viem";

export default (
  accountAddress: Ref<string | undefined>,
  tokenAddress: Ref<string | undefined>,
  getContractAddress: () => Promise<string | undefined>,
  getL1Signer: () => Promise<L1Signer | undefined>,
  shouldSkipAllowance: (tokenAddress: string) => Promise<boolean> = () => Promise.resolve(false)
) => {
  const { getPublicClient } = useOnboardStore();
  const { eraNetwork } = storeToRefs(useZkSyncProviderStore());
  const { captureException } = useSentryLogger();
  const result = ref<bigint | undefined>();
  const inProgress = ref(false);
  const error = ref<Error | undefined>();
  let allowanceRequestNonce = 0;

  const requestAllowance = async () => {
    const requestNonce = ++allowanceRequestNonce;
    const requestedAccount = accountAddress.value;
    const requestedToken = tokenAddress.value;
    result.value = undefined;
    error.value = undefined;

    if (!requestedAccount || !requestedToken || requestedToken === utils.ETH_ADDRESS) {
      inProgress.value = false;
      return;
    }

    inProgress.value = true;
    try {
      if (await shouldSkipAllowance(requestedToken)) return;

      const contractAddress = await getContractAddress();
      if (!contractAddress) throw new Error("Contract address is not available");

      const publicClient = getPublicClient();
      const allowance = (await publicClient!.readContract({
        address: requestedToken as Hash,
        abi: IERC20,
        functionName: "allowance",
        args: [requestedAccount, contractAddress],
      })) as bigint;
      if (requestNonce === allowanceRequestNonce) result.value = BigInt(allowance);
    } catch (err) {
      if (requestNonce !== allowanceRequestNonce) return;
      const formattedError = formatError(err as Error);
      if (!formattedError) return;
      error.value = formattedError;
      captureException({
        error: formattedError,
        parentFunctionName: "requestAllowance",
        parentFunctionParams: [requestedAccount, requestedToken],
        filePath: "composables/transaction/useAllowance.ts",
      });
    } finally {
      if (requestNonce === allowanceRequestNonce) inProgress.value = false;
    }
  };

  let approvalAmounts: TokenAllowance[] = [];
  const setAllowanceStatus = ref<"not-started" | "processing" | "waiting-for-signature" | "sending" | "done">(
    "not-started"
  );
  const setAllowanceTransactionHashes = ref<(Hash | undefined)[]>([]);
  const setAllowanceReceipts = ref<TransactionReceipt[] | undefined>();
  const executeSetAllowanceInProgress = ref(false);
  const setAllowanceError = ref<Error | undefined>();
  const allowancePreparationInProgress = ref(false);
  let allowancePreparationNonce = 0;

  const executeSetAllowance = async () => {
    const executionNonce = allowancePreparationNonce;
    const executionApprovalAmounts = approvalAmounts;
    executeSetAllowanceInProgress.value = true;
    setAllowanceError.value = undefined;
    setAllowanceStatus.value = "processing";
    try {
      if (!accountAddress.value) throw new Error("Account address is not available");

      const contractAddress = await getContractAddress();
      if (!contractAddress) throw new Error("Contract address is not available");

      const wallet = await getL1Signer();
      if (executionNonce !== allowancePreparationNonce) return [];
      setAllowanceStatus.value = "waiting-for-signature";

      const receipts: TransactionReceipt[] = [];

      for (let i = 0; i < executionApprovalAmounts.length; i++) {
        if (executionNonce !== allowancePreparationNonce) return receipts;
        // SYSCOIN: approve the canonical L1 AssetRouter directly. The
        // zksync-ethers helper resolves Era bridge addresses internally.
        const txHash = isSyscoinBridgeNetwork(eraNetwork.value)
          ? await writeContract(wagmiConfig, {
              address: executionApprovalAmounts[i].token as Hash,
              abi: IERC20,
              functionName: "approve",
              args: [contractAddress as Hash, executionApprovalAmounts[i].allowance],
            })
          : ((await wallet?.approveERC20(executionApprovalAmounts[i].token, executionApprovalAmounts[i].allowance))
              ?.hash as Hash);

        if (!txHash) throw new Error("Allowance transaction hash is not available");
        if (executionNonce !== allowancePreparationNonce) return receipts;
        setAllowanceTransactionHashes.value.push(txHash as Hash);
        setAllowanceStatus.value = "sending";

        const receipt = await retry(
          () =>
            getPublicClient().waitForTransactionReceipt({
              hash: txHash,
              // SYSCOIN: L1 approvals happen on Tanenbaum, whose ~150s block
              // time is too close to viem's default 180s timeout.
              timeout: isSyscoinBridgeNetwork(eraNetwork.value) ? SYSCOIN_L1_RECEIPT_TIMEOUT : undefined,
              onReplaced: (replacement) => {
                if (executionNonce === allowancePreparationNonce) {
                  setAllowanceTransactionHashes.value[i] = replacement.transaction.hash;
                }
              },
            }),
          {
            retries: 3,
            delay: 5_000,
          }
        );

        if (executionNonce !== allowancePreparationNonce) return receipts;
        receipts.push(receipt);
      }

      await requestAllowance();
      if (executionNonce !== allowancePreparationNonce) return receipts;

      setAllowanceReceipts.value = receipts;
      setAllowanceStatus.value = "done";
      return receipts;
    } catch (err) {
      if (executionNonce !== allowancePreparationNonce) return [];
      const formattedError = formatError(err as Error);
      if (!formattedError) return [];
      setAllowanceStatus.value = "not-started";
      setAllowanceError.value = formattedError;
      captureException({
        error: formattedError,
        parentFunctionName: "executeSetAllowance",
        parentFunctionParams: [],
        filePath: "composables/transaction/useAllowance.ts",
      });
      throw formattedError;
    } finally {
      if (executionNonce === allowancePreparationNonce) executeSetAllowanceInProgress.value = false;
    }
  };
  const setAllowanceInProgress = computed(
    () => allowancePreparationInProgress.value || executeSetAllowanceInProgress.value
  );
  const getApprovalAmounts = async (amount: BigNumberish, fee: DepositFeeValues) => {
    const requestedToken = tokenAddress.value;
    if (isSyscoinBridgeNetwork(eraNetwork.value)) {
      if (!requestedToken || isSyscoinNativeToken(requestedToken) || (await shouldSkipAllowance(requestedToken))) {
        return [];
      }
      return [{ token: requestedToken as Hash, allowance: BigInt(amount.toString()) }];
    }

    const wallet = await getL1Signer();
    if (!wallet) throw new Error("Wallet is not available");

    // We need to pass the overrides in order to get the correct deposits allowance params
    const overrides = {
      gasPrice: fee.gasPrice,
      gasLimit: fee.l1GasLimit,
      maxFeePerGas: fee.maxFeePerGas,
      maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
    };
    if (overrides.gasPrice && overrides.maxFeePerGas) {
      overrides.gasPrice = undefined;
    }

    return (await wallet.getDepositAllowanceParams(requestedToken!, amount, overrides)) as TokenAllowance[];
  };

  const setAllowance = async (amount: BigNumberish, fee: DepositFeeValues) => {
    const preparationNonce = ++allowancePreparationNonce;
    const requestedToken = tokenAddress.value;
    let executionStarted = false;
    allowancePreparationInProgress.value = true;
    setAllowanceError.value = undefined;
    setAllowanceStatus.value = "processing";
    try {
      const preparedApprovalAmounts = await getApprovalAmounts(amount, fee);
      if (preparationNonce !== allowancePreparationNonce || tokenAddress.value !== requestedToken) return;
      approvalAmounts = preparedApprovalAmounts;
      executionStarted = true;
      await executeSetAllowance();
    } catch (err) {
      if (preparationNonce !== allowancePreparationNonce) return;
      if (executionStarted) throw err;
      const formattedError = formatError(err as Error);
      if (!formattedError) return;
      setAllowanceStatus.value = "not-started";
      setAllowanceError.value = formattedError;
      captureException({
        error: formattedError,
        parentFunctionName: "setAllowance",
        parentFunctionParams: [requestedToken],
        filePath: "composables/transaction/useAllowance.ts",
      });
      throw formattedError;
    } finally {
      if (preparationNonce === allowancePreparationNonce) allowancePreparationInProgress.value = false;
    }
  };

  const resetSetAllowance = () => {
    ++allowancePreparationNonce;
    approvalAmounts = [];
    allowancePreparationInProgress.value = false;
    executeSetAllowanceInProgress.value = false;
    setAllowanceStatus.value = "not-started";
    setAllowanceTransactionHashes.value = [];
    setAllowanceReceipts.value = undefined;
    setAllowanceError.value = undefined;
  };

  watch(
    [accountAddress, tokenAddress],
    () => {
      requestAllowance();
      resetSetAllowance();
    },
    { immediate: true }
  );

  return {
    result: computed(() => result.value),
    inProgress: computed(() => inProgress.value),
    error: computed(() => error.value),
    requestAllowance,

    setAllowanceTransactionHashes,
    setAllowanceReceipts,
    setAllowanceStatus,
    setAllowanceInProgress,
    setAllowanceError,
    setAllowance,
    resetSetAllowance,
    getApprovalAmounts,
  };
};
