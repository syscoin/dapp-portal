<template>
  <div>
    <PageTitle v-if="step === 'form'" :fallback-route="{ name: 'earn' }">Stake {{ stakeSymbol }}</PageTitle>
    <PageTitle v-else-if="step === 'confirm'" :back-function="() => (step = 'form')">Confirm stake</PageTitle>

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
          :balances="balances"
          :max-amount="maxAmount"
          :loading="balanceInProgress || feeInProgress"
          class="mb-block-padding-1/2 sm:mb-block-gap"
        />

        <CommonAlert variant="info" size="sm" :icon="ClockIcon" class="mb-block-padding-1/2 sm:mb-block-gap">
          <p>
            New stake goes through a {{ warmupPeriodsDisplay }}-period warm-up before it earns. It becomes active in
            period {{ effectivePeriodDisplay }}<template v-if="warmupEta"> (~{{ warmupEta }})</template>, then needs a
            one-click activation on the Earn page.
          </p>
        </CommonAlert>

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
          <TransactionSummaryTokenEntry label="You stake" :token="tokenWithAmount" />
        </CommonCardWithLineButtons>

        <CommonAlert variant="neutral" size="sm" :icon="InformationCircleIcon" class="mt-block-gap">
          <p>
            Staked {{ stakeSymbol }} stays withdrawable at any time. Your reward weight activates in period
            {{ effectivePeriodDisplay }}<template v-if="warmupEta"> (~{{ warmupEta }})</template>.
          </p>
        </CommonAlert>

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
                  <span v-else-if="txStatus === 'committing'">Staking...</span>
                  <span v-else>Stake {{ stakeSymbol }}</span>
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
          <div class="mt-3 text-xl font-semibold">{{ stakedAmountDisplay }} {{ stakeSymbol }} staked</div>
          <p class="mt-2 text-neutral-700 dark:text-neutral-400">
            Your reward weight is queued and becomes active in period {{ effectivePeriodDisplay
            }}<template v-if="warmupEta"> (~{{ warmupEta }})</template>. Come back to the Earn page to activate it — it
            will then earn every period until you withdraw.
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
            <CommonButton class="w-full" @click="resetForm()">Stake more</CommonButton>
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
  ClockIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
} from "@heroicons/vue/24/outline";

import useEarnTransactions from "@/composables/zksys/useEarnTransactions";
import { zkSysEffectivePeriodStartTime, zkSysFormatDuration } from "@/utils/zksysEarn";

import type { ZkSysEarnFeeEstimate } from "@/composables/zksys/useEarnTransactions";
import type { Token, TokenAmount } from "@/types";

const step = ref<"form" | "confirm" | "submitted">("form");
const amount = ref("");
const amountError = ref<string | undefined>();
const stakedAmountDisplay = ref("");

const earnStore = useZkSysEarnStore();
const onboardStore = useOnboardStore();
const { account, isConnected } = storeToRefs(onboardStore);
const { selectedNetwork } = storeToRefs(useNetworkStore());
const { isEarnAvailable, networkStats, staticConfig } = storeToRefs(earnStore);
const { isCorrectNetworkSet } = storeToRefs(useZkSyncWalletStore());

const {
  status: txStatus,
  error: txError,
  transactionHash,
  commitStake,
  estimateStakeFee,
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

// SYSCOIN: read the native balance straight from the zkSYS RPC so the form
// works regardless of which chain the wallet is currently connected to.
const {
  result: balanceResult,
  inProgress: balanceInProgress,
  execute: requestBalance,
  reset: resetBalance,
} = usePromise<bigint>(
  async () => {
    if (!account.value.address) return 0n;
    const client = earnStore.getEarnPublicClient();
    return await client.getBalance({ address: account.value.address });
  },
  { cache: 30_000 }
);
watch(
  () => account.value.address,
  () => {
    resetBalance();
    if (account.value.address) requestBalance().catch(() => undefined);
  },
  { immediate: true }
);

const balances = computed<TokenAmount[]>(() => [
  { ...nativeToken.value, amount: (balanceResult.value ?? 0n).toString() },
]);

// Fee estimation: deposit() gas does not depend on the value, so estimate with
// a dust value to avoid balance-coverage failures when staking near max.
const fee = ref<ZkSysEarnFeeEstimate | undefined>();
const feeInProgress = ref(false);
const feeError = ref<Error | undefined>();
const estimateFee = async () => {
  if (!isConnected.value || !isCorrectNetworkSet.value || (balanceResult.value ?? 0n) === 0n) return;
  feeInProgress.value = true;
  feeError.value = undefined;
  try {
    fee.value = await estimateStakeFee(1n);
  } catch (err) {
    feeError.value = formatError(err as Error);
  } finally {
    feeInProgress.value = false;
  }
};
watch(
  [isConnected, isCorrectNetworkSet, balanceResult],
  () => {
    if (!fee.value) estimateFee();
  },
  { immediate: true }
);

const feeAmount = computed(() => fee.value?.feeAmount.toString());
const maxAmount = computed(() => {
  const balance = balanceResult.value ?? 0n;
  if (balance === 0n) return "0";
  // Keep a 2x fee buffer so the stake transaction always remains payable.
  const reserved = (fee.value?.feeAmount ?? 0n) * 2n;
  const max = balance - reserved;
  return (max > 0n ? max : 0n).toString();
});

const totalComputeAmount = computed(() => {
  try {
    if (!amount.value) return 0n;
    return decimalToBigNumber(amount.value, 18);
  } catch {
    return 0n;
  }
});
const continueDisabled = computed(() => {
  return !!amountError.value || totalComputeAmount.value === 0n || feeInProgress.value || !!feeError.value;
});
const tokenWithAmount = computed<TokenAmount>(() => ({
  ...nativeToken.value,
  amount: totalComputeAmount.value.toString(),
}));

// Warm-up messaging (effectivePeriod = currentPeriod + activationDelayPeriods).
const effectivePeriod = computed(() => {
  if (!networkStats.value || !staticConfig.value) return undefined;
  return networkStats.value.currentPeriod + staticConfig.value.activationDelayPeriods;
});
const warmupPeriodsDisplay = computed(() => (staticConfig.value?.activationDelayPeriods ?? 3n).toString());
const effectivePeriodDisplay = computed(() => effectivePeriod.value?.toString() ?? "—");
const warmupEta = computed(() => {
  if (effectivePeriod.value === undefined || !staticConfig.value) return "";
  const readyAt = zkSysEffectivePeriodStartTime(
    effectivePeriod.value,
    staticConfig.value.startTime,
    staticConfig.value.periodSeconds
  );
  const secondsLeft = Number(readyAt) - Math.floor(Date.now() / 1000);
  return secondsLeft > 0 ? zkSysFormatDuration(secondsLeft) : "";
});

const txInProgress = computed(() => txStatus.value !== "not-started" && txStatus.value !== "done");
const transactionUrl = computed(() => {
  if (!transactionHash.value || !selectedNetwork.value.blockExplorerUrl) return undefined;
  return `${selectedNetwork.value.blockExplorerUrl}/tx/${transactionHash.value}`;
});

const makeTransaction = async () => {
  const receipt = await commitStake(totalComputeAmount.value);
  if (receipt) {
    stakedAmountDisplay.value = parseTokenAmount(totalComputeAmount.value.toString(), 18);
    step.value = "submitted";
    requestBalance({ force: true }).catch(() => undefined);
  }
};

const resetForm = () => {
  amount.value = "";
  stakedAmountDisplay.value = "";
  resetTransaction();
  step.value = "form";
  estimateFee();
};
</script>

<style lang="scss" scoped></style>
