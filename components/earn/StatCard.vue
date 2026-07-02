<template>
  <div class="earn-stat-card" :class="{ 'is-disabled': disabled }">
    <div class="stat-label">
      <span>{{ label }}</span>
      <CommonBadge v-if="badge" class="stat-badge">{{ badge }}</CommonBadge>
    </div>
    <div class="stat-value">
      <CommonContentLoader v-if="loading" :length="14" />
      <template v-else>
        <slot>{{ value }}</slot>
      </template>
    </div>
    <div v-if="sub || $slots.sub" class="stat-sub">
      <slot name="sub">{{ sub }}</slot>
    </div>
  </div>
</template>

<script lang="ts" setup>
defineProps({
  label: {
    type: String,
    required: true,
  },
  value: {
    type: String,
    default: "",
  },
  sub: {
    type: String,
    default: "",
  },
  badge: {
    type: String,
    default: "",
  },
  loading: {
    type: Boolean,
    default: false,
  },
  disabled: {
    type: Boolean,
    default: false,
  },
});
</script>

<style lang="scss" scoped>
.earn-stat-card {
  @apply flex flex-col gap-1 rounded-3xl bg-neutral-100 p-block-padding-1/2 dark:bg-neutral-900;

  &.is-disabled {
    @apply opacity-60;
  }

  .stat-label {
    @apply flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-500;

    .stat-badge {
      @apply text-xs;
    }
  }
  .stat-value {
    @apply break-words text-xl font-medium leading-tight;
  }
  .stat-sub {
    @apply text-sm text-neutral-600 dark:text-neutral-500;
  }
}
</style>
