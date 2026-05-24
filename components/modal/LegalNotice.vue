<template>
  <CommonModal v-model:opened="modalDisplayed" :initial-focus="checkbox" :closable="false">
    <DialogTitle as="div" class="modal-title">zkSYS Bridge is in beta</DialogTitle>
    <p class="modal-text">
      This open-source Syscoin community integration is provided for testing zkSYS bridge, asset, and transaction flows.
      It is beta software, may change without notice, and is provided "as is" without warranties. Nothing on this
      website should be construed as financial, investment, legal, or tax advice. Use it at your own risk.
    </p>

    <CommonCheckboxWithText ref="checkbox" v-model="warningChecked" class="mt-3">
      I understand this is an unaudited beta community integration and I am responsible for verifying transactions
      before signing.
    </CommonCheckboxWithText>
    <CommonButton class="mt-8 w-full" variant="primary" :disabled="!warningChecked" @click="proceed()">
      Proceed
    </CommonButton>
  </CommonModal>
</template>

<script lang="ts" setup>
import { DialogTitle } from "@headlessui/vue";
import { useStorage } from "@vueuse/core";

import { isCustomNode } from "@/data/networks";

const checkbox = ref<HTMLInputElement | undefined>();
const legalNoticeAccepted = useStorage("zksys-bridge-legal-notice-accepted", false);
const warningChecked = ref(legalNoticeAccepted.value);
const modalDisplayed = ref(!legalNoticeAccepted.value && !isCustomNode);

const proceed = () => {
  legalNoticeAccepted.value = true;
  modalDisplayed.value = false;
};
</script>

<style lang="scss" scoped>
.modal-title {
  @apply mb-4 text-center text-2xl font-normal;
}
.modal-text {
  @apply text-center text-sm leading-normal text-neutral-700 dark:text-neutral-400;
}
.checkbox-link {
  @apply underline underline-offset-2;
}
</style>
