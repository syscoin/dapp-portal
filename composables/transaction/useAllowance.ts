import { writeContract } from "@wagmi/core";
import { L1Signer, utils } from "zksync-ethers";
import IERC20 from "zksync-ethers/abi/IERC20.json";

import { wagmiConfig } from "@/data/wagmi";
import { SYSCOIN_L1_RECEIPT_TIMEOUT, isSyscoinBridgeNetwork, isSyscoinNativeToken } from "@/utils/syscoinBridge";

import { useSentryLogger } from "../useSentryLogger";

import type { DepositFeeValues } from "../zksync/deposit/useFee";
import type { Hash, TokenAllowance } from "@/types";
import type { BigNumberish } from "ethers";

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

  const {
    result: setAllowanceReceipts,
    inProgress: setAllowanceInProgress,
    error: setAllowanceError,
    execute: executeSetAllowance,
    reset: resetExecuteSetAllowance,
  } = usePromise(
    async () => {
      try {
        setAllowanceStatus.value = "processing";
        if (!accountAddress.value) throw new Error("Account address is not available");

        const contractAddress = await getContractAddress();
        if (!contractAddress) throw new Error("Contract address is not available");

        const wallet = await getL1Signer();
        setAllowanceStatus.value = "waiting-for-signature";

        const receipts = [];

        for (let i = 0; i < approvalAmounts.length; i++) {
          // SYSCOIN: approve the canonical L1 AssetRouter directly. The
          // zksync-ethers helper resolves Era bridge addresses internally.
          const txHash = isSyscoinBridgeNetwork(eraNetwork.value)
            ? await writeContract(wagmiConfig, {
                address: approvalAmounts[i].token as Hash,
                abi: IERC20,
                functionName: "approve",
                args: [contractAddress as Hash, approvalAmounts[i].allowance],
              })
            : ((await wallet?.approveERC20(approvalAmounts[i].token, approvalAmounts[i].allowance))?.hash as Hash);

          setAllowanceTransactionHashes.value.push(txHash as Hash);

          setAllowanceStatus.value = "sending";

          const receipt = await retry(
            () =>
              getPublicClient().waitForTransactionReceipt({
                hash: setAllowanceTransactionHashes.value[i]!,
                // SYSCOIN: L1 approvals happen on Tanenbaum, whose ~150s block
                // time is too close to viem's default 180s timeout.
                timeout: isSyscoinBridgeNetwork(eraNetwork.value) ? SYSCOIN_L1_RECEIPT_TIMEOUT : undefined,
                onReplaced: (replacement) => {
                  setAllowanceTransactionHashes.value[i] = replacement.transaction.hash;
                },
              }),
            {
              retries: 3,
              delay: 5_000,
            }
          );

          receipts.push(receipt);
        }

        await requestAllowance();

        setAllowanceStatus.value = "done";
        return receipts;
      } catch (err) {
        setAllowanceStatus.value = "not-started";
        captureException({
          error: err as Error,
          parentFunctionName: "executeSetAllowance",
          parentFunctionParams: [],
          filePath: "composables/transaction/useAllowance.ts",
        });
        throw err;
      }
    },
    { cache: false }
  );
  const getApprovalAmounts = async (amount: BigNumberish, fee: DepositFeeValues) => {
    const requestedToken = tokenAddress.value;
    if (isSyscoinBridgeNetwork(eraNetwork.value)) {
      if (!requestedToken || isSyscoinNativeToken(requestedToken) || (await shouldSkipAllowance(requestedToken))) {
        approvalAmounts = [];
        return approvalAmounts;
      }
      approvalAmounts = [{ token: requestedToken as Hash, allowance: BigInt(amount.toString()) }];
      return approvalAmounts;
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

    approvalAmounts = (await wallet.getDepositAllowanceParams(requestedToken!, amount, overrides)) as TokenAllowance[];

    return approvalAmounts;
  };

  const setAllowance = async (amount: BigNumberish, fee: DepositFeeValues) => {
    await getApprovalAmounts(amount, fee);
    await executeSetAllowance();
  };

  const resetSetAllowance = () => {
    approvalAmounts = [];
    setAllowanceStatus.value = "not-started";
    setAllowanceTransactionHashes.value = [];
    resetExecuteSetAllowance();
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
