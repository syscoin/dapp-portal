import {
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  isAddressEqual,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";

import { L2_ASSET_ROUTER_ADDRESS, L2_BASE_TOKEN_ADDRESS } from "./constants";

import type { ZkSyncNetwork } from "@/data/networks";

// SYSCOIN: constants mirror zksync-os-server's L1 priority transaction limits.
export const SYSCOIN_REQUIRED_L1_TO_L2_GAS_PER_PUBDATA_BYTE = 800n;
export const SYSCOIN_DEFAULT_L2_GAS_LIMIT = 2_500_000n;
// SYSCOIN: repeated native deposits can exceed 500k L1 gas once the bridge
// state is warm/non-initial. Keep a margin above observed ~518k estimates.
export const SYSCOIN_DEFAULT_L1_DEPOSIT_GAS_LIMIT = 700_000n;
export const SYSCOIN_DEFAULT_L1_APPROVAL_GAS_LIMIT = 90_000n;

export const SYSCOIN_BRIDGEHUB_ABI = parseAbi([
  "function l2TransactionBaseCost(uint256 chainId, uint256 gasPrice, uint256 l2GasLimit, uint256 l2GasPerPubdataByteLimit) view returns (uint256)",
  "function requestL2TransactionDirect((uint256 chainId, uint256 mintValue, address l2Contract, uint256 l2Value, bytes l2Calldata, uint256 l2GasLimit, uint256 l2GasPerPubdataByteLimit, bytes[] factoryDeps, address refundRecipient) request) payable returns (bytes32 canonicalTxHash)",
  "function requestL2TransactionTwoBridges((uint256 chainId, uint256 mintValue, uint256 l2Value, uint256 l2GasLimit, uint256 l2GasPerPubdataByteLimit, address refundRecipient, address secondBridgeAddress, uint256 secondBridgeValue, bytes secondBridgeCalldata) request) payable returns (bytes32 canonicalTxHash)",
]);

export const SYSCOIN_L2_BASE_TOKEN_ABI = parseAbi(["function withdraw(address l1Receiver) payable"]);

export const SYSCOIN_L2_ASSET_ROUTER_ABI = parseAbi([
  "function withdraw(address l1Receiver, address l2Token, uint256 amount)",
  "function l2TokenAddress(address l1Token) view returns (address)",
]);

export const SYSCOIN_ERC20_ABI = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

export const SYSCOIN_L1_NULLIFIER_ABI = parseAbi([
  "function isWithdrawalFinalized(uint256 chainId, uint256 l2BatchNumber, uint256 l2MessageIndex) view returns (bool)",
  "function finalizeDeposit((uint256 chainId, uint256 l2BatchNumber, uint256 l2MessageIndex, address l2Sender, uint16 l2TxNumberInBatch, bytes message, bytes32[] merkleProof) finalizeWithdrawalParams)",
]);

export const SYSCOIN_L1_MESSENGER_ADDRESS = "0x0000000000000000000000000000000000008008";
export const SYSCOIN_L1_MESSAGE_SENT_ABI = parseAbi([
  "event L1MessageSent(address indexed sender, bytes32 indexed hash, bytes message)",
]);

export type SyscoinBridgeNetwork = ZkSyncNetwork & Required<Pick<ZkSyncNetwork, "syscoinBridge">>;
export type SyscoinFinalizeWithdrawalParams = {
  chainId: bigint;
  l2BatchNumber: bigint;
  l2MessageIndex: bigint;
  l2Sender: Address;
  l2TxNumberInBatch: number;
  message: Hex;
  merkleProof: readonly Hex[];
};

type SyscoinRpcProvider = {
  send: (method: string, params: unknown[]) => Promise<any>;
};

export const isSyscoinBridgeNetwork = (network: ZkSyncNetwork): network is SyscoinBridgeNetwork => {
  return !!network.syscoinBridge;
};

export const isSyscoinNativeToken = (tokenAddress: string) => {
  return isAddressEqual(getAddress(tokenAddress), zeroAddress);
};

export const buildSyscoinL2BaseTokenWithdrawData = (l1Receiver: Address) => {
  return encodeFunctionData({
    abi: SYSCOIN_L2_BASE_TOKEN_ABI,
    functionName: "withdraw",
    args: [l1Receiver],
  });
};

export const buildSyscoinErc20WithdrawData = (l1Receiver: Address, l2Token: Address, amount: bigint) => {
  return encodeFunctionData({
    abi: SYSCOIN_L2_ASSET_ROUTER_ABI,
    functionName: "withdraw",
    args: [l1Receiver, l2Token, amount],
  });
};

export const buildSyscoinWithdrawTransaction = (params: { l1Receiver: Address; l2Token: Address; amount: bigint }) => {
  const isBaseToken = isAddressEqual(getAddress(params.l2Token), getAddress(L2_BASE_TOKEN_ADDRESS));

  return {
    to: (isBaseToken ? L2_BASE_TOKEN_ADDRESS : L2_ASSET_ROUTER_ADDRESS) as Address,
    data: isBaseToken
      ? buildSyscoinL2BaseTokenWithdrawData(params.l1Receiver)
      : buildSyscoinErc20WithdrawData(params.l1Receiver, params.l2Token, params.amount),
    value: isBaseToken ? params.amount : 0n,
  };
};

export const getSyscoinFinalizeWithdrawalParams = async (
  provider: SyscoinRpcProvider,
  withdrawalHash: Hex,
  chainId: number | bigint
): Promise<SyscoinFinalizeWithdrawalParams> => {
  const receipt = await provider.send("eth_getTransactionReceipt", [withdrawalHash]);
  if (!receipt) throw new Error("Withdrawal transaction is not mined yet");

  const l1MessageSentLog = receipt.logs?.find((log: { address: Address; data: Hex; topics: Hex[] }) => {
    if (!isAddressEqual(getAddress(log.address), getAddress(SYSCOIN_L1_MESSENGER_ADDRESS))) return false;
    try {
      decodeEventLog({
        abi: SYSCOIN_L1_MESSAGE_SENT_ABI,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      return true;
    } catch {
      return false;
    }
  });
  if (!l1MessageSentLog) throw new Error("Withdrawal L1 message log is not available yet");

  const { args } = decodeEventLog({
    abi: SYSCOIN_L1_MESSAGE_SENT_ABI,
    data: l1MessageSentLog.data,
    topics: l1MessageSentLog.topics as [Hex, ...Hex[]],
  });

  const l2ToL1Logs = (receipt.l2ToL1Logs ?? []) as { sender: Address; key: Hex }[];
  const l2ToL1LogIndex = l2ToL1Logs.findIndex((log) =>
    isAddressEqual(getAddress(log.sender), getAddress(SYSCOIN_L1_MESSENGER_ADDRESS))
  );
  if (l2ToL1LogIndex < 0) throw new Error("Withdrawal L2 to L1 log is not available yet");

  const proof = await provider.send("zks_getL2ToL1LogProof", [withdrawalHash, l2ToL1LogIndex]);
  if (!proof) throw new Error("Withdrawal proof is not available yet");

  const l2ToL1Log = l2ToL1Logs[l2ToL1LogIndex];
  return {
    chainId: BigInt(chainId),
    l2BatchNumber: BigInt(proof.batchNumber),
    l2MessageIndex: BigInt(proof.id),
    l2Sender: getAddress(`0x${l2ToL1Log.key.slice(-40)}`),
    l2TxNumberInBatch: Number(BigInt(receipt.transactionIndex)),
    message: args.message as Hex,
    merkleProof: proof.proof as readonly Hex[],
  };
};

export const buildSyscoinErc20SecondBridgeCalldata = (l1Token: Address, amount: bigint, l2Receiver: Address) => {
  return encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }, { type: "address" }],
    [l1Token, amount, l2Receiver]
  );
};

export const buildSyscoinTsysDepositRequest = (params: {
  chainId: number | bigint;
  l2Receiver: Address;
  amount: bigint;
  baseCost: bigint;
  l2GasLimit?: bigint;
  l2GasPerPubdataByteLimit?: bigint;
  refundRecipient?: Address;
}) => {
  const l2GasLimit = params.l2GasLimit ?? SYSCOIN_DEFAULT_L2_GAS_LIMIT;
  const l2GasPerPubdataByteLimit = params.l2GasPerPubdataByteLimit ?? SYSCOIN_REQUIRED_L1_TO_L2_GAS_PER_PUBDATA_BYTE;
  const mintValue = params.baseCost + params.amount;

  return {
    chainId: BigInt(params.chainId),
    mintValue,
    l2Contract: params.l2Receiver,
    l2Value: params.amount,
    l2Calldata: "0x" as Hex,
    l2GasLimit,
    l2GasPerPubdataByteLimit,
    factoryDeps: [] as Hex[],
    refundRecipient: params.refundRecipient ?? params.l2Receiver,
  };
};

export const buildSyscoinErc20DepositRequest = (params: {
  chainId: number | bigint;
  l1Token: Address;
  amount: bigint;
  l2Receiver: Address;
  baseCost: bigint;
  sharedBridgeAddress: Address;
  l2GasLimit?: bigint;
  l2GasPerPubdataByteLimit?: bigint;
  refundRecipient?: Address;
}) => {
  const l2GasLimit = params.l2GasLimit ?? SYSCOIN_DEFAULT_L2_GAS_LIMIT;
  const l2GasPerPubdataByteLimit = params.l2GasPerPubdataByteLimit ?? SYSCOIN_REQUIRED_L1_TO_L2_GAS_PER_PUBDATA_BYTE;

  return {
    chainId: BigInt(params.chainId),
    mintValue: params.baseCost,
    l2Value: 0n,
    l2GasLimit,
    l2GasPerPubdataByteLimit,
    refundRecipient: params.refundRecipient ?? params.l2Receiver,
    secondBridgeAddress: params.sharedBridgeAddress,
    secondBridgeValue: 0n,
    secondBridgeCalldata: buildSyscoinErc20SecondBridgeCalldata(params.l1Token, params.amount, params.l2Receiver),
  };
};

export const encodeSyscoinTsysDeposit = (request: ReturnType<typeof buildSyscoinTsysDepositRequest>) => {
  return encodeFunctionData({
    abi: SYSCOIN_BRIDGEHUB_ABI,
    functionName: "requestL2TransactionDirect",
    args: [request],
  });
};

export const encodeSyscoinErc20Deposit = (request: ReturnType<typeof buildSyscoinErc20DepositRequest>) => {
  return encodeFunctionData({
    abi: SYSCOIN_BRIDGEHUB_ABI,
    functionName: "requestL2TransactionTwoBridges",
    args: [request],
  });
};
