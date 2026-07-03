<template>
  <CommonContentBlock class="earn-gas-tank-card">
    <div class="tank-header">
      <div>
        <div class="flex items-center gap-2 text-lg font-semibold">
          <BoltIcon class="h-5 w-5 text-primary-400" aria-hidden="true" />
          Gas tank
        </div>
        <p class="tank-description">
          Prepay gas with zkSYS. While your credit covers a transaction's full fee, gas is debited from the tank 1:1
          instead of native {{ stakeSymbol }} — withdraw unused credit anytime.
        </p>
      </div>
      <CommonButtonLabel variant="light" :disabled="gasTankPositionInProgress" @click="refreshTank()">
        Refresh
      </CommonButtonLabel>
    </div>

    <CommonErrorBlock v-if="gasTankPositionError" class="mt-block-gap" @try-again="refreshTank()">
      Getting gas tank error: {{ gasTankPositionError.message }}
    </CommonErrorBlock>

    <template v-else>
      <div class="tank-rows">
        <!-- Prepaid credit -->
        <div class="tank-row">
          <div class="row-info">
            <div class="row-label">Prepaid gas credit</div>
            <div class="row-value">
              <CommonContentLoader v-if="loading" :length="12" />
              <template v-else>{{ zkSysFormatTokenCompact(credit) }} ZKSYS</template>
            </div>
            <div v-if="!loading" class="row-sub">
              Wallet balance: {{ zkSysFormatTokenCompact(walletBalance) }} ZKSYS
            </div>
          </div>
          <div class="row-actions">
            <CommonButton
              size="xs"
              variant="primary"
              :disabled="isBusy || walletBalance === 0n"
              @click="toggleMode('fund')"
            >
              <template #icon><PlusIcon aria-hidden="true" /></template>
              Fund
            </CommonButton>
            <CommonButton size="xs" :disabled="isBusy || credit === 0n" @click="toggleMode('withdraw')">
              Withdraw
            </CommonButton>
          </div>
        </div>

        <!-- Inline fund / withdraw form -->
        <CommonHeightTransition :opened="!!mode">
          <div class="tank-form">
            <div class="form-title">
              {{ mode === "fund" ? "Add prepaid gas credit" : "Withdraw credit back to zkSYS" }}
            </div>
            <div class="form-controls">
              <CommonSmallInput v-model="amount" placeholder="0.0" type="text" class="form-input">
                <template #right>
                  <button type="button" class="form-max" :disabled="maxEstimateInProgress" @click="setMaxAmount()">
                    {{ maxEstimateInProgress ? "…" : "Max" }}
                  </button>
                </template>
              </CommonSmallInput>
              <CommonButton size="sm" variant="primary" :disabled="confirmDisabled" @click="confirmAction()">
                <CommonSpinner v-if="isBusy" class="h-4 w-4" variant="text-color" />
                <template v-else>{{ mode === "fund" ? "Fund" : "Withdraw" }}</template>
              </CommonButton>
              <CommonButton size="sm" :disabled="isBusy" @click="closeForm()">Cancel</CommonButton>
            </div>
            <div class="form-sub">
              <template v-if="amountError">{{ amountError }}</template>
              <template v-else-if="busyLabel">{{ busyLabel }}</template>
              <template v-else-if="mode === 'fund' && needsApproval">
                Requires a one-time zkSYS approval — expect two wallet confirmations.
              </template>
              <template v-else-if="mode === 'fund'">
                Available: {{ zkSysFormatTokenCompact(walletBalance) }} ZKSYS
              </template>
              <template v-else-if="maxEstimateInProgress">Estimating the withdrawal fee…</template>
              <template v-else>
                Withdrawable now: {{ zkSysFormatTokenCompact(maxAmount) }} ZKSYS
                <template v-if="maxAmount < credit">
                  — a small reserve is kept for this transaction's fee, which is paid from your credit.
                </template>
              </template>
            </div>
          </div>
        </CommonHeightTransition>

        <!-- Network totals / surplus burn -->
        <div class="tank-row">
          <div class="row-info">
            <div class="row-label">
              Tank total prepaid
              <span
                v-tooltip="
                  'zkSYS prepaid by all accounts. Base fees paid from the tank accumulate as surplus that anyone can burn, permanently reducing supply.'
                "
                class="row-hint"
              >
                <InformationCircleIcon class="h-4 w-4" aria-hidden="true" />
              </span>
            </div>
            <div class="row-value">
              <CommonContentLoader v-if="statsLoading" :length="12" />
              <template v-else>{{ zkSysFormatTokenCompact(stats?.totalCredits ?? 0n) }} ZKSYS</template>
            </div>
            <div v-if="!statsLoading && surplus > 0n" class="row-sub">
              {{ zkSysFormatTokenCompact(surplus) }} ZKSYS of spent fees awaiting burn
            </div>
          </div>
          <div v-if="surplus > 0n" class="row-actions">
            <CommonButton size="xs" :disabled="isBusy" @click="burn()">
              <CommonSpinner v-if="isActionBusy('burnSurplus')" class="h-4 w-4" variant="text-color" />
              <template v-else>Burn</template>
            </CommonButton>
          </div>
        </div>
      </div>

      <CommonHeightTransition :opened="!!displayedError">
        <CommonAlert variant="error" size="sm" :icon="ExclamationTriangleIcon" class="mt-block-gap">
          <p>{{ displayedError?.message }}</p>
        </CommonAlert>
      </CommonHeightTransition>
      <CommonHeightTransition :opened="!!successMessage">
        <CommonAlert variant="success" size="sm" :icon="CheckCircleIcon" class="mt-block-gap">
          <p>{{ successMessage }}</p>
          <a v-if="lastTransactionUrl" :href="lastTransactionUrl" target="_blank" class="alert-link">
            View on explorer
            <ArrowTopRightOnSquareIcon class="ml-1 h-4 w-4" aria-hidden="true" />
          </a>
        </CommonAlert>
      </CommonHeightTransition>
    </template>
  </CommonContentBlock>
</template>

<script lang="ts" setup>
import {
  ArrowTopRightOnSquareIcon,
  BoltIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
  PlusIcon,
} from "@heroicons/vue/24/outline";
import { formatUnits } from "viem";

import useEarnTransactions from "@/composables/zksys/useEarnTransactions";
import { zkSysFormatTokenCompact } from "@/utils/zksysEarn";

const earnStore = useZkSysEarnStore();
const eraWalletStore = useZkSyncWalletStore();
const { isCorrectNetworkSet } = storeToRefs(eraWalletStore);
const { selectedNetwork } = storeToRefs(useNetworkStore());
const {
  userPosition,
  gasTankPosition,
  gasTankPositionInProgress,
  gasTankPositionError,
  gasTankStats: stats,
  gasTankStatsInProgress,
} = storeToRefs(earnStore);

const {
  status: txStatus,
  action: txAction,
  error: actionError,
  transactionHash,
  commitFundGasTank,
  commitWithdrawGasTank,
  commitBurnSurplus,
  estimateWithdrawGasTankFee,
} = useEarnTransactions();

const stakeSymbol = computed(() => selectedNetwork.value.nativeCurrency?.symbol ?? "SYS");
const loading = computed(() => gasTankPositionInProgress.value && !gasTankPosition.value);
const statsLoading = computed(() => gasTankStatsInProgress.value && !stats.value);
const isBusy = computed(() => txStatus.value !== "not-started" && txStatus.value !== "done");
const isActionBusy = (name: string) => isBusy.value && txAction.value === name;

const credit = computed(() => gasTankPosition.value?.credit ?? 0n);
const walletBalance = computed(() => userPosition.value?.tokenBalance ?? 0n);
const surplus = computed(() => stats.value?.surplus ?? 0n);

const mode = ref<"fund" | "withdraw" | undefined>();
const amount = ref("");
const toggleMode = (next: "fund" | "withdraw") => {
  mode.value = mode.value === next ? undefined : next;
  amount.value = "";
};
const closeForm = () => {
  mode.value = undefined;
  amount.value = "";
};

const amountWei = computed(() => {
  try {
    if (!amount.value) return 0n;
    // Plain-text input: treat negative or unparsable values as invalid (0n)
    // so they hit the "Enter a valid amount" path instead of failing later
    // at uint256 encoding.
    const parsed = decimalToBigNumber(amount.value, 18);
    return parsed > 0n ? parsed : 0n;
  } catch {
    return 0n;
  }
});
// SYSCOIN: when the credit covers a transaction's full fee prepayment
// (gasLimit * maxFeePerGas), the bootloader debits that prepayment from the
// same credit before `withdraw()` executes, so `withdraw(credit)` reverts.
// Estimate the withdraw fee once per form open (1 wei probe — gas cost is
// amount-independent) and reserve it from the withdrawable max, used by both
// the Max button and the amount validation. The unspent part of the
// prepayment is refunded back to the credit after execution and stays
// withdrawable.
const withdrawPrepayment = ref<bigint | undefined>();
const maxEstimateInProgress = ref(false);
let prepaymentPromise: Promise<void> | undefined;
const refreshWithdrawPrepayment = () => {
  if (!prepaymentPromise) {
    maxEstimateInProgress.value = true;
    prepaymentPromise = estimateWithdrawGasTankFee(1n)
      .then((fee) => {
        withdrawPrepayment.value = fee.feeAmount;
      })
      .catch(() => {
        // Estimate unavailable — withdrawMax falls back to the full credit.
        withdrawPrepayment.value = undefined;
      })
      .finally(() => {
        maxEstimateInProgress.value = false;
        prepaymentPromise = undefined;
      });
  }
  return prepaymentPromise;
};
watch(mode, (next) => {
  if (next === "withdraw" && credit.value > 0n) refreshWithdrawPrepayment();
});

const withdrawMax = computed(() => {
  const prepayment = withdrawPrepayment.value;
  if (prepayment === undefined) return credit.value;
  if (credit.value > prepayment * 2n) {
    // Double buffer against fee drift between the estimate and signing.
    return credit.value - prepayment * 2n;
  }
  if (credit.value >= prepayment) {
    // The bootloader debits the tank whenever credit covers (>=) the
    // prepayment, so equality still needs the reserve.
    return credit.value - prepayment;
  }
  // Credit cannot cover the prepayment, so the fee is paid in native SYS and
  // the full credit is withdrawable.
  return credit.value;
});
const maxAmount = computed(() => (mode.value === "fund" ? walletBalance.value : withdrawMax.value));
const setMaxAmount = async () => {
  if (mode.value === "withdraw" && withdrawPrepayment.value === undefined) {
    await refreshWithdrawPrepayment();
  }
  amount.value = formatUnits(maxAmount.value, 18);
};
const amountError = computed(() => {
  if (!amount.value) return "";
  if (amountWei.value === 0n) return "Enter a valid amount";
  if (amountWei.value > maxAmount.value) {
    if (mode.value === "fund") return "Amount exceeds your zkSYS balance";
    return amountWei.value <= credit.value
      ? "Leave a reserve for this transaction's fee — use Max for the highest safe amount"
      : "Amount exceeds your prepaid credit";
  }
  return "";
});
const confirmDisabled = computed(
  () =>
    isBusy.value ||
    amountWei.value === 0n ||
    amountWei.value > maxAmount.value ||
    !!amountError.value ||
    // Don't allow confirming a withdraw against an unreserved max while the
    // fee estimate is still loading.
    (mode.value === "withdraw" && maxEstimateInProgress.value)
);

const needsApproval = computed(
  () => amountWei.value > 0n && (gasTankPosition.value?.allowance ?? 0n) < amountWei.value
);
const busyLabel = computed(() => {
  if (!isBusy.value) return "";
  if (txAction.value === "approveGasTank") return "Approving zkSYS in your wallet…";
  if (txAction.value === "fundGasTank") return "Funding the gas tank…";
  if (txAction.value === "withdrawGasTank") return "Withdrawing credit…";
  return "";
});

const successMessage = ref("");
const networkSwitchError = ref<Error | undefined>();
const displayedError = computed(() => actionError.value ?? networkSwitchError.value);
const lastTransactionUrl = computed(() => {
  if (!transactionHash.value || !selectedNetwork.value.blockExplorerUrl) return undefined;
  return `${selectedNetwork.value.blockExplorerUrl}/tx/${transactionHash.value}`;
});

// SYSCOIN: same network guard as the position card — these actions send L2
// transactions directly, so switch the wallet to the zkSYS L2 before signing.
const runAction = async (fn: () => Promise<unknown>, message: string) => {
  successMessage.value = "";
  if (!isCorrectNetworkSet.value) {
    await eraWalletStore.setCorrectNetwork();
    if (!isCorrectNetworkSet.value) {
      networkSwitchError.value = new Error(
        `Switch your wallet to ${selectedNetwork.value.name} to continue. ` +
          "If your wallet does not support automatic switching, change the network manually and try again."
      );
      return;
    }
  }
  networkSwitchError.value = undefined;
  const receipt = await fn();
  if (receipt) {
    successMessage.value = message;
    closeForm();
  }
};

const confirmAction = () => {
  if (mode.value === "fund") {
    return runAction(
      () => commitFundGasTank(amountWei.value),
      "Gas tank funded — fees are now paid from your prepaid zkSYS while credit lasts."
    );
  }
  return runAction(
    () => commitWithdrawGasTank(amountWei.value),
    "Credit withdrawn — the zkSYS is back in your wallet."
  );
};
const burn = () =>
  runAction(() => commitBurnSurplus(), "Surplus burned — spent fees are permanently removed from supply.");

const refreshTank = () => {
  earnStore.requestGasTankStats({ force: true }).catch(() => undefined);
  earnStore.requestGasTankPosition({ force: true }).catch(() => undefined);
};
</script>

<style lang="scss" scoped>
.earn-gas-tank-card {
  .tank-header {
    @apply flex items-start justify-between gap-3;

    .tank-description {
      @apply mt-1 max-w-xl text-sm text-neutral-700 dark:text-neutral-400;
    }
  }
  .tank-rows {
    @apply mt-block-padding-1/2 flex flex-col divide-y divide-neutral-200 dark:divide-neutral-800;
  }
  .tank-row {
    @apply flex flex-wrap items-center justify-between gap-3 py-3.5 first:pt-0 last:pb-0;

    .row-info {
      @apply min-w-0;

      .row-label {
        @apply flex items-center gap-1 text-sm text-neutral-600 dark:text-neutral-500;

        .row-hint {
          @apply cursor-help text-neutral-400 dark:text-neutral-600;
        }
      }
      .row-value {
        @apply text-lg font-medium leading-tight;
      }
      .row-sub {
        @apply mt-0.5 text-xs text-neutral-600 dark:text-neutral-500;
      }
    }
    .row-actions {
      @apply flex items-center gap-2;
    }
  }
  .tank-form {
    @apply -mx-3 my-1 rounded-2xl bg-primary-400/5 p-3 dark:bg-primary-300/5;

    .form-title {
      @apply text-sm font-medium;
    }
    .form-controls {
      @apply mt-2 flex flex-wrap items-center gap-2;

      .form-input {
        @apply h-10 max-w-[14rem] flex-1;
      }
      .form-max {
        @apply rounded-full border border-primary-400/30 bg-primary-400/10 px-3 py-1 text-xs font-semibold text-primary-400 transition-colors;
        @apply hover:border-primary-400/60 hover:bg-primary-400 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-400;
        @apply disabled:cursor-not-allowed disabled:border-transparent disabled:bg-neutral-300 disabled:text-neutral-600 dark:disabled:bg-neutral-800 dark:disabled:text-neutral-500;
      }
    }
    .form-sub {
      @apply mt-1.5 text-xs text-neutral-600 dark:text-neutral-400;
    }
  }
}
</style>
