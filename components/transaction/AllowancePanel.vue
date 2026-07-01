<template>
  <CommonCardWithLineButtons class="mt-4">
    <DestinationItem
      v-if="enoughAllowance && setAllowanceReceipts?.length"
      as="div"
      :description="`You can now proceed to withdraw`"
    >
      <template #label>
        {{ preparationCompleteLabel }}
        <template v-for="allowanceReceipt in setAllowanceReceipts" :key="allowanceReceipt.transactionHash">
          <a
            v-if="blockExplorerUrl"
            :href="`${blockExplorerUrl}/tx/${allowanceReceipt.transactionHash}`"
            target="_blank"
            class="inline-flex items-center gap-1 underline underline-offset-2"
          >
            View on Explorer
            <ArrowTopRightOnSquareIcon class="h-6 w-6" aria-hidden="true" />
          </a>
        </template>
      </template>
      <template #image>
        <div class="aspect-square h-full w-full rounded-full bg-success-400 p-3 text-black">
          <CheckIcon aria-hidden="true" />
        </div>
      </template>
    </DestinationItem>
    <DestinationItem v-else as="div">
      <template #label>
        {{ preparationRequiredLabel }}
        <template v-for="allowanceTransactionHash in setAllowanceTransactionHashes" :key="allowanceTransactionHash">
          <a
            v-if="blockExplorerUrl && allowanceTransactionHash"
            :href="`${blockExplorerUrl}/tx/${allowanceTransactionHash}`"
            target="_blank"
            class="inline-flex items-center gap-1 underline underline-offset-2"
          >
            View on Explorer
            <ArrowTopRightOnSquareIcon class="h-6 w-6" aria-hidden="true" />
          </a>
        </template>
      </template>
      <template #underline>
        {{ preparationDescription }}
        <span v-if="showAllowanceAmount"
          >You can withdraw up to
          <CommonButtonLabel variant="light" @click="setAmountToCurrentAllowance()">
            {{ parseTokenAmount(allowance!, selectedToken!.decimals) }}
          </CommonButtonLabel>
          {{ selectedToken!.symbol }} without approving a new allowance.
        </span>
        <CommonButtonLabel variant="light" as="a" :href="TOKEN_ALLOWANCE" target="_blank">
          Learn more
        </CommonButtonLabel>
      </template>
      <template #image>
        <div class="aspect-square h-full w-full rounded-full bg-warning-400 p-3 text-black">
          <LockClosedIcon aria-hidden="true" />
        </div>
      </template>
    </DestinationItem>
  </CommonCardWithLineButtons>
</template>

<script lang="ts" setup>
import { LockClosedIcon, ArrowTopRightOnSquareIcon, CheckIcon } from "@heroicons/vue/24/outline";

import type { Token } from "@/types";
import type { Hash } from "viem";

const props = defineProps<{
  tokenAddress: string;
  assetId: string;
  selectedToken: Token;
  enoughAllowance: boolean;
  blockExplorerUrl: string | undefined;
  allowance: bigint;
  registrationRequired?: boolean;
  migrationRequired?: boolean;
  migrationInitiated?: boolean;
  setAllowanceReceipts: { transactionHash: Hash }[] | undefined;
  setAllowanceTransactionHashes: (Hash | undefined)[];
}>();

const emit = defineEmits<{
  (e: "setAmount", amount: bigint): void;
}>();

const setAmountToCurrentAllowance = () => {
  if (!props.allowance) {
    return;
  }
  emit("setAmount", props.allowance);
};

const preparationRequiredLabel = computed(() => {
  if (props.registrationRequired) return `Register ${props.selectedToken?.symbol} for withdrawal`;
  if (props.migrationRequired) {
    return props.migrationInitiated
      ? `${props.selectedToken?.symbol} Gateway migration pending`
      : `Migrate ${props.selectedToken?.symbol} to Gateway`;
  }
  return `Approve ${props.selectedToken?.symbol} allowance`;
});

const preparationCompleteLabel = computed(() => {
  if (props.migrationInitiated && props.migrationRequired) return `${props.selectedToken?.symbol} migration submitted`;
  return `${props.selectedToken?.symbol} withdrawal prepared`;
});

const preparationDescription = computed(() => {
  if (props.registrationRequired) {
    return "Before withdrawing, this token needs to be registered with the NativeTokenVault.";
  }
  if (props.migrationRequired && props.migrationInitiated) {
    return "Gateway migration has been submitted. Wait for the system confirmation transaction, then check the status again.";
  }
  if (props.migrationRequired) {
    return "Before withdrawing, this token's Gateway accounting needs to be migrated once for the current chain migration.";
  }
  return `Before withdrawing you need to give our bridge permission to spend the specified amount of ${props.selectedToken?.symbol}.`;
});

const showAllowanceAmount = computed(() => {
  return !props.registrationRequired && !props.migrationRequired && props.allowance && props.allowance !== 0n;
});
</script>
