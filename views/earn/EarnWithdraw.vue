<template>
  <div>
    <PageTitle v-if="step === 'form'" :fallback-route="{ name: 'earn' }">Withdraw {{ stakeSymbol }}</PageTitle>
    <PageTitle v-else-if="step === 'confirm'" :back-function="() => (step = 'form')">Confirm withdrawal</PageTitle>

    <template v-if="!isEarnAvailable">
      <CommonAlert variant="warning" :icon="ExclamationTriangleIcon">
        <p>zkSYS Earn is not available on {{ selectedNetwork.name }}.</p>
      </CommonAlert>
    </template>

    <form v-else @submit.prevent="">
      <!-- Step 1: form -->
      <template v-if="step === 'form'">
        <CommonInputTransactionAmount
          v-model="amount"
          v-model:error="amountError"
          label="Amount"
          :token-address="nativeToken.address"
          :tokens="[nativeToken]"
          :balances="stakedBalances"
          :max-amount="maxAmount"
          :loading="positionLoading || feeInProgress"
          class="mb-block-padding-1/2 sm:mb-block-gap"
        />

        <CommonAlert
          variant="neutral"
          size="sm"
          :icon="InformationCircleIcon"
          class="mb-block-padding-1/2 sm:mb-block-gap"
        >
          <p>
            Withdrawals are instant — no unbonding. Your reward weight drops immediately, but rewards you have already
            earned stay claimable.
          </p>
        </CommonAlert>

        <CommonHeightTransition :opened="hasPendingStakeWeight">
          <CommonAlert
            variant="warning"
            size="sm"
            :icon="ExclamationTriangleIcon"
            class="mb-block-padding-1/2 sm:mb-block-gap"
          >
            <p>
              You have stake weight queued in warm-up. Withdrawing now cancels that queue and your weight is reset to
              the new, lower stake immediately.
            </p>
          </CommonAlert>
        </CommonHeightTransition>

        <CommonErrorBlock v-if="feeError" class="mb-2" @try-again="estimateFee">
          Fee estimation error: {{ feeError.message }}
        </CommonErrorBlock>

        <TransactionFooter>
          <template #after-checks>
            <div class="flex w-full flex-col items-center">
              <TransactionFeeDetails
                class="mb-2"
                label="Fee:"
                :fee-amount="feeAmount"
                :fee-token="nativeToken"
                :loading="feeInProgress"
              />
              <CommonButton
                type="submit"
                :disabled="continueDisabled"
                variant="primary"
                class="w-full"
                @click="step = 'confirm'"
              >
                Continue
              </CommonButton>
            </div>
          </template>
        </TransactionFooter>
      </template>

      <!-- Step 2: confirm -->
      <template v-else-if="step === 'confirm'">
        <CommonCardWithLineButtons>
          <TransactionSummaryTokenEntry label="You withdraw" :token="tokenWithAmount" />
        </CommonCardWithLineButtons>

        <CommonHeightTransition :opened="!!txError">
          <CommonAlert variant="error" size="sm" :icon="ExclamationTriangleIcon" class="mt-block-gap">
            <p>{{ txError?.message }}</p>
          </CommonAlert>
        </CommonHeightTransition>

        <TransactionFooter>
          <template #after-checks>
            <div class="flex w-full flex-col items-center">
              <TransactionFeeDetails
                class="mb-2"
                label="Fee:"
                :fee-amount="feeAmount"
                :fee-token="nativeToken"
                :loading="feeInProgress"
              />
              <CommonButton :disabled="txInProgress" variant="primary" class="w-full" @click="makeTransaction()">
                <transition v-bind="TransitionPrimaryButtonText" mode="out-in">
                  <span v-if="txStatus === 'processing'">Processing...</span>
                  <span v-else-if="txStatus === 'waiting-for-signature'">Waiting for confirmation</span>
                  <span v-else-if="txStatus === 'committing'">Withdrawing...</span>
                  <span v-else>Withdraw {{ stakeSymbol }}</span>
                </transition>
              </CommonButton>
              <TransactionButtonUnderlineContinueInWallet :opened="txStatus === 'waiting-for-signature'" />
            </div>
          </template>
        </TransactionFooter>
      </template>

      <!-- Step 3: submitted -->
      <template v-else-if="step === 'submitted'">
        <CommonContentBlock class="text-center">
          <CheckCircleIcon class="mx-auto h-14 w-14 text-success-600" aria-hidden="true" />
          <div class="mt-3 text-xl font-semibold">{{ withdrawnAmountDisplay }} {{ stakeSymbol }} withdrawn</div>
          <p class="mt-2 text-neutral-700 dark:text-neutral-400">
            Your {{ stakeSymbol }} is back in your wallet. Any rewards you already earned remain claimable on the Earn
            page.
          </p>
          <a
            v-if="transactionUrl"
            :href="transactionUrl"
            target="_blank"
            class="mt-3 inline-flex items-center gap-1 underline underline-offset-2"
          >
            View on explorer
            <ArrowTopRightOnSquareIcon class="h-4 w-4" aria-hidden="true" />
          </a>
          <div class="mt-block-gap flex flex-col gap-3 sm:flex-row">
            <CommonButton variant="primary" as="RouterLink" :to="{ name: 'earn' }" class="w-full">
              Back to Earn
            </CommonButton>
            <CommonButton class="w-full" @click="resetForm()">Withdraw more</CommonButton>
          </div>
        </CommonContentBlock>
      </template>
    </form>
  </div>
</template>

<script lang="ts" setup>
import {
  ArrowTopRightOnSquareIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
} from "@heroicons/vue/24/outline";

import useEarnTransactions from "@/composables/zksys/useEarnTransactions";

import type { ZkSysEarnFeeEstimate } from "@/composables/zksys/useEarnTransactions";
import type { Token, TokenAmount } from "@/types";

const step = ref<"form" | "confirm" | "submitted">("form");
const amount = ref("");
const amountError = ref<string | undefined>();
const withdrawnAmountDisplay = ref("");

const earnStore = useZkSysEarnStore();
const onboardStore = useOnboardStore();
const { account, isConnected } = storeToRefs(onboardStore);
const { selectedNetwork } = storeToRefs(useNetworkStore());
const { isEarnAvailable, userPosition, userPositionInProgress, hasPendingStakeWeight } = storeToRefs(earnStore);
const { isCorrectNetworkSet } = storeToRefs(useZkSyncWalletStore());

const {
  status: txStatus,
  error: txError,
  transactionHash,
  commitWithdraw,
  estimateWithdrawFee,
  resetTransaction,
} = useEarnTransactions();

const stakeSymbol = computed(() => selectedNetwork.value.nativeCurrency?.symbol ?? "SYS");
const nativeToken = computed<Token>(() => ({
  address: L2_BASE_TOKEN_ADDRESS,
  l2Address: L2_BASE_TOKEN_ADDRESS,
  symbol: stakeSymbol.value,
  name: selectedNetwork.value.nativeCurrency?.name ?? "Syscoin",
  decimals: 18,
  iconUrl: "/img/syscoin-icon.svg",
  isETH: true,
}));

earnStore.requestStaticConfig().catch(() => undefined);
earnStore.requestNetworkStats().catch(() => undefined);
// The store clears userPosition on account change, so refetch whenever a
// wallet connects or the account switches while this page is open.
watch(
  () => account.value.address,
  (address) => {
    if (address) earnStore.requestUserPosition().catch(() => undefined);
  },
  { immediate: true }
);

const positionLoading = computed(() => userPositionInProgress.value && !userPosition.value);
const stakedAmount = computed(() => userPosition.value?.stake ?? 0n);
const stakedBalances = computed<TokenAmount[]>(() => [{ ...nativeToken.value, amount: stakedAmount.value.toString() }]);
const maxAmount = computed(() => stakedAmount.value.toString());

// Withdrawals are paid from the wallet's native balance, not the stake, so the
// full staked amount is always withdrawable. Gas depends on state updates, not
// the amount; estimate with the smallest valid withdrawal.
const fee = ref<ZkSysEarnFeeEstimate | undefined>();
const feeInProgress = ref(false);
const feeError = ref<Error | undefined>();
const estimateFee = async () => {
  if (!isConnected.value || !isCorrectNetworkSet.value || stakedAmount.value === 0n) return;
  feeInProgress.value = true;
  feeError.value = undefined;
  try {
    fee.value = await estimateWithdrawFee(1n);
  } catch (err) {
    feeError.value = formatError(err as Error);
  } finally {
    feeInProgress.value = false;
  }
};
watch(
  [isConnected, isCorrectNetworkSet, stakedAmount],
  () => {
    if (!fee.value) estimateFee();
  },
  { immediate: true }
);
const feeAmount = computed(() => fee.value?.feeAmount.toString());

const totalComputeAmount = computed(() => {
  try {
    if (!amount.value) return 0n;
    return decimalToBigNumber(amount.value, 18);
  } catch {
    return 0n;
  }
});
const continueDisabled = computed(() => {
  return (
    !!amountError.value ||
    totalComputeAmount.value === 0n ||
    totalComputeAmount.value > stakedAmount.value ||
    feeInProgress.value ||
    !!feeError.value
  );
});
const tokenWithAmount = computed<TokenAmount>(() => ({
  ...nativeToken.value,
  amount: totalComputeAmount.value.toString(),
}));

const txInProgress = computed(() => txStatus.value !== "not-started" && txStatus.value !== "done");
const transactionUrl = computed(() => {
  if (!transactionHash.value || !selectedNetwork.value.blockExplorerUrl) return undefined;
  return `${selectedNetwork.value.blockExplorerUrl}/tx/${transactionHash.value}`;
});

const makeTransaction = async () => {
  const receipt = await commitWithdraw(totalComputeAmount.value);
  if (receipt) {
    withdrawnAmountDisplay.value = parseTokenAmount(totalComputeAmount.value.toString(), 18);
    step.value = "submitted";
  }
};

const resetForm = () => {
  amount.value = "";
  withdrawnAmountDisplay.value = "";
  resetTransaction();
  step.value = "form";
  estimateFee();
};
</script>

<style lang="scss" scoped></style>
