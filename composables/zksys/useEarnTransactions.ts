import { sendTransaction } from "@wagmi/core";
import { encodeFunctionData, type Address, type Hash, type Hex, type TransactionReceipt } from "viem";

import {
  ZKSYS_GAS_TANK_ABI,
  ZKSYS_ISSUER_ABI,
  ZKSYS_REWARD_WEIGHT_REGISTRY_ABI,
  ZKSYS_STAKING_VAULT_ABI,
  ZKSYS_TOKEN_ABI,
} from "@/data/abis/zksysEarnAbi";
import { getSyscoinL2FeeOverrides } from "@/utils/syscoinBridge";
import { wagmiConfig } from "~/data/wagmi";

import { useSentryLogger } from "../useSentryLogger";

export type ZkSysEarnAction =
  | "stake"
  | "withdraw"
  | "activate"
  | "claim"
  | "distribute"
  | "approveGasTank"
  | "fundGasTank"
  | "withdrawGasTank"
  | "burnSurplus";

type EarnTransactionRequest = {
  to: Address;
  data: Hex;
  value?: bigint;
};

export type ZkSysEarnFeeEstimate = {
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** gasLimit * maxFeePerGas, in native SYS wei */
  feeAmount: bigint;
};

// SYSCOIN: Earn actions are plain EVM transactions on the zkSYS L2, signed via
// wagmi and confirmed with the dedicated L2 read client — no zksync-ethers.
export default () => {
  const status = ref<"not-started" | "processing" | "waiting-for-signature" | "committing" | "done">("not-started");
  const action = ref<ZkSysEarnAction | undefined>();
  const error = ref<Error | undefined>();
  const transactionHash = ref<Hash | undefined>();
  const receipt = ref<TransactionReceipt | undefined>();

  const earnStore = useZkSysEarnStore();
  const onboardStore = useOnboardStore();
  const { selectedNetwork } = storeToRefs(useNetworkStore());
  const { captureException } = useSentryLogger();

  const requireContracts = () => {
    const contracts = earnStore.earnContracts;
    if (!contracts) throw new Error(`zkSYS Earn is not available on ${selectedNetwork.value.name}`);
    return contracts;
  };
  const requireAccountAddress = () => {
    const accountAddress = onboardStore.account.address;
    if (!accountAddress) throw new Error("Wallet account is not available");
    return accountAddress as Address;
  };
  const requireGasTank = () => {
    const gasTank = requireContracts().gasTank;
    if (!gasTank) throw new Error(`The zkSYS gas tank is not available on ${selectedNetwork.value.name}`);
    return gasTank;
  };

  const buildRequest = {
    stake: (amount: bigint): EarnTransactionRequest => ({
      to: requireContracts().stakingVault,
      data: encodeFunctionData({ abi: ZKSYS_STAKING_VAULT_ABI, functionName: "deposit" }),
      value: amount,
    }),
    withdraw: (amount: bigint): EarnTransactionRequest => ({
      to: requireContracts().stakingVault,
      data: encodeFunctionData({ abi: ZKSYS_STAKING_VAULT_ABI, functionName: "withdraw", args: [amount] }),
    }),
    activate: (): EarnTransactionRequest => ({
      to: requireContracts().rewardWeightRegistry,
      data: encodeFunctionData({ abi: ZKSYS_REWARD_WEIGHT_REGISTRY_ABI, functionName: "activatePendingWeight" }),
    }),
    claim: (receiver: Address): EarnTransactionRequest => ({
      to: requireContracts().issuer,
      data: encodeFunctionData({ abi: ZKSYS_ISSUER_ABI, functionName: "claim", args: [receiver] }),
    }),
    distribute: (): EarnTransactionRequest => ({
      to: requireContracts().issuer,
      data: encodeFunctionData({ abi: ZKSYS_ISSUER_ABI, functionName: "distribute" }),
    }),
    approveGasTank: (amount: bigint): EarnTransactionRequest => ({
      to: requireContracts().token,
      data: encodeFunctionData({ abi: ZKSYS_TOKEN_ABI, functionName: "approve", args: [requireGasTank(), amount] }),
    }),
    fundGasTank: (amount: bigint): EarnTransactionRequest => ({
      to: requireGasTank(),
      data: encodeFunctionData({ abi: ZKSYS_GAS_TANK_ABI, functionName: "fund", args: [amount] }),
    }),
    withdrawGasTank: (amount: bigint): EarnTransactionRequest => ({
      to: requireGasTank(),
      data: encodeFunctionData({ abi: ZKSYS_GAS_TANK_ABI, functionName: "withdraw", args: [amount] }),
    }),
    burnSurplus: (): EarnTransactionRequest => ({
      to: requireGasTank(),
      data: encodeFunctionData({ abi: ZKSYS_GAS_TANK_ABI, functionName: "burnSurplus" }),
    }),
  };

  const estimateFee = async (request: EarnTransactionRequest, from?: Address): Promise<ZkSysEarnFeeEstimate> => {
    const client = earnStore.getEarnPublicClient();
    const account = from ?? requireAccountAddress();
    const [gasEstimate, block, gasPrice] = await Promise.all([
      client.estimateGas({
        account,
        to: request.to,
        data: request.data,
        value: request.value,
      }),
      client.getBlock(),
      client.getGasPrice(),
    ]);
    const feeOverrides = getSyscoinL2FeeOverrides({
      baseFeePerGas: block.baseFeePerGas,
      suggestedMaxFeePerGas: gasPrice,
    });
    // SYSCOIN: zkSYS RPC estimates can run tight for storage-heavy paths
    // (see transfer gas floor in syscoinBridge.ts); keep a 30% margin.
    const gasLimit = (gasEstimate * 13n) / 10n;
    return {
      gasLimit,
      ...feeOverrides,
      feeAmount: gasLimit * feeOverrides.maxFeePerGas,
    };
  };

  const commitEarnTransaction = async (earnAction: ZkSysEarnAction, request: EarnTransactionRequest) => {
    try {
      error.value = undefined;
      transactionHash.value = undefined;
      receipt.value = undefined;
      action.value = earnAction;
      status.value = "processing";

      const accountAddress = requireAccountAddress();
      const fee = await estimateFee(request, accountAddress);

      status.value = "waiting-for-signature";
      const hash = await sendTransaction(wagmiConfig, {
        chainId: selectedNetwork.value.id,
        account: accountAddress,
        to: request.to,
        data: request.data,
        value: request.value ?? 0n,
        gas: fee.gasLimit,
        // SYSCOIN: set EIP-1559 caps so wallets do not turn the whole max fee
        // into an excessive priority tip on the zkSYS L2.
        maxFeePerGas: fee.maxFeePerGas,
        maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
      });
      transactionHash.value = hash;

      status.value = "committing";
      const client = earnStore.getEarnPublicClient();
      const txReceipt = await client.waitForTransactionReceipt({ hash });
      if (txReceipt.status !== "success") {
        throw new Error("Transaction failed on zkSYS. Check the explorer for details.");
      }
      receipt.value = txReceipt;
      status.value = "done";

      earnStore.refresh().catch(() => undefined);
      return txReceipt;
    } catch (err) {
      error.value = formatError(err as Error);
      status.value = "not-started";
      captureException({
        error: err as Error,
        parentFunctionName: "commitEarnTransaction",
        parentFunctionParams: [earnAction],
        filePath: "composables/zksys/useEarnTransactions.ts",
      });
    }
  };

  const commitStake = (amount: bigint) => commitEarnTransaction("stake", buildRequest.stake(amount));
  const commitWithdraw = (amount: bigint) => commitEarnTransaction("withdraw", buildRequest.withdraw(amount));
  const commitActivate = () => commitEarnTransaction("activate", buildRequest.activate());
  const commitClaim = (receiver: Address) => commitEarnTransaction("claim", buildRequest.claim(receiver));
  const commitDistribute = () => commitEarnTransaction("distribute", buildRequest.distribute());

  /** Fund the gas tank, sending an exact-amount ERC20 approval first if the current allowance is short. */
  const commitFundGasTank = async (amount: bigint) => {
    let needsApproval: boolean;
    try {
      const owner = requireAccountAddress();
      const gasTank = requireGasTank();
      const client = earnStore.getEarnPublicClient();
      const allowance = await client.readContract({
        address: requireContracts().token,
        abi: ZKSYS_TOKEN_ABI,
        functionName: "allowance",
        args: [owner, gasTank],
      });
      needsApproval = allowance < amount;
    } catch (err) {
      error.value = formatError(err as Error);
      return;
    }
    if (needsApproval) {
      const approveReceipt = await commitEarnTransaction("approveGasTank", buildRequest.approveGasTank(amount));
      if (!approveReceipt) return;
    }
    return await commitEarnTransaction("fundGasTank", buildRequest.fundGasTank(amount));
  };
  const commitWithdrawGasTank = (amount: bigint) =>
    commitEarnTransaction("withdrawGasTank", buildRequest.withdrawGasTank(amount));
  const commitBurnSurplus = () => commitEarnTransaction("burnSurplus", buildRequest.burnSurplus());

  const estimateStakeFee = (amount: bigint) => estimateFee(buildRequest.stake(amount));
  const estimateWithdrawFee = (amount: bigint) => estimateFee(buildRequest.withdraw(amount));

  const resetTransaction = () => {
    status.value = "not-started";
    action.value = undefined;
    error.value = undefined;
    transactionHash.value = undefined;
    receipt.value = undefined;
  };

  return {
    status,
    action,
    error,
    transactionHash,
    receipt,

    commitStake,
    commitWithdraw,
    commitActivate,
    commitClaim,
    commitDistribute,
    commitFundGasTank,
    commitWithdrawGasTank,
    commitBurnSurplus,

    estimateStakeFee,
    estimateWithdrawFee,

    resetTransaction,
  };
};
