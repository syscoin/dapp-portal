<template>
  <CommonButtonUnderlineText :opened="opened">
    Confirm this transaction in your {{ walletLabel }}
  </CommonButtonUnderlineText>
</template>

<script lang="ts" setup>
defineProps({
  opened: {
    type: Boolean,
    required: true,
  },
});

const { walletName } = storeToRefs(useOnboardStore());
const walletLabel = computed(() => (walletName.value ? `${walletName.value} wallet` : "wallet"));
</script>
