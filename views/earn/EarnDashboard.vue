<template>
  <div>
    <PageTitle>Earn</PageTitle>

    <template v-if="!isEarnAvailable">
      <CommonAlert variant="warning" :icon="ExclamationTriangleIcon">
        <p>zkSYS Earn is not available on {{ selectedNetwork.name }}. Switch to a zkSYS network to stake SYS.</p>
      </CommonAlert>
    </template>

    <template v-else>
      <!-- Hero -->
      <CommonContentBlock class="earn-hero">
        <div class="hero-copy">
          <h2 class="hero-title">Stake SYS. Earn zkSYS.</h2>
          <p class="hero-description">
            zkSYS is earned through work, like Bitcoin — no premine beyond the schedule. Stake native
            {{ stakeSymbol }} or run a sentry node to share each day's emission from the 210M supply.
          </p>
        </div>
        <div class="hero-actions">
          <CommonButton variant="primary" as="RouterLink" :to="{ name: 'earn-stake' }">
            <template #icon><PlusIcon aria-hidden="true" /></template>
            Stake {{ stakeSymbol }}
          </CommonButton>
          <CommonButton as="RouterLink" :to="{ name: 'earn-withdraw' }">Withdraw</CommonButton>
        </div>
      </CommonContentBlock>

      <!-- Lifecycle explainer / live state -->
      <EarnLifecycle class="mt-block-gap" />

      <!-- Position -->
      <TypographyCategoryLabel>Your position</TypographyCategoryLabel>
      <ConnectWalletBlock v-if="!isConnected">
        Connect wallet to stake {{ stakeSymbol }} and track your zkSYS rewards
      </ConnectWalletBlock>
      <EarnPositionCard v-else />

      <!-- Gas tank (prepaid zkSYS gas) -->
      <template v-if="isConnected && isGasTankAvailable">
        <TypographyCategoryLabel>Gas tank</TypographyCategoryLabel>
        <EarnGasTankCard />
      </template>

      <!-- Network stats -->
      <TypographyCategoryLabel>
        <span>Network</span>
        <template #right>
          <CommonButtonLabel variant="light" @click="refreshNetwork()">Refresh</CommonButtonLabel>
        </template>
      </TypographyCategoryLabel>
      <CommonErrorBlock v-if="networkStatsError" @try-again="refreshNetwork">
        Getting network stats error: {{ networkStatsError.message }}
      </CommonErrorBlock>
      <EarnStatsGrid v-else />

      <!-- Analytics -->
      <TypographyCategoryLabel>Analytics</TypographyCategoryLabel>
      <EarnCharts />

      <!-- Sentry nodes info -->
      <TypographyCategoryLabel>Sentry nodes</TypographyCategoryLabel>
      <CommonContentBlock class="sentry-info">
        <p>
          Sentry nodes registered on Syscoin L1 receive reward weight here automatically — no staking transaction
          needed. Weight follows the same warm-up and activation flow as staked {{ stakeSymbol }}.
        </p>
        <p class="mt-2">
          <span class="font-medium">Seniority boost:</span> longer-standing nodes will earn extra weight based on how
          long their collateral has been locked. The mechanism is deployed on-chain but
          <span class="font-medium">currently disabled</span> (bonus rates set to zero) and will be enabled later.
        </p>
      </CommonContentBlock>
    </template>
  </div>
</template>

<script lang="ts" setup>
import { ExclamationTriangleIcon, PlusIcon } from "@heroicons/vue/24/outline";

const earnStore = useZkSysEarnStore();
const onboardStore = useOnboardStore();
const { isConnected } = storeToRefs(onboardStore);
const { selectedNetwork } = storeToRefs(useNetworkStore());
const { isEarnAvailable, isGasTankAvailable, networkStatsError } = storeToRefs(earnStore);

const stakeSymbol = computed(() => selectedNetwork.value.nativeCurrency?.symbol ?? "SYS");

const fetchAll = () => {
  if (!isEarnAvailable.value) return;
  earnStore.requestStaticConfig().catch(() => undefined);
  earnStore.requestNetworkSummary().catch(() => undefined);
  earnStore.requestGasTankStats().catch(() => undefined);
  if (isConnected.value) {
    earnStore.requestUserPosition().catch(() => undefined);
    earnStore.requestGasTankPosition().catch(() => undefined);
  }
};
const refreshNetwork = () => {
  earnStore.requestNetworkSummary({ force: true, forceBurnedTotal: true }).catch(() => undefined);
};

fetchAll();
const { reset: resetAutoUpdate, stop: stopAutoUpdate } = useInterval(() => {
  if (!isEarnAvailable.value) return;
  earnStore.requestNetworkSummary({ force: true }).catch(() => undefined);
  earnStore.requestGasTankStats({ force: true }).catch(() => undefined);
  if (isConnected.value) {
    earnStore.requestUserPosition({ force: true }).catch(() => undefined);
    earnStore.requestGasTankPosition({ force: true }).catch(() => undefined);
  }
}, 30_000);

const unsubscribe = onboardStore.subscribeOnAccountChange((newAddress) => {
  if (!newAddress) return;
  resetAutoUpdate();
  fetchAll();
});

onBeforeUnmount(() => {
  stopAutoUpdate();
  unsubscribe();
});
</script>

<style lang="scss" scoped>
.earn-hero {
  @apply relative overflow-hidden;

  &::before {
    content: "";
    @apply pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-primary-400/10 blur-2xl;
  }

  .hero-copy {
    @apply relative;

    .hero-title {
      @apply text-2xl font-bold leading-tight sm:text-3xl;
    }
    .hero-description {
      @apply mt-2 max-w-xl text-neutral-700 dark:text-neutral-400;
    }
  }
  .hero-actions {
    @apply relative mt-block-padding-1/2 flex flex-wrap items-center gap-3;
  }
}
.sentry-info {
  @apply py-block-padding-1/2 text-sm text-neutral-700 dark:text-neutral-400;
}
</style>
