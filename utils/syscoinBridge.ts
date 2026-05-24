import {
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
export const SYSCOIN_DEFAULT_L1_DEPOSIT_GAS_LIMIT = 500_000n;
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
  "function finalizeDeposit((uint256 chainId, uint256 l2BatchNumber, uint256 l2MessageIndex, address l2Sender, uint16 l2TxNumberInBatch, bytes message, bytes32[] merkleProof) finalizeWithdrawalParams)",
]);

export type SyscoinBridgeNetwork = ZkSyncNetwork & Required<Pick<ZkSyncNetwork, "syscoinBridge">>;

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
