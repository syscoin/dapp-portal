<template>
  <component
    :is="as"
    type="button"
    class="default-button"
    :class="[`size-${size}`, `variant-${variant}`]"
    :tabindex="disabledLinkTabIndex"
    @click.capture="preventDisabledActivation"
    @keydown.enter.capture="preventDisabledActivation"
    @keydown.space.capture="preventDisabledActivation"
  >
    <span v-if="$slots.icon" class="icon-container">
      <slot name="icon" />
    </span>
    <slot />
  </component>
</template>

<script lang="ts" setup>
const attrs = useAttrs();

defineProps({
  as: {
    type: [String, Object] as PropType<string | Component>,
    default: "button",
  },
  variant: {
    type: String as PropType<"default" | "primary" | "light" | "error" | "cancel">,
    default: "default",
  },
  size: {
    type: String as PropType<"xs" | "sm" | "md">,
    default: "md",
  },
});

const isAriaDisabled = computed(() => attrs["aria-disabled"] === true || attrs["aria-disabled"] === "true");
const disabledLinkTabIndex = computed(() => (isAriaDisabled.value ? -1 : undefined));

const preventDisabledActivation = (event: MouseEvent | KeyboardEvent) => {
  if (!isAriaDisabled.value) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
};
</script>

<style lang="scss">
.default-button {
  @apply flex items-center justify-center border border-transparent text-center backdrop-blur-sm transition-colors wrap-balance;
  &:is(label) {
    @apply cursor-pointer;
  }
  &:enabled,
  &:is(a, label) {
    &:not([aria-disabled="true"]) {
      @apply cursor-pointer;
    }
  }
  &.size- {
    &xs {
      @apply rounded-2xl px-4 py-2;
    }
    &sm {
      @apply rounded-[20px] p-3;
    }
    &md {
      @apply rounded-3xl p-4;
    }
  }
  &.variant- {
    &default {
      @apply border-neutral-300 bg-neutral-100 text-neutral-900 shadow-sm dark:border-neutral-700 dark:bg-neutral-900 dark:text-white;
      &:enabled,
      &:is(a, label) {
        &:not([aria-disabled="true"]) {
          @apply hover:border-neutral-400 hover:bg-neutral-200 dark:hover:border-neutral-600 dark:hover:bg-neutral-800 dark:focus-visible:bg-neutral-800;
        }
      }
    }
    &light {
      @apply border-neutral-300 bg-neutral-200 text-neutral-900 shadow-sm transition dark:border-neutral-700 dark:bg-neutral-800 dark:text-white;
      &:enabled,
      &:is(a, label) {
        &:not([aria-disabled="true"]) {
          @apply hover:border-neutral-400 hover:bg-neutral-300 dark:hover:border-neutral-600 dark:hover:bg-neutral-700 dark:focus-visible:bg-neutral-700;
        }
      }
    }
    &primary {
      @apply bg-primary-400 px-6 text-white;
      &:enabled,
      &:is(a, label) {
        &:not([aria-disabled="true"]) {
          @apply hover:bg-primary-300;
        }
      }
    }
    &error {
      @apply bg-red-100/50 text-red-400 dark:bg-red-700 dark:text-white;
      &:enabled,
      &:is(a, label) {
        &:not([aria-disabled="true"]) {
          @apply hover:bg-red-100/75 dark:hover:bg-red-600;
        }
      }
    }
    &cancel {
      @apply bg-neutral-100 text-neutral-600 hover:bg-neutral-200 dark:bg-red-700/30 dark:text-red-300/70;
      &:enabled,
      &:is(a, label) {
        &:not([aria-disabled="true"]) {
          @apply hover:text-neutral-800 dark:hover:bg-red-700/60 dark:hover:text-red-300;
        }
      }
    }
  }
  &:disabled,
  &[aria-disabled="true"] {
    @apply pointer-events-none cursor-not-allowed border-transparent bg-neutral-200 text-neutral-500 shadow-none dark:bg-neutral-800 dark:text-neutral-500;
  }
  .icon-container {
    @apply -ml-0.5 mr-2 inline-flex items-center;

    svg {
      @apply block h-4 w-4;
    }
  }
}
</style>
