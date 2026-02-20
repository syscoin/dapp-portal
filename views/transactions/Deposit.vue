<template>
  <div>
    <NetworkDeprecationAlert v-if="step === 'form'" />
    <PageTitle v-if="step === 'form'">Bridge</PageTitle>
    <PageTitle v-else-if="step === 'wallet-warning'">Wallet warning</PageTitle>
    <PageTitle
      v-else-if="step === 'confirm'"
      :back-function="
        () => {
          step = 'form';
        }
      "
    >
      Confirm transaction
    </PageTitle>

    <NetworkSelectModal
      v-model:opened="fromNetworkModalOpened"
      title="From"
      :network-key="destinations.ethereum.key"
      @update:network-key="fromNetworkSelected($event)"
    />
    <NetworkSelectModal
      v-model:opened="toNetworkModalOpened"
      title="To"
      :network-key="destination.key"
      @update:network-key="toNetworkSelected($event)"
    />

    <CommonErrorBlock v-if="tokensRequestError" @try-again="fetchBalances">
      Getting tokens error: {{ tokensRequestError.message }}
    </CommonErrorBlock>
    <CommonErrorBlock v-else-if="balanceError" @try-again="fetchBalances">
      Getting balances error: {{ balanceError.message }}
    </CommonErrorBlock>
    <form v-else @submit.prevent="">
      <template v-if="step === 'form'">
        <TransactionWithdrawalsAvailableForClaimAlert />
        <EcosystemBlock
          v-if="eraNetwork.displaySettings?.showPartnerLinks && ecosystemBannerVisible"
          show-close-button
          class="mb-block-padding-1/2 sm:mb-block-gap"
        />
        <CommonInputTransactionAmount
          v-model="amount"
          v-model:error="amountError"
          v-model:token-address="amountInputTokenAddress"
          label="From"
          :tokens="availableTokens"
          :balances="availableBalances"
          :max-amount="maxAmount"
          :approve-required="false"
          :loading="tokensRequestInProgress || balanceInProgress || feeLoading"
          class="mb-block-padding-1/2 sm:mb-block-gap"
        >
          <template #dropdown>
            <CommonButtonDropdown
              :toggled="fromNetworkModalOpened"
              size="xs"
              variant="light"
              @click="fromNetworkModalOpened = true"
            >
              <template #left-icon>
                <img :src="destinations.ethereum.iconUrl" class="h-full w-full" />
              </template>
              <span>{{ destinations.ethereum.label }}</span>
            </CommonButtonDropdown>
          </template>
        </CommonInputTransactionAmount>
        <CommonInputTransactionAddress
          v-model="address"
          label="To"
          :default-label="`To your account ${account.address ? shortenAddress(account.address) : ''}`"
        >
          <template #dropdown>
            <CommonButtonDropdown
              :toggled="toNetworkModalOpened"
              size="xs"
              variant="light"
              @click="toNetworkModalOpened = true"
            >
              <template #left-icon>
                <img :src="destination.iconUrl" class="h-full w-full" />
              </template>
              <span>{{ destination.label }}</span>
            </CommonButtonDropdown>
          </template>
        </CommonInputTransactionAddress>
      </template>
      <template v-else-if="step === 'wallet-warning'">
        <CommonAlert variant="warning" :icon="ExclamationTriangleIcon" class="mb-block-padding-1/2 sm:mb-block-gap">
          <p>
            Make sure your wallet supports {{ eraNetwork.name }} network before adding funds to your account. Otherwise,
            this can result in <span class="font-medium text-red-600">loss of funds</span>. See the list of supported
            wallets on the
            <a
              class="underline underline-offset-2"
              href="https://zksync.dappradar.com/ecosystem?category=non_dapps_wallets"
              target="_blank"
              >Ecosystem</a
            >
            website.
          </p>
        </CommonAlert>
        <CommonButton type="submit" variant="primary" class="mt-block-gap w-full gap-1" @click="buttonContinue()">
          I understand, proceed to bridge
        </CommonButton>
        <CommonButton size="sm" class="mx-auto mt-block-gap w-max" @click="disableWalletWarning()">
          Don't show again
        </CommonButton>
      </template>
      <template v-else-if="step === 'confirm'">
        <CommonCardWithLineButtons>
          <TransactionSummaryTokenEntry label="You bridge" :token="transaction!.token" />
          <TransactionSummaryAddressEntry
            label="From"
            :address="transaction!.from.address"
            :destination="transaction!.from.destination"
          />
          <TransactionSummaryAddressEntry
            label="To"
            :address="transaction!.to.address"
            :destination="transaction!.to.destination"
          />
        </CommonCardWithLineButtons>

        <CommonErrorBlock v-if="transactionError" :retry-button="false" class="mt-4">
          {{ transactionError.message }}
        </CommonErrorBlock>
      </template>
      <template v-else-if="step === 'submitted'">
        <DepositSubmitted :transaction="transactionInfo!" :make-another-transaction="resetForm" />
      </template>

      <template v-if="step === 'form' || step === 'confirm'">
        <CommonErrorBlock v-if="feeError" class="mt-2" @try-again="estimate">
          Fee estimation error: {{ feeError.message }}
        </CommonErrorBlock>
        <div class="mt-4 flex items-center gap-4">
          <transition v-bind="TransitionOpacity()">
            <TransactionFeeDetails
              v-if="!feeError && (fee || feeLoading)"
              label="Fee:"
              :fee-token="feeToken"
              :fee-amount="fee"
              :loading="feeLoading"
            />
          </transition>
          <CommonButtonLabel v-if="!isCustomNode" as="span" class="ml-auto text-right">~15 seconds</CommonButtonLabel>
        </div>
        <transition v-bind="TransitionAlertScaleInOutTransition">
          <CommonAlert v-if="!enoughBalanceToCoverFee" class="mt-4" variant="error" :icon="ExclamationTriangleIcon">
            <p>
              Insufficient <span class="font-medium">{{ feeToken?.symbol }}</span> balance on
              <span class="font-medium">{{ destinations.ethereum.label }}</span> to cover the fee
            </p>
            <NuxtLink :to="{ name: 'receive-methods' }" class="alert-link">Receive funds</NuxtLink>
          </CommonAlert>
        </transition>
        <EthereumTransactionFooter>
          <template #after-checks>
            <template v-if="step === 'form'">
              <CommonButton
                type="submit"
                :disabled="continueButtonDisabled"
                variant="primary"
                class="w-full"
                @click="buttonContinue()"
              >
                Continue
              </CommonButton>
            </template>
            <template v-else-if="step === 'confirm'">
              <transition v-bind="TransitionAlertScaleInOutTransition">
                <div v-if="!enoughBalanceForTransaction" class="mb-4">
                  <CommonAlert
                    v-if="amountError === 'exceeds_max_amount'"
                    variant="error"
                    :icon="ExclamationTriangleIcon"
                  >
                    <p>
                      The inputted amount is higher than the recommended maximum amount. This means your transaction
                      might fail.
                    </p>
                    <button type="button" class="alert-link" @click="step = 'form'">Go back</button>
                  </CommonAlert>
                  <CommonAlert v-else-if="continueButtonDisabled" variant="error" :icon="ExclamationTriangleIcon">
                    <p>
                      The fee has changed since the last estimation. Insufficient
                      <span class="font-medium">{{ selectedToken?.symbol }}</span> balance to pay for transaction.
                      Please go back and adjust the amount to proceed.
                    </p>
                    <button type="button" class="alert-link" @click="step = 'form'">Go back</button>
                  </CommonAlert>
                </div>
              </transition>
              <CommonButton
                :disabled="continueButtonDisabled || transactionStatus !== 'not-started'"
                class="w-full"
                variant="primary"
                @click="buttonContinue()"
              >
                <transition v-bind="TransitionPrimaryButtonText" mode="out-in">
                  <span v-if="transactionStatus === 'processing'">Processing...</span>
                  <span v-else-if="transactionStatus === 'waiting-for-signature'">Waiting for confirmation</span>
                  <span v-else>Bridge now</span>
                </transition>
              </CommonButton>
              <TransactionButtonUnderlineConfirmTransaction :opened="transactionStatus === 'waiting-for-signature'" />
            </template>
          </template>
        </EthereumTransactionFooter>
      </template>
    </form>
  </div>
</template>

<script lang="ts" setup>
import { ExclamationTriangleIcon } from "@heroicons/vue/24/outline";
import { useRouteQuery } from "@vueuse/router";
import { isAddress } from "ethers";

import EthereumTransactionFooter from "@/components/transaction/EthereumTransactionFooter.vue";
import { useSentryLogger } from "@/composables/useSentryLogger";
import useEcosystemBanner from "@/composables/zksync/deposit/useEcosystemBanner";
import useFee from "@/composables/zksync/deposit/useFee";
import useTransaction from "@/composables/zksync/deposit/useTransaction";
import { isCustomNode } from "@/data/networks";
import DepositSubmitted from "@/views/transactions/DepositSubmitted.vue";

import type { Token, TokenAmount } from "@/types";
import type { BigNumberish } from "ethers";
import type { Address } from "viem";

const route = useRoute();
const router = useRouter();

const onboardStore = useOnboardStore();
const tokensStore = useZkSyncTokensStore();
const providerStore = useZkSyncProviderStore();
const zkSyncEthereumBalance = useZkSyncEthereumBalanceStore();
const eraWalletStore = useZkSyncWalletStore();
const { account, walletWarningDisabled } = storeToRefs(onboardStore);
const { eraNetwork } = storeToRefs(providerStore);
const { destinations } = storeToRefs(useDestinationsStore());
const { l1Tokens, baseToken, tokensRequestInProgress, tokensRequestError } = storeToRefs(tokensStore);
const { balance, balanceInProgress, balanceError } = storeToRefs(zkSyncEthereumBalance);

const { captureException } = useSentryLogger();

const toNetworkModalOpened = ref(false);
const toNetworkSelected = (networkKey?: string) => {
  if (destinations.value.ethereum.key === networkKey) {
    router.replace({ name: "bridge-withdraw", query: route.query });
  }
};
const fromNetworkModalOpened = ref(false);
const fromNetworkSelected = (networkKey?: string) => {
  if (destinations.value.era.key === networkKey) {
    router.replace({ name: "bridge-withdraw", query: route.query });
  }
};

const step = ref<"form" | "wallet-warning" | "confirm" | "submitted">("form");
const destination = computed(() => destinations.value.era);

const allTokens = computed<Token[]>(() => {
  if (balance.value?.length) return balance.value;
  return Object.values(l1Tokens.value ?? []);
});
const nativeToken = computed<Token | undefined>(() => {
  const nativeL1Address = baseToken.value?.l1Address?.toLowerCase();
  if (nativeL1Address) {
    const matchedNative = allTokens.value.find((token) => token.address.toLowerCase() === nativeL1Address);
    if (matchedNative) {
      return matchedNative;
    }
  }
  return allTokens.value.find((token) => token.isETH) ?? allTokens.value[0];
});
const availableTokens = computed<Token[]>(() => {
  return nativeToken.value ? [nativeToken.value] : [];
});
const availableBalances = computed<TokenAmount[]>(() => {
  if (!nativeToken.value || !balance.value) return [];
  return balance.value.filter((token) => token.address === nativeToken.value!.address);
});
const routeTokenAddress = computed(() => {
  if (!route.query.token || Array.isArray(route.query.token) || !isAddress(route.query.token)) {
    return;
  }
  return checksumAddress(route.query.token);
});
const defaultToken = computed(() => nativeToken.value);
const selectedTokenAddress = ref<string | undefined>(defaultToken.value?.address);
watch(
  [routeTokenAddress, defaultToken],
  () => {
    if (!defaultToken.value) {
      selectedTokenAddress.value = undefined;
      return;
    }
    if (routeTokenAddress.value && routeTokenAddress.value === defaultToken.value.address) {
      selectedTokenAddress.value = routeTokenAddress.value;
      return;
    }
    selectedTokenAddress.value = defaultToken.value.address;
  },
  { immediate: true }
);
const selectedToken = computed<Token | undefined>(() => {
  if (!selectedTokenAddress.value) {
    return defaultToken.value;
  }
  return availableTokens.value.find((token) => token.address === selectedTokenAddress.value) ?? defaultToken.value;
});
const amountInputTokenAddress = computed({
  get: () => selectedToken.value?.address,
  set: (address) => {
    if (address && nativeToken.value?.address === address) {
      selectedTokenAddress.value = address;
      return;
    }
    selectedTokenAddress.value = defaultToken.value?.address;
  },
});
const tokenBalance = computed<BigNumberish | undefined>(() => {
  return availableBalances.value.find((token) => token.address === selectedToken.value?.address)?.amount;
});

const unsubscribe = onboardStore.subscribeOnAccountChange(() => {
  step.value = "form";
});

const {
  fee: feeValues,
  result: fee,
  inProgress: feeInProgress,
  error: feeError,
  feeToken,
  feeTokenBalance,
  enoughBalanceToCoverFee,
  estimateFee,
  resetFee,
} = useFee(availableTokens, balance);

const queryAddress = useRouteQuery<string | undefined>("address", undefined, {
  transform: String,
  mode: "replace",
});
const address = ref((queryAddress.value !== "undefined" && queryAddress.value) || "");
const isAddressInputValid = computed(() => {
  if (address.value) {
    return isAddress(address.value);
  }
  return true; // Own address by default
});
watch(address, (_address) => {
  queryAddress.value = !_address.length ? undefined : _address;
});

const amount = ref("");
const amountError = ref<string | undefined>();
const maxAmount = computed(() => {
  if (!selectedToken.value || !tokenBalance.value) {
    return undefined;
  }
  if (feeToken.value?.address === selectedToken.value.address) {
    if (BigInt(tokenBalance.value) === 0n) {
      return "0";
    }
    if (!fee.value) {
      return undefined;
    }
    if (BigInt(fee.value) > BigInt(tokenBalance.value)) {
      return "0";
    }
    return String(BigInt(tokenBalance.value) - BigInt(fee.value));
  }
  return tokenBalance.value.toString();
});
const totalComputeAmount = computed(() => {
  try {
    if (!amount.value || !selectedToken.value) {
      return 0n;
    }
    return decimalToBigNumber(amount.value, selectedToken.value.decimals);
  } catch (error) {
    captureException({
      error: error as Error,
      parentFunctionName: "totalComputeAmount",
      parentFunctionParams: [],
      filePath: "views/transactions/Deposit.vue",
    });
    return 0n;
  }
});
const enoughBalanceForTransaction = computed(() => !amountError.value);

const transaction = computed<
  | {
      token: TokenAmount;
      from: { address: string; destination: TransactionDestination };
      to: { address: string; destination: TransactionDestination };
    }
  | undefined
>(() => {
  const toAddress = isAddress(address.value) ? address.value : account.value.address;
  if (!toAddress || !selectedToken.value) {
    return undefined;
  }
  return {
    token: {
      ...selectedToken.value,
      amount: totalComputeAmount.value.toString(),
    },
    from: {
      address: account.value.address!,
      destination: destinations.value.ethereum,
    },
    to: {
      address: toAddress,
      destination: destination.value,
    },
  };
});

const feeLoading = computed(() => feeInProgress.value || (!fee.value && balanceInProgress.value));
const estimate = async () => {
  if (!transaction.value?.from.address || !transaction.value?.to.address || !selectedToken.value) {
    return;
  }
  await estimateFee(transaction.value.to.address, selectedToken.value.address);
};
watch(
  [() => selectedToken.value?.address, () => transaction.value?.from.address, feeTokenBalance],
  () => {
    resetFee();
    estimate();
  },
  { immediate: true }
);

const autoUpdatingFee = computed(
  () => feeTokenBalance.value !== undefined && !feeError.value && fee.value && !feeLoading.value
);
const { reset: resetAutoUpdateEstimate, stop: stopAutoUpdateEstimate } = useInterval(async () => {
  if (!autoUpdatingFee.value) return;
  await estimate();
}, 60000);
watch(
  autoUpdatingFee,
  (updatingFee) => {
    if (!updatingFee) {
      stopAutoUpdateEstimate();
    } else {
      resetAutoUpdateEstimate();
    }
  },
  { immediate: true }
);

const continueButtonDisabled = computed(() => {
  if (
    !transaction.value ||
    !enoughBalanceToCoverFee.value ||
    !(!amountError.value || amountError.value === "exceeds_max_amount") ||
    BigInt(transaction.value.token.amount) === 0n
  )
    return true;
  if (!isAddressInputValid.value) return true;
  if (feeLoading.value || !fee.value) return true;
  return false;
});

const buttonContinue = () => {
  if (continueButtonDisabled.value) {
    return;
  }
  if (step.value === "confirm") {
    makeTransaction();
    return;
  }
  step.value = "confirm";
};
const disableWalletWarning = () => {
  walletWarningDisabled.value = true;
  step.value = "confirm";
};

/* Transaction signing and submitting */
const transfersHistoryStore = useZkSyncTransfersHistoryStore();
const { previousTransactionAddress } = storeToRefs(usePreferencesStore());
const {
  status: transactionStatus,
  error: transactionError,
  commitTransaction,
} = useTransaction(eraWalletStore.getL1Signer);
const { recentlyBridged, ecosystemBannerVisible } = useEcosystemBanner();
const { saveTransaction, waitForCompletion } = useZkSyncTransactionStatusStore();

watch(step, (newStep) => {
  if (newStep === "form") {
    transactionError.value = undefined;
  }
});

const transactionInfo = ref<TransactionInfo | undefined>();
const makeTransaction = async () => {
  if (continueButtonDisabled.value) return;

  const tx = await commitTransaction(
    {
      to: transaction.value!.to.address as Address,
      tokenAddress: transaction.value!.token.address as Address,
      amount: transaction.value!.token.amount,
    },
    feeValues.value!
  );

  if (transactionStatus.value === "done") {
    step.value = "submitted";
    previousTransactionAddress.value = transaction.value!.to.address;
    recentlyBridged.value = true;
  }

  if (tx) {
    zkSyncEthereumBalance.deductBalance(feeToken.value!.address!, fee.value!);
    zkSyncEthereumBalance.deductBalance(transaction.value!.token.address!, String(transaction.value!.token.amount));
    transactionInfo.value = {
      type: "deposit",
      transactionHash: tx.hash,
      timestamp: new Date().toISOString(),
      token: transaction.value!.token,
      from: transaction.value!.from,
      to: transaction.value!.to,
      info: {
        expectedCompleteTimestamp: new Date(new Date().getTime() + ESTIMATED_DEPOSIT_DELAY).toISOString(),
        completed: false,
      },
    };
    saveTransaction(transactionInfo.value);
    silentRouterChange(
      router.resolve({
        name: "transaction-hash",
        params: { hash: transactionInfo.value.transactionHash },
        query: { network: eraNetwork.value.key },
      }).href
    );
    waitForCompletion(transactionInfo.value)
      .then((completedTransaction) => {
        transactionInfo.value = completedTransaction;
        trackEvent("deposit", {
          token: transaction.value!.token.symbol,
          amount: transaction.value!.token.amount,
          to: transaction.value!.to.address,
        });
        setTimeout(() => {
          transfersHistoryStore.reloadRecentTransfers().catch(() => undefined);
          eraWalletStore.requestBalance({ force: true }).catch(() => undefined);
        }, 2000);
      })
      .catch((err) => {
        transactionError.value = err as Error;
        transactionStatus.value = "not-started";
      });
  }
};

const resetForm = () => {
  address.value = "";
  amount.value = "";
  step.value = "form";
  transactionStatus.value = "not-started";
  transactionInfo.value = undefined;
  silentRouterChange((route as unknown as { href: string }).href);
};

const fetchBalances = async (force = false) => {
  await tokensStore.requestTokens({ force });
  if (!account.value.address) return;

  await zkSyncEthereumBalance.requestBalance({ force });
};
fetchBalances();

const unsubscribeFetchBalance = onboardStore.subscribeOnAccountChange((newAddress) => {
  if (!newAddress) return;
  fetchBalances(true);
});

onBeforeUnmount(() => {
  unsubscribe();
  unsubscribeFetchBalance();
});
</script>

<style lang="scss" scoped></style>
