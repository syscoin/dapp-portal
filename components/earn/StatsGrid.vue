<template>
  <div class="earn-stats-grid">
    <EarnStatCard label="Current period" :loading="loading" :value="`#${currentPeriodDisplay}`" :sub="periodCloseSub" />
    <EarnStatCard
      label="Emission this period"
      :loading="loading"
      :value="`${emissionDisplay} ZKSYS`"
      :sub="emissionSub"
    />
    <EarnStatCard label="zkSYS supply" :loading="loading" :value="supplyDisplay">
      <template #sub>
        <div class="supply-progress">
          <div class="supply-progress-bar" :style="{ width: supplyBarWidth }" />
        </div>
        <span>{{ supplyPercent }} of {{ maxSupplyDisplay }} cap minted{{ burnedSuffix }}</span>
      </template>
    </EarnStatCard>
    <EarnStatCard
      label="Total staked"
      :loading="loading"
      :value="`${totalStakedDisplay} ${stakeSymbol}`"
      sub="Native SYS in the staking vault"
    />
    <EarnStatCard label="Total reward weight" :loading="loading" :value="totalWeightDisplay" :sub="yourShareSub" />
    <EarnStatCard label="Sentry nodes" :loading="loading" :value="sentryNodesDisplay">
      <template #sub>
        <span>Active weight from Syscoin L1</span>
        <div
          v-tooltip="
            'Sentry-node seniority bonuses are deployed but currently set to zero. Longer-standing nodes will earn boosted weight once enabled.'
          "
          class="seniority-row"
        >
          <ClockIcon class="h-3.5 w-3.5" aria-hidden="true" />
          <span>Seniority boost</span>
          <CommonBadge class="seniority-badge">Coming soon</CommonBadge>
        </div>
      </template>
    </EarnStatCard>
  </div>
</template>

<script lang="ts" setup>
import { ClockIcon } from "@heroicons/vue/24/outline";

import useEarnCharts from "@/composables/zksys/useEarnCharts";
import { zkSysFormatDuration, zkSysFormatShare, zkSysFormatTokenCompact, zkSysPeriodEmission } from "@/utils/zksysEarn";

const earnStore = useZkSysEarnStore();
const { selectedNetwork } = storeToRefs(useNetworkStore());
const { networkStats, staticConfig, networkStatsInProgress, userPosition, currentPeriodCloseTime } =
  storeToRefs(earnStore);

const loading = computed(() => (!networkStats.value || !staticConfig.value) && networkStatsInProgress.value);
const stakeSymbol = computed(() => selectedNetwork.value.nativeCurrency?.symbol ?? "SYS");

const now = ref(Date.now());
const { stop: stopClock } = useInterval(() => {
  now.value = Date.now();
}, 30_000);
onBeforeUnmount(stopClock);

// Cumulative zkSYS burned as gas (gas-tank surplus burns); best-effort from
// Blockscout logs and only shown once there is something to show.
const { burnedTotal, requestBurnedTotal } = useEarnCharts();
onMounted(() => {
  requestBurnedTotal().catch(() => undefined);
});
const burnedSuffix = computed(() => {
  const burned = burnedTotal.value ?? 0n;
  if (burned === 0n) return "";
  return ` · ${zkSysFormatTokenCompact(burned)} burned as gas`;
});

const currentPeriodDisplay = computed(() => networkStats.value?.currentPeriod.toString() ?? "0");
const periodCloseSub = computed(() => {
  if (!currentPeriodCloseTime.value) return "";
  const secondsLeft = Number(currentPeriodCloseTime.value) - Math.floor(now.value / 1000);
  if (secondsLeft <= 0) return "Period closed — awaiting distribution";
  return `Closes in ~${zkSysFormatDuration(secondsLeft)}`;
});

const emission = computed(() => {
  if (!networkStats.value || !staticConfig.value) return 0n;
  return zkSysPeriodEmission(
    networkStats.value.currentPeriod,
    staticConfig.value.maxSupply,
    staticConfig.value.periodsPerYear
  );
});
const emissionDisplay = computed(() => zkSysFormatTokenCompact(emission.value));
const emissionSub = computed(() => "Split across all active weight");

const supplyDisplay = computed(() => `${zkSysFormatTokenCompact(networkStats.value?.tokenTotalSupply ?? 0n)} ZKSYS`);
const maxSupplyDisplay = computed(() => zkSysFormatTokenCompact(staticConfig.value?.maxSupply ?? 0n));
const supplyPercent = computed(() =>
  zkSysFormatShare(networkStats.value?.tokenTotalSupply ?? 0n, staticConfig.value?.maxSupply ?? 0n)
);
// zkSysFormatShare can return "<0.01%", which is not valid CSS — keep the bar
// width numeric and clamped separately from the display string.
const supplyBarWidth = computed(() => {
  const supply = networkStats.value?.tokenTotalSupply ?? 0n;
  const max = staticConfig.value?.maxSupply ?? 0n;
  if (max === 0n) return "0%";
  const percent = Math.min(100, Number((supply * 1_000_000n) / max) / 10_000);
  return `${percent}%`;
});

const totalStakedDisplay = computed(() => zkSysFormatTokenCompact(networkStats.value?.totalStaked ?? 0n));
const totalWeightDisplay = computed(() => zkSysFormatTokenCompact(networkStats.value?.totalWeight ?? 0n));
const yourShareSub = computed(() => {
  const weight = userPosition.value?.activeWeight ?? 0n;
  if (weight === 0n) return "Stake weight + sentry weight";
  return `Your share: ${zkSysFormatShare(weight, networkStats.value?.totalWeight ?? 0n)}`;
});

const sentryNodesDisplay = computed(() => (networkStats.value?.activeSentryNodeCount ?? 0n).toString());
</script>

<style lang="scss" scoped>
.earn-stats-grid {
  @apply grid grid-cols-1 gap-block-gap-1/2 xs:grid-cols-2 md:grid-cols-3;

  .supply-progress {
    @apply my-1.5 h-1.5 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800;

    .supply-progress-bar {
      @apply h-full min-w-[2px] rounded-full bg-primary-400;
    }
  }
  .seniority-row {
    @apply mt-1.5 flex cursor-help items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-600;

    .seniority-badge {
      @apply text-[10px] uppercase;
    }
  }
}
</style>
