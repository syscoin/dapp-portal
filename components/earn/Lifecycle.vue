<template>
  <CommonContentBlock class="earn-lifecycle">
    <ol class="lifecycle-steps">
      <li v-for="(step, index) in steps" :key="step.key" class="lifecycle-step" :class="`status-${step.status}`">
        <div class="step-indicator">
          <span class="step-circle">
            <CheckIcon v-if="step.status === 'done'" class="h-4 w-4" aria-hidden="true" />
            <span v-else>{{ index + 1 }}</span>
          </span>
          <span v-if="index < steps.length - 1" class="step-connector" aria-hidden="true" />
        </div>
        <div class="step-body">
          <div class="step-label">{{ step.label }}</div>
          <div class="step-description">{{ step.description }}</div>
        </div>
      </li>
    </ol>
  </CommonContentBlock>
</template>

<script lang="ts" setup>
import { CheckIcon } from "@heroicons/vue/24/outline";

import { zkSysEffectivePeriodStartTime, zkSysFormatDuration } from "@/utils/zksysEarn";

type StepStatus = "done" | "active" | "upcoming";

const earnStore = useZkSysEarnStore();
const { userPosition, staticConfig, hasPendingWeight, isPendingWeightActivatable, hasPendingStakeWeight } =
  storeToRefs(earnStore);
const { selectedNetwork } = storeToRefs(useNetworkStore());
const stakeSymbol = computed(() => selectedNetwork.value.nativeCurrency?.symbol ?? "SYS");

const now = ref(Date.now());
useInterval(() => {
  now.value = Date.now();
}, 30_000);

const warmupCountdown = computed(() => {
  if (!hasPendingStakeWeight.value || !userPosition.value || !staticConfig.value) return "";
  const readyAt = zkSysEffectivePeriodStartTime(
    userPosition.value.pendingStakeEffectivePeriod,
    staticConfig.value.startTime,
    staticConfig.value.periodSeconds
  );
  const secondsLeft = Number(readyAt) - Math.floor(now.value / 1000);
  if (secondsLeft <= 0) return "";
  return `~${zkSysFormatDuration(secondsLeft)} left`;
});

const steps = computed(() => {
  const position = userPosition.value;
  const stake = position?.stake ?? 0n;
  const activeWeight = position?.activeWeight ?? 0n;
  const rewards = position?.pendingRewards ?? 0n;
  const delayPeriods = staticConfig.value?.activationDelayPeriods ?? 3n;

  const stakeDone = stake > 0n || activeWeight > 0n || hasPendingWeight.value;
  const warmupActive = hasPendingWeight.value && !isPendingWeightActivatable.value;
  const warmupDone = activeWeight > 0n && !hasPendingWeight.value;
  const activateActive = isPendingWeightActivatable.value;
  const earningActive = activeWeight > 0n;

  const status = (done: boolean, active: boolean): StepStatus => (done ? "done" : active ? "active" : "upcoming");

  return [
    {
      key: "stake",
      label: "Stake",
      description: `Deposit ${stakeSymbol.value} into the staking vault`,
      status: status(stakeDone, !stakeDone),
    },
    {
      key: "warmup",
      label: "Warm-up",
      description: warmupActive
        ? `Weight queued${warmupCountdown.value ? ` — ${warmupCountdown.value}` : ""}`
        : `New weight queues for ${delayPeriods} periods`,
      status: status(warmupDone || activateActive, warmupActive),
    },
    {
      key: "activate",
      label: "Activate",
      description: activateActive ? "Your pending weight is ready to activate" : "One click once the warm-up ends",
      status: status(earningActive && !hasPendingWeight.value, activateActive),
    },
    {
      key: "earn",
      label: "Earn",
      description: "Your weight shares each day's zkSYS emission",
      status: status(false, earningActive),
    },
    {
      key: "claim",
      label: "Claim",
      description: rewards > 0n ? "Rewards are ready to claim" : "Mint earned zkSYS to your wallet",
      status: status(false, rewards > 0n),
    },
  ];
});
</script>

<style lang="scss" scoped>
.earn-lifecycle {
  @apply py-block-padding-1/2;

  .lifecycle-steps {
    @apply flex flex-col gap-4 sm:flex-row sm:gap-0;
  }
  .lifecycle-step {
    @apply flex gap-3 sm:flex-1 sm:flex-col sm:gap-2;

    .step-indicator {
      @apply flex flex-col items-center sm:w-full sm:flex-row;

      .step-circle {
        @apply flex h-7 w-7 flex-none items-center justify-center rounded-full border text-sm font-medium;
        @apply border-neutral-300 text-neutral-500 dark:border-neutral-700 dark:text-neutral-500;
      }
      .step-connector {
        @apply mt-1 h-full w-px flex-1 bg-neutral-200 dark:bg-neutral-800;
        @apply sm:ml-2 sm:mr-2 sm:mt-0 sm:h-px sm:w-auto;
      }
    }
    .step-body {
      @apply pb-2 sm:pb-0 sm:pr-3;

      .step-label {
        @apply text-sm font-semibold;
      }
      .step-description {
        @apply mt-0.5 text-xs leading-snug text-neutral-600 dark:text-neutral-500;
      }
    }

    &.status-done .step-circle {
      @apply border-success-600 bg-success-600/10 text-success-600;
    }
    &.status-active .step-circle {
      @apply border-primary-400 bg-primary-400 text-white;
    }
    &.status-active .step-label {
      @apply text-primary-400 dark:text-primary-300;
    }
    &.status-upcoming .step-body {
      @apply opacity-70;
    }
  }
}
</style>
