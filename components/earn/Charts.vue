<template>
  <div class="earn-charts">
    <!-- Issuance schedule (deterministic, no indexer needed) -->
    <CommonContentBlock class="chart-block">
      <div class="chart-header">
        <div>
          <div class="chart-title">Issuance schedule</div>
          <div class="chart-subtitle">
            210M zkSYS hard cap — 20% / 12% / 8% of the remaining supply in years 1-3, then 5% per year
          </div>
        </div>
      </div>
      <EarnChart v-if="issuanceData" type="line" :data="issuanceData" :options="issuanceOptions" :height="260" />
      <CommonContentLoader v-else class="chart-loader" />
    </CommonContentBlock>

    <!-- Total staked over time -->
    <CommonContentBlock class="chart-block">
      <div class="chart-header">
        <div>
          <div class="chart-title">Total {{ stakeSymbol }} staked</div>
          <div class="chart-subtitle">Native {{ stakeSymbol }} working in the staking vault</div>
        </div>
      </div>
      <EarnChart v-if="stakingData" type="line" :data="stakingData" :options="stakingOptions" :height="220" />
      <CommonContentLoader v-else-if="stakingHistoryInProgress" class="chart-loader" />
      <CommonEmptyBlock v-else class="chart-empty">No staking activity indexed yet</CommonEmptyBlock>
    </CommonContentBlock>

    <div class="chart-pair">
      <!-- Rewards per period -->
      <CommonContentBlock class="chart-block">
        <div class="chart-header">
          <div>
            <div class="chart-title">Rewards per period</div>
            <div class="chart-subtitle">Distributed vs claimed zkSYS</div>
          </div>
        </div>
        <EarnChart v-if="rewardsData" type="bar" :data="rewardsData" :height="200" />
        <CommonContentLoader v-else-if="rewardsHistoryInProgress" class="chart-loader" />
        <CommonEmptyBlock v-else class="chart-empty">No reward distributions yet</CommonEmptyBlock>
      </CommonContentBlock>

      <!-- Minted vs burned -->
      <CommonContentBlock class="chart-block">
        <div class="chart-header">
          <div>
            <div class="chart-title">Minted vs burned</div>
            <div class="chart-subtitle">Claims mint zkSYS; gas paid via the Pali paymaster burns it</div>
          </div>
        </div>
        <EarnChart v-if="supplyData" type="bar" :data="supplyData" :height="200" />
        <CommonContentLoader v-else-if="supplyFlowsInProgress" class="chart-loader" />
        <CommonEmptyBlock v-else class="chart-empty">No mint or burn activity yet</CommonEmptyBlock>
      </CommonContentBlock>
    </div>
  </div>
</template>

<script lang="ts" setup>
import useEarnCharts from "@/composables/zksys/useEarnCharts";

import type { ChartData, ChartOptions } from "chart.js";

const ISSUANCE_CHART_YEARS_MS = 12 * 365 * 24 * 60 * 60 * 1000;
const PRIMARY = "#205efe";
const PRIMARY_LIGHT = "#5f89ff";
const SUCCESS = "#00CC66";
const ERROR = "#FF6666";
const WARNING = "#E5AF00";

const earnStore = useZkSysEarnStore();
const { staticConfig, networkStats } = storeToRefs(earnStore);
const { selectedNetwork } = storeToRefs(useNetworkStore());
const stakeSymbol = computed(() => selectedNetwork.value.nativeCurrency?.symbol ?? "SYS");

const {
  buildIssuanceSchedule,
  stakingHistory,
  stakingHistoryInProgress,
  requestStakingHistory,
  rewardsHistory,
  rewardsHistoryInProgress,
  requestRewardsHistory,
  supplyFlows,
  supplyFlowsInProgress,
  requestSupplyFlows,
} = useEarnCharts();

onMounted(() => {
  // Historical series are best-effort: stat cards and the deterministic
  // issuance chart still render if Blockscout is unavailable.
  requestStakingHistory().catch(() => undefined);
  requestRewardsHistory().catch(() => undefined);
  requestSupplyFlows().catch(() => undefined);
});

const formatShortDate = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const formatTooltipValue = (value: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(value);

// --- Issuance schedule ---
const issuanceData = computed<ChartData<"line"> | undefined>(() => {
  if (!staticConfig.value || !networkStats.value) return undefined;
  const schedule = buildIssuanceSchedule(staticConfig.value, networkStats.value.tokenTotalSupply);
  const first = schedule.points[0]?.x ?? schedule.nowMs;
  const last = schedule.points[schedule.points.length - 1]?.x ?? schedule.nowMs;
  return {
    datasets: [
      {
        label: "Scheduled supply",
        data: schedule.points,
        borderColor: PRIMARY,
        backgroundColor: "rgba(32, 94, 254, 0.12)",
        fill: true,
        pointRadius: 0,
        borderWidth: 2,
        tension: 0.25,
      },
      {
        label: "210M cap",
        data: [
          { x: first, y: schedule.capTokens },
          { x: last, y: schedule.capTokens },
        ],
        borderColor: WARNING,
        borderDash: [6, 6],
        borderWidth: 1.5,
        pointRadius: 0,
        fill: false,
      },
      {
        label: "Minted so far",
        data: [{ x: schedule.nowMs, y: schedule.mintedTokens }],
        borderColor: SUCCESS,
        backgroundColor: SUCCESS,
        pointRadius: 5,
        pointHoverRadius: 7,
        showLine: false,
      },
    ],
  };
});
const issuanceRange = computed(() => {
  if (!staticConfig.value) return undefined;
  const startMs = Number(staticConfig.value.startTime) * 1000;
  const endMs = startMs + ISSUANCE_CHART_YEARS_MS;
  return { startMs, endMs };
});
const issuanceOptions = computed<ChartOptions>(() => ({
  scales: {
    x: {
      type: "linear",
      min: issuanceRange.value?.startMs,
      max: issuanceRange.value?.endMs,
      ticks: {
        callback: (value: string | number) => new Date(Number(value)).getFullYear().toString(),
      },
    },
    y: {
      ticks: {
        callback: (value: string | number) =>
          new Intl.NumberFormat("en-US", { notation: "compact" }).format(Number(value)),
      },
    },
  },
  plugins: {
    tooltip: {
      callbacks: {
        title: (items: { parsed: { x: number } }[]) =>
          items.length ? new Date(items[0].parsed.x).toLocaleDateString() : "",
        label: (item: { dataset: { label?: string }; parsed: { y: number } }) =>
          ` ${item.dataset.label}: ${formatTooltipValue(item.parsed.y)} ZKSYS`,
      },
    },
  },
}));

// --- Total staked ---
const stakingData = computed<ChartData<"line"> | undefined>(() => {
  const points = stakingHistory.value;
  if (!points || points.length < 2) return undefined;
  return {
    datasets: [
      {
        label: `Total staked (${stakeSymbol.value})`,
        data: points,
        borderColor: PRIMARY,
        backgroundColor: "rgba(32, 94, 254, 0.12)",
        fill: true,
        stepped: true,
        pointRadius: 0,
        borderWidth: 2,
      },
    ],
  };
});
const stakingOptions = computed<ChartOptions>(() => ({
  plugins: {
    legend: { display: false },
    tooltip: {
      callbacks: {
        title: (items: { parsed: { x: number } }[]) =>
          items.length ? new Date(items[0].parsed.x).toLocaleString() : "",
        label: (item: { parsed: { y: number } }) => ` ${formatTooltipValue(item.parsed.y)} ${stakeSymbol.value} staked`,
      },
    },
  },
  scales: {
    x: {
      type: "linear",
      ticks: {
        callback: (value: string | number) => formatShortDate(Number(value)),
      },
    },
  },
}));

// --- Rewards per period ---
const rewardsData = computed<ChartData<"bar"> | undefined>(() => {
  const points = rewardsHistory.value;
  if (!points || !points.length) return undefined;
  return {
    labels: points.map((point) => `#${point.period}`),
    datasets: [
      {
        label: "Distributed",
        data: points.map((point) => point.distributed),
        backgroundColor: PRIMARY_LIGHT,
        borderRadius: 6,
      },
      {
        label: "Claimed",
        data: points.map((point) => point.claimed),
        backgroundColor: SUCCESS,
        borderRadius: 6,
      },
    ],
  };
});

// --- Minted vs burned ---
const supplyData = computed<ChartData<"bar"> | undefined>(() => {
  const points = supplyFlows.value;
  if (!points || !points.length) return undefined;
  return {
    labels: points.map((point) => point.day.slice(5)),
    datasets: [
      {
        label: "Minted",
        data: points.map((point) => point.minted),
        backgroundColor: SUCCESS,
        borderRadius: 6,
      },
      {
        label: "Burned (gas)",
        data: points.map((point) => point.burned),
        backgroundColor: ERROR,
        borderRadius: 6,
      },
    ],
  };
});
</script>

<style lang="scss" scoped>
.earn-charts {
  @apply flex flex-col gap-block-gap;

  .chart-block {
    @apply py-block-padding-1/2;

    .chart-header {
      @apply mb-block-padding-1/2 flex items-start justify-between gap-2;

      .chart-title {
        @apply font-semibold;
      }
      .chart-subtitle {
        @apply mt-0.5 text-sm text-neutral-600 dark:text-neutral-500;
      }
    }
    .chart-loader {
      @apply block h-40 w-full rounded-2xl;
    }
    .chart-empty {
      @apply py-6;
    }
  }
  .chart-pair {
    @apply grid grid-cols-1 gap-block-gap md:grid-cols-2;
  }
}
</style>
