import { createEthersClient, createEthersSdk } from "@matterlabs/zksync-js/ethers";
import { type BigNumberish } from "ethers";
import { type Address, type Hash } from "viem";
import { L1Signer } from "zksync-ethers";

import { useSentryLogger } from "@/composables/useSentryLogger";

import type { DepositFeeValues } from "@/composables/zksync/deposit/useFee";

export default (getL1Signer: () => Promise<L1Signer | undefined>) => {
  const status = ref<"not-started" | "processing" | "waiting-for-signature" | "done">("not-started");
  const error = ref<Error | undefined>();
  const ethTransactionHash = ref<Hash | undefined>();
  const eraWalletStore = useZkSyncWalletStore();
  const { captureException } = useSentryLogger();

  const { validateAddress } = useScreening();

  const commitTransaction = async (
    transaction: {
      to: Address;
      tokenAddress: Address;
      amount: BigNumberish;
    },
    fee: DepositFeeValues
  ): Promise<{ hash: Hash } | undefined> => {
    try {
      error.value = undefined;

      status.value = "processing";
      const wallet = await getL1Signer();
      if (!wallet) throw new Error("Wallet is not available");

      await eraWalletStore.walletAddressValidate();
      await validateAddress(transaction.to);

      status.value = "waiting-for-signature";

      const client = createEthersClient({ l1: wallet.provider, l2: wallet.providerL2, signer: wallet });
      const sdk = createEthersSdk(client);

      const deposit = await sdk.deposits.create({
        to: transaction.to,
        token: transaction.tokenAddress,
        amount: BigInt(transaction.amount.toString()),
        gasPerPubdata: fee.gasPerPubdata,
      });

      const depositResponse = {
        hash: deposit.l1TxHash,
      };

      ethTransactionHash.value = depositResponse.hash as Hash;
      status.value = "done";
      return { hash: depositResponse.hash as Hash };
    } catch (err) {
      error.value = formatError(err as Error);
      status.value = "not-started";
      captureException({
        error: err as Error,
        parentFunctionName: "commitTransaction",
        parentFunctionParams: [transaction, fee],
        filePath: "composables/zksync/deposit/useTransaction.ts",
      });
    }
  };

  return {
    status,
    error,
    ethTransactionHash,
    commitTransaction,
  };
};
