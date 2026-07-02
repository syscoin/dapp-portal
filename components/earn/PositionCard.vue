<template>
  <CommonContentBlock class="earn-position-card">
    <div class="position-header">
      <div class="text-lg font-semibold">Your position</div>
      <CommonButtonLabel variant="light" :disabled="userPositionInProgress" @click="earnStore.refresh()">
        Refresh
      </CommonButtonLabel>
    </div>

    <CommonErrorBlock v-if="userPositionError" class="mt-block-gap" @try-again="earnStore.refresh()">
      Getting position error: {{ userPositionError.message }}
    </CommonErrorBlock>

    <template v-else>
      <div class="position-rows">
        <!-- Staked SYS -->
        <div class="position-row">
          <div class="row-info">
            <div class="row-label">Staked</div>
            <div class="row-value">
              <CommonContentLoader v-if="loading" :length="12" />
              <template v-else>{{ zkSysFormatTokenCompact(position?.stake ?? 0n) }} {{ stakeSymbol }}</template>
            </div>
          </div>
          <div class="row-actions">
            <CommonButton size="xs" variant="primary" as="RouterLink" :to="{ name: 'earn-stake' }">
              <template #icon><PlusIcon aria-hidden="true" /></template>
              Stake
            </CommonButton>
            <CommonButton
              size="xs"
              as="RouterLink"
              :to="{ name: 'earn-withdraw' }"
              :aria-disabled="!position || position.stake === 0n"
            >
              Withdraw
            </CommonButton>
          </div>
        </div>

        <!-- Active weight -->
        <div class="position-row">
          <div class="row-info">
            <div class="row-label">
              Active weight
              <span
                v-tooltip="
                  'Weight determines your share of each period\'s zkSYS emission. 1 staked SYS equals 1 weight; sentry nodes add weight from Syscoin L1.'
                "
                class="row-hint"
              >
                <InformationCircleIcon class="h-4 w-4" aria-hidden="true" />
              </span>
            </div>
            <div class="row-value">
              <CommonContentLoader v-if="loading" :length="12" />
              <template v-else>{{ zkSysFormatTokenCompact(position?.activeWeight ?? 0n) }}</template>
            </div>
            <div v-if="!loading" class="row-sub">
              {{ networkShare }} of network
              <template v-if="(position?.activeSentryNodeWeight ?? 0n) > 0n">
                · stake {{ zkSysFormatTokenCompact(position?.activeStakeWeight ?? 0n) }} + sentry
                {{ zkSysFormatTokenCompact(position?.activeSentryNodeWeight ?? 0n) }}
              </template>
            </div>
          </div>
        </div>

        <!-- Pending weight -->
        <div v-if="hasPendingWeight" class="position-row is-highlighted">
          <div class="row-info">
            <div class="row-label">Pending weight</div>
            <div class="row-value">+{{ zkSysFormatTokenCompact(pendingWeightDelta) }}</div>
            <div class="row-sub">
              <div v-for="line in pendingComponentLines" :key="line">{{ line }}</div>
            </div>
          </div>
          <div class="row-actions">
            <CommonButton
              size="xs"
              variant="primary"
              :disabled="!isPendingWeightActivatable || isBusy"
              @click="activate()"
            >
              <CommonSpinner v-if="isActionBusy('activate')" class="h-4 w-4" variant="text-color" />
              <template v-else>Activate</template>
            </CommonButton>
          </div>
        </div>

        <!-- Claimable rewards -->
        <div class="position-row">
          <div class="row-info">
            <div class="row-label">Claimable rewards</div>
            <div class="row-value">
              <CommonContentLoader v-if="loading" :length="12" />
              <template v-else>{{ zkSysFormatTokenCompact(position?.pendingRewards ?? 0n) }} ZKSYS</template>
            </div>
          </div>
          <div class="row-actions">
            <CommonButton
              size="xs"
              variant="primary"
              :disabled="!position || position.pendingRewards === 0n || isBusy"
              @click="claim()"
            >
              <CommonSpinner v-if="isActionBusy('claim')" class="h-4 w-4" variant="text-color" />
              <template v-else>Claim</template>
            </CommonButton>
          </div>
        </div>

        <!-- Awaiting distribution -->
        <div v-if="showDistributeRow" class="position-row">
          <div class="row-info">
            <div class="row-label">
              Awaiting distribution
              <span
                v-tooltip="
                  'Rewards for closed periods are only credited once anyone triggers the daily distribution on the issuer contract. Sync runs it for the whole network.'
                "
                class="row-hint"
              >
                <InformationCircleIcon class="h-4 w-4" aria-hidden="true" />
              </span>
            </div>
            <div class="row-value">{{ zkSysFormatTokenCompact(undistributedRewards) }} ZKSYS</div>
            <div class="row-sub">Network-wide rewards not yet credited to claimable balances</div>
          </div>
          <div class="row-actions">
            <CommonButton size="xs" :disabled="isBusy" @click="distribute()">
              <CommonSpinner v-if="isActionBusy('distribute')" class="h-4 w-4" variant="text-color" />
              <template v-else>Sync</template>
            </CommonButton>
          </div>
        </div>

        <!-- zkSYS balance -->
        <div class="position-row">
          <div class="row-info">
            <div class="row-label">zkSYS in wallet</div>
            <div class="row-value">
              <CommonContentLoader v-if="loading" :length="12" />
              <template v-else>{{ zkSysFormatTokenCompact(position?.tokenBalance ?? 0n) }} ZKSYS</template>
            </div>
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
  CheckCircleIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
  PlusIcon,
} from "@heroicons/vue/24/outline";

import useEarnTransactions from "@/composables/zksys/useEarnTransactions";
import {
  zkSysEffectivePeriodStartTime,
  zkSysFormatDuration,
  zkSysFormatShare,
  zkSysFormatTokenCompact,
} from "@/utils/zksysEarn";

import type { Address } from "viem";

const earnStore = useZkSysEarnStore();
const onboardStore = useOnboardStore();
const eraWalletStore = useZkSyncWalletStore();
const { isCorrectNetworkSet } = storeToRefs(eraWalletStore);
const { selectedNetwork } = storeToRefs(useNetworkStore());
const {
  userPosition: position,
  userPositionInProgress,
  userPositionError,
  networkStats,
  staticConfig,
  hasPendingWeight,
  hasPendingStakeWeight,
  hasPendingSentryWeight,
  isPendingStakeActivatable,
  isPendingSentryActivatable,
  isPendingWeightActivatable,
  pendingStakeWeightDelta,
  pendingSentryWeightDelta,
  pendingWeightDelta,
  undistributedRewards,
} = storeToRefs(earnStore);

const {
  status: txStatus,
  action: txAction,
  error: actionError,
  transactionHash,
  commitActivate,
  commitClaim,
  commitDistribute,
} = useEarnTransactions();

const stakeSymbol = computed(() => selectedNetwork.value.nativeCurrency?.symbol ?? "SYS");
const loading = computed(() => userPositionInProgress.value && !position.value);
const isBusy = computed(() => txStatus.value !== "not-started" && txStatus.value !== "done");
const isActionBusy = (name: string) => isBusy.value && txAction.value === name;

const networkShare = computed(() =>
  zkSysFormatShare(position.value?.activeWeight ?? 0n, networkStats.value?.totalWeight ?? 0n)
);

const now = ref(Date.now());
useInterval(() => {
  now.value = Date.now();
}, 30_000);

// Per-component pending status: stake and sentry weight queue independently
// and can have different effective periods; activate applies whichever is due.
const pendingComponentLine = (label: string, delta: bigint, effectivePeriod: bigint, activatable: boolean) => {
  const amount = `${label} +${zkSysFormatTokenCompact(delta)}`;
  if (activatable) return `${amount} — ready to activate`;
  let countdown = "";
  if (staticConfig.value) {
    const readyAt = zkSysEffectivePeriodStartTime(
      effectivePeriod,
      staticConfig.value.startTime,
      staticConfig.value.periodSeconds
    );
    const secondsLeft = Number(readyAt) - Math.floor(now.value / 1000);
    if (secondsLeft > 0) countdown = ` (~${zkSysFormatDuration(secondsLeft)})`;
  }
  return `${amount} — activates in period ${effectivePeriod}${countdown}`;
};
const pendingComponentLines = computed(() => {
  if (!position.value) return [];
  const lines: string[] = [];
  if (hasPendingStakeWeight.value) {
    lines.push(
      pendingComponentLine(
        "Stake",
        pendingStakeWeightDelta.value,
        position.value.pendingStakeEffectivePeriod,
        isPendingStakeActivatable.value
      )
    );
  }
  if (hasPendingSentryWeight.value) {
    lines.push(
      pendingComponentLine(
        "Sentry",
        pendingSentryWeightDelta.value,
        position.value.pendingSentryNodeEffectivePeriod,
        isPendingSentryActivatable.value
      )
    );
  }
  return lines;
});

const showDistributeRow = computed(() => {
  return undistributedRewards.value > 0n && (networkStats.value?.totalWeight ?? 0n) > 0n;
});

const successMessage = ref("");
const networkSwitchError = ref<Error | undefined>();
const displayedError = computed(() => actionError.value ?? networkSwitchError.value);
const lastTransactionUrl = computed(() => {
  if (!transactionHash.value || !selectedNetwork.value.blockExplorerUrl) return undefined;
  return `${selectedNetwork.value.blockExplorerUrl}/tx/${transactionHash.value}`;
});

const runAction = async (fn: () => Promise<unknown>, message: string) => {
  successMessage.value = "";
  // SYSCOIN: dashboard actions send L2 transactions directly, so mirror the
  // TransactionFooter network guard and switch the wallet to the zkSYS L2
  // before signing (stake/withdraw flows get this from TransactionFooter).
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
  }
};

const activate = () => runAction(() => commitActivate(), "Pending weight activated — it now earns every period.");
const claim = () =>
  runAction(async () => {
    const receiver = onboardStore.account.address as Address | undefined;
    if (!receiver) throw new Error("Wallet account is not available");
    return await commitClaim(receiver);
  }, "Rewards claimed — zkSYS has been minted to your wallet.");
const distribute = () =>
  runAction(() => commitDistribute(), "Distribution synced — claimable balances now include closed periods.");
</script>

<style lang="scss" scoped>
.earn-position-card {
  .position-header {
    @apply flex items-center justify-between;
  }
  .position-rows {
    @apply mt-block-padding-1/2 flex flex-col divide-y divide-neutral-200 dark:divide-neutral-800;
  }
  .position-row {
    @apply flex flex-wrap items-center justify-between gap-3 py-3.5 first:pt-0 last:pb-0;

    &.is-highlighted {
      @apply -mx-3 my-1 rounded-2xl border-none bg-primary-400/5 px-3 dark:bg-primary-300/5;
    }

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
}
</style>
