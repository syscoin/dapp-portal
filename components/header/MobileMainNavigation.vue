<template>
  <HeaderMobileNavigation v-model:opened="modalOpened" title="Menu">
    <transition v-bind="TabsTransition" mode="out-in">
      <div v-if="openedTab === 'main'">
        <TypographyCategoryLabel size="sm" :padded="false" class="mb-4">Network</TypographyCategoryLabel>
        <CommonCardWithLineButtons>
          <DestinationItem
            :label="selectedNetwork.name"
            :icon="ChevronRightIcon"
            size="sm"
            @click="openedTab = 'network'"
          >
            <template #image>
              <DestinationIconContainer>
                <img :src="networkIconUrl(selectedNetwork)" alt="" class="h-6 w-6" />
              </DestinationIconContainer>
            </template>
          </DestinationItem>
        </CommonCardWithLineButtons>

        <TypographyCategoryLabel size="sm">Portal</TypographyCategoryLabel>
        <CommonCardWithLineButtons>
          <DestinationItem label="Bridge" as="RouterLink" :to="{ name: 'bridge' }" size="sm">
            <template #image>
              <DestinationIconContainer>
                <ArrowsUpDownIcon aria-hidden="true" />
              </DestinationIconContainer>
            </template>
          </DestinationItem>
          <DestinationItem label="Assets" as="RouterLink" :to="{ name: 'assets' }" size="sm">
            <template #image>
              <DestinationIconContainer>
                <WalletIcon aria-hidden="true" />
              </DestinationIconContainer>
            </template>
          </DestinationItem>
          <DestinationItem label="Transfers" as="RouterLink" :to="{ name: 'transfers' }" size="sm">
            <template #image>
              <DestinationIconContainer>
                <ArrowsRightLeftIcon aria-hidden="true" />
              </DestinationIconContainer>
            </template>
            <template #label>
              <div class="flex items-center gap-2">
                <span>Transfers</span>
                <CommonBadge v-if="withdrawalsAvailableForClaiming.length">
                  {{ withdrawalsAvailableForClaiming.length }}
                </CommonBadge>
              </div>
            </template>
          </DestinationItem>
          <DestinationItem v-if="isEarnAvailable" label="Earn" as="RouterLink" :to="{ name: 'earn' }" size="sm">
            <template #image>
              <DestinationIconContainer>
                <CircleStackIcon aria-hidden="true" />
              </DestinationIconContainer>
            </template>
            <template #label>
              <div class="flex items-center gap-2">
                <span>Earn</span>
                <CommonBadge v-if="earnActionableCount">
                  {{ earnActionableCount }}
                </CommonBadge>
              </div>
            </template>
          </DestinationItem>
        </CommonCardWithLineButtons>

        <TypographyCategoryLabel size="sm">Theme</TypographyCategoryLabel>
        <CommonCardWithLineButtons>
          <DestinationItem
            :label="selectedColorMode === 'dark' ? 'Dark mode' : 'Light mode'"
            size="sm"
            @click="switchColorMode()"
          >
            <template #image>
              <DestinationIconContainer>
                <SunIcon v-if="selectedColorMode === 'dark'" aria-hidden="true" />
                <MoonIcon v-else aria-hidden="true" />
              </DestinationIconContainer>
            </template>
          </DestinationItem>
        </CommonCardWithLineButtons>
      </div>
      <div v-else-if="openedTab === 'network'">
        <div class="mb-block-gap flex items-center gap-block-padding-1/2">
          <CommonButtonBack size="sm" @click="openedTab = 'main'" />
          <span class="text-lg">Choose network</span>
        </div>
        <CommonCardWithLineButtons>
          <DestinationItem
            v-for="item in mainnetList.filter((e) => !e.hidden)"
            :key="item.key"
            :label="item.name"
            :icon="isNetworkSelected(item) ? CheckIcon : undefined"
            size="sm"
            @click="buttonClicked(item)"
          >
            <template #image>
              <DestinationIconContainer>
                <img :src="networkIconUrl(item)" alt="" class="h-6 w-6" />
              </DestinationIconContainer>
            </template>
          </DestinationItem>
          <template v-if="testnetList.length > 0">
            <hr class="border-neutral-200 dark:border-neutral-800" />
            <p class="mt-2 pl-3 text-xs font-bold text-neutral-600">Testnets</p>
          </template>
          <DestinationItem
            v-for="item in testnetList.filter((e) => !e.hidden)"
            :key="item.key"
            :label="item.name"
            :icon="isNetworkSelected(item) ? CheckIcon : undefined"
            size="sm"
            @click="buttonClicked(item)"
          >
            <template #image>
              <DestinationIconContainer>
                <img :src="networkIconUrl(item)" alt="" class="h-6 w-6" />
              </DestinationIconContainer>
            </template>
          </DestinationItem>
        </CommonCardWithLineButtons>
      </div>
    </transition>
  </HeaderMobileNavigation>
</template>

<script lang="ts" setup>
import {
  ArrowsRightLeftIcon,
  ArrowsUpDownIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleStackIcon,
  MoonIcon,
  SunIcon,
  WalletIcon,
} from "@heroicons/vue/24/outline";

import { chainList } from "@/data/networks";

import type { ZkSyncNetwork } from "@/data/networks";

const mainnetList = computed(() => chainList.filter((e) => e.displaySettings && !e.displaySettings.isTestnet));
const testnetList = computed(() => chainList.filter((e) => e.displaySettings && e.displaySettings.isTestnet));

const props = defineProps({
  opened: {
    type: Boolean,
    default: false,
  },
});

const emit = defineEmits<{
  (eventName: "update:opened", value: boolean): void;
}>();

const route = useRoute();

const { withdrawalsAvailableForClaiming } = storeToRefs(useZkSyncWithdrawalsStore());
// SYSCOIN: mirror the desktop nav's Earn entry and actionable badge.
const { isEarnAvailable, actionableCount: earnActionableCount } = storeToRefs(useZkSysEarnStore());

const TabsTransition = computed(() =>
  openedTab.value === "main" ? TransitionSlideOutToRight : TransitionSlideOutToLeft
);

const openedTab = ref<"main" | "network">("main");
const modalOpened = computed({
  get: () => props.opened,
  set: (value) => emit("update:opened", value),
});
watch(
  () => props.opened,
  (value) => {
    if (!value) {
      openedTab.value = "main";
    }
  }
);

const { switchColorMode, selectedColorMode } = useColorMode();

const { selectedNetwork } = storeToRefs(useNetworkStore());
const isNetworkSelected = (network: ZkSyncNetwork) => selectedNetwork.value.key === network.key;
const networkIconUrl = (network: ZkSyncNetwork) => (network.syscoinBridge ? "/img/syscoin-icon.svg" : "/img/era.svg");
const buttonClicked = (network: ZkSyncNetwork) => {
  if (isNetworkSelected(network)) {
    return;
  }
  window.location.href = getNetworkUrl(network, route.fullPath);
};
</script>

<style scoped lang="scss"></style>
