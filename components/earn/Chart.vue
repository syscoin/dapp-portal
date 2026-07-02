<template>
  <div class="earn-chart" :style="{ height: `${height}px` }">
    <Line v-if="type === 'line'" :key="chartKey" :data="(data as ChartData<'line'>)" :options="mergedOptions" />
    <Bar v-else :key="chartKey" :data="(data as ChartData<'bar'>)" :options="mergedOptions" />
  </div>
</template>

<script lang="ts" setup>
import {
  BarElement,
  CategoryScale,
  Chart,
  Filler,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip,
} from "chart.js";
import { Bar, Line } from "vue-chartjs";

import type { ChartData, ChartOptions } from "chart.js";

Chart.register(LineElement, PointElement, BarElement, LinearScale, CategoryScale, Tooltip, Legend, Filler);

const props = defineProps({
  type: {
    type: String as PropType<"line" | "bar">,
    default: "line",
  },
  data: {
    type: Object as PropType<ChartData<"line"> | ChartData<"bar">>,
    required: true,
  },
  options: {
    type: Object as PropType<ChartOptions>,
    default: () => ({}),
  },
  height: {
    type: Number,
    default: 240,
  },
});

const { selectedColorMode } = useColorMode();

// SYSCOIN: theme charts with the portal tailwind palette (see tailwind.config.js).
const themeOptions = computed<ChartOptions>(() => {
  const dark = selectedColorMode.value === "dark";
  const grid = dark ? "#3D424D" : "#DADDE5";
  const text = dark ? "#858C99" : "#6C7380";
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: {
        labels: { color: text, usePointStyle: true, boxWidth: 8, boxHeight: 8, padding: 16 },
      },
      tooltip: {
        backgroundColor: dark ? "#262B33" : "#FFFFFF",
        titleColor: dark ? "#FFFFFF" : "#11141A",
        bodyColor: text,
        borderColor: grid,
        borderWidth: 1,
        padding: 12,
        cornerRadius: 12,
        boxPadding: 4,
        usePointStyle: true,
      },
    },
    scales: {
      x: {
        grid: { display: false },
        border: { color: grid },
        ticks: { color: text, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 },
      },
      y: {
        grid: { color: grid },
        border: { display: false },
        ticks: { color: text, maxTicksLimit: 6 },
      },
    },
  };
});

const deepMerge = (base: any, override: any): any => {
  if (!override) return base;
  const result: any = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === "object" && !Array.isArray(value) && typeof result[key] === "object") {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
};

const mergedOptions = computed<ChartOptions>(() => deepMerge(themeOptions.value, props.options));
// Re-create the chart when the color mode flips so theme colors fully apply.
const chartKey = computed(() => selectedColorMode.value);
</script>

<style lang="scss" scoped>
.earn-chart {
  @apply relative w-full;
}
</style>
