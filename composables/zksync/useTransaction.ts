import { useMemoize } from "@vueuse/core";
import {
  getWalletClient,
  getPublicClient,
  prepareTransactionRequest,
  custom,
  sendTransaction,
  readContract,
} from "@wagmi/core";
import { ethers, type BigNumberish, type ContractTransaction } from "ethers";
import { createWalletClient, type Hash } from "viem";
import { eip712WalletActions } from "viem/zksync";
import { EIP712_TX_TYPE } from "zksync-ethers/build/utils";

import { L2_NATIVE_TOKEN_VAULT_ABI } from "@/data/abis/nativeTokenVaultAbi";
import { isCustomNode } from "@/data/networks";
import { L2_BASE_TOKEN_ADDRESS, L2_NATIVE_TOKEN_VAULT_ADDRESS } from "@/utils/constants";
import {
  buildSyscoinNativeTokenWithdrawTransaction,
  buildSyscoinTransferTransaction,
  buildSyscoinWithdrawTransaction,
  getSyscoinL2FeeOverrides,
  isSyscoinBridgeNetwork,
  isSyscoinL2BaseToken,
} from "@/utils/syscoinBridge";
import { wagmiConfig } from "~/data/wagmi";

import { useSentryLogger } from "../useSentryLogger";

import type { TokenAmount } from "@/types";
import type { Provider, Signer } from "zksync-ethers";
import type { Address, PaymasterParams } from "zksync-ethers/build/types";

const ZERO_HASH = "0x0000000000000000000000000000000000000000000000000000000000000000";

type TransactionParams = {
  type: "transfer" | "withdrawal";
  to: string;
  tokenAddress: string;
  amount: BigNumberish;
  isNativeToken?: boolean | null;
  // SYSCOIN: separates v31 asset-id withdrawal calldata from approval gating.
  usesAssetIdWithdrawal?: boolean;
  assetId?: string | null;
  bridgeAddress?: string;
};

export const isWithdrawalManualFinalizationRequired = (_token: TokenAmount, l1NetworkId: number) => {
  return l1NetworkId === 1 || isCustomNode;
};

export default (getSigner: () => Promise<Signer | undefined>, getProvider: () => Promise<Provider>) => {
  const status = ref<"not-started" | "processing" | "waiting-for-signature" | "done">("not-started");
  const error = ref<Error | undefined>();
  const transactionHash = ref<string | undefined>();
  const eraWalletStore = useZkSyncWalletStore();
  const { captureException } = useSentryLogger();
  const { selectedNetwork } = storeToRefs(useNetworkStore());

  const retrieveBridgeAddresses = useMemoize(() =>
    getProvider().then((provider) => provider.getDefaultBridgeAddresses())
  );
  const { validateAddress } = useScreening();

  // We need to calculate gas limit with custom function since the new version of the SDK fails
  const getCustomWithdrawTx = async (transaction: {
    token: Address;
    amount: BigNumberish;
    from?: Address;
    to?: Address;
    bridgeAddress?: Address;
    paymasterParams?: PaymasterParams;
    overrides?: ethers.Overrides;
  }): Promise<ContractTransaction> => {
    const { ...tx } = transaction;
    if ((tx.to === null || tx.to === undefined) && (tx.from === null || tx.from === undefined)) {
      throw new Error("Withdrawal target address is undefined!");
    }
    tx.to ??= tx.from;
    tx.overrides ??= {};
    tx.overrides.from ??= tx.from;
    tx.overrides.type ??= EIP712_TX_TYPE;

    const provider = await getProvider();
    const bridge = await provider.connectL2Bridge(tx.bridgeAddress!);
    let populatedTx = await bridge.withdraw.populateTransaction(tx.to!, tx.token, tx.amount, tx.overrides);
    if (tx.paymasterParams) {
      populatedTx = {
        ...populatedTx,
        customData: {
          paymasterParams: tx.paymasterParams,
        },
      };
    }

    return populatedTx;
  };

  const commitTransaction = async (
    transaction: TransactionParams,
    fee: { gasPrice: BigNumberish; gasLimit: BigNumberish }
  ) => {
    let accountAddress = "";
    try {
      error.value = undefined;

      status.value = "processing";
      const signer = await getSigner();
      if (!signer) throw new Error("Wallet signer is not available");

      accountAddress = await signer.getAddress();

      await eraWalletStore.walletAddressValidate();
      await validateAddress(transaction.to);

      status.value = "waiting-for-signature";

      if (isSyscoinBridgeNetwork(selectedNetwork.value)) {
        const isSyscoinErc20Withdrawal =
          transaction.type === "withdrawal" && !isSyscoinL2BaseToken(transaction.tokenAddress);
        const syscoinWithdrawalAssetId =
          isSyscoinErc20Withdrawal && !transaction.assetId
            ? ((await readContract(wagmiConfig, {
                address: L2_NATIVE_TOKEN_VAULT_ADDRESS,
                abi: L2_NATIVE_TOKEN_VAULT_ABI,
                functionName: "assetId",
                args: [transaction.tokenAddress],
                chainId: selectedNetwork.value.id,
              })) as string)
            : transaction.assetId;
        if (isSyscoinErc20Withdrawal && (!syscoinWithdrawalAssetId || syscoinWithdrawalAssetId === ZERO_HASH)) {
          throw new Error("Asset id is required for Syscoin ERC20 withdrawals");
        }
        // SYSCOIN: zkSYS uses standard EVM transactions. Avoid ZKsync SDK
        // EIP-712 tx type 0x71 and zks_gasPerPubdata for account transfers.
        // Withdrawals still call OS system contracts directly and are claimed
        // later through the L1 nullifier.
        const syscoinTx =
          transaction.type === "transfer"
            ? buildSyscoinTransferTransaction({
                recipient: transaction.to as `0x${string}`,
                l2Token: transaction.tokenAddress as `0x${string}`,
                amount: BigInt(transaction.amount.toString()),
              })
            : transaction.usesAssetIdWithdrawal && syscoinWithdrawalAssetId
            ? buildSyscoinNativeTokenWithdrawTransaction({
                assetId: syscoinWithdrawalAssetId as `0x${string}`,
                l1Receiver: transaction.to as `0x${string}`,
                l2Token: transaction.tokenAddress as `0x${string}`,
                amount: BigInt(transaction.amount.toString()),
              })
            : buildSyscoinWithdrawTransaction({
                assetId: syscoinWithdrawalAssetId as `0x${string}` | null,
                l1Receiver: transaction.to as `0x${string}`,
                l2Token: transaction.tokenAddress as `0x${string}`,
                amount: BigInt(transaction.amount.toString()),
              });
        const syscoinFeeOverrides = getSyscoinL2FeeOverrides({
          suggestedMaxFeePerGas: BigInt(fee.gasPrice.toString()),
        });
        const hash = await sendTransaction(wagmiConfig, {
          chainId: selectedNetwork.value.id,
          ...syscoinTx,
          account: accountAddress as `0x${string}`,
          gas: BigInt(fee.gasLimit.toString()),
          // SYSCOIN: set EIP-1559 caps for L2 txs so wallets do not
          // turn the full max fee into an excessive priority tip.
          ...syscoinFeeOverrides,
        });

        const txResponse = { hash };
        transactionHash.value = hash;
        status.value = "done";
        return txResponse;
      }

      const provider = await getProvider();
      const getRequiredBridgeAddress = async () => {
        if (transaction.bridgeAddress) return transaction.bridgeAddress;
        if (transaction.tokenAddress === L2_BASE_TOKEN_ADDRESS) return undefined;
        const bridgeAddresses = await retrieveBridgeAddresses();
        return bridgeAddresses.sharedL2;
      };
      const bridgeAddress = transaction.type === "withdrawal" ? await getRequiredBridgeAddress() : undefined;

      if (transaction.bridgeAddress && transaction.type !== "transfer") {
        const txRequest = await getCustomWithdrawTx({
          from: accountAddress,
          to: transaction.to,
          token: transaction.tokenAddress,
          amount: transaction.amount,
          bridgeAddress,
          overrides: {
            gasPrice: fee.gasPrice,
            gasLimit: fee.gasLimit,
          },
        });

        const txResponse = await signer.sendTransaction(txRequest);

        transactionHash.value = txResponse.hash;
        status.value = "done";

        return txResponse;
      }

      const txRequest = await provider[transaction.type === "transfer" ? "getTransferTx" : "getWithdrawTx"]({
        from: accountAddress,
        to: transaction.to,
        token: transaction.tokenAddress,
        amount: transaction.amount,
        bridgeAddress,
        overrides: {
          gasPrice: fee.gasPrice,
          gasLimit: fee.gasLimit,
        },
      });

      if (selectedNetwork.value.isPrividium) {
        const wagmiClient = await getWalletClient(wagmiConfig);
        if (!wagmiClient) throw new Error("Wagmi client is not available");
        const { getPrividiumInstance } = usePrividiumStore();

        const prividiumInstance = getPrividiumInstance();
        if (!prividiumInstance) throw new Error("Prividium instance is not available");
        const wagmiPublicClient = getPublicClient(wagmiConfig, {
          chainId: prividiumInstance.chain.id,
        });
        if (!wagmiPublicClient) throw new Error("Wagmi public client is not available");

        // SYSCOIN: wagmiConfig can now contain standard-EVM Syscoin chains, so
        // keep this Prividium-only ZKsync EIP-712 path explicitly typed.
        const prepared = await prepareTransactionRequest(wagmiConfig, {
          chain: wagmiClient.chain,
          account: wagmiClient.account,
          to: txRequest.to as Address,
          from: txRequest.from as Address,
          data: txRequest.data as Hash,
          value: BigInt(txRequest.value || 0) as bigint,
          type: "eip712",
        } as any);

        const client = createWalletClient({
          account: wagmiClient.account,
          chain: prividiumInstance.chain,
          transport: custom({
            async request({ method, params }: any) {
              const response = await wagmiClient.transport.request({ method, params });
              return response;
            },
          }),
        }).extend(eip712WalletActions());
        const signature = await client.signTransaction({
          ...prepared,
          type: "eip712",
        } as any);

        const txResponse = {
          hash: await wagmiPublicClient.sendRawTransaction({ serializedTransaction: signature }),
        };

        transactionHash.value = txResponse.hash;
        status.value = "done";
        return txResponse;
      } else {
        const txResponse = await signer.sendTransaction(txRequest);
        transactionHash.value = txResponse.hash;
        status.value = "done";
        return txResponse;
      }
    } catch (err) {
      error.value = formatError(err as Error);
      status.value = "not-started";
      captureException({
        error: err as Error,
        parentFunctionName: "commitTransaction",
        parentFunctionParams: [transaction, fee],
        filePath: "composables/zksync/useTransaction.ts",
      });
    }
  };

  return {
    status,
    error,
    transactionHash,
    commitTransaction,
  };
};
