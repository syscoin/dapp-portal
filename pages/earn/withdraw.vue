<template>
  <EarnWithdrawView />
</template>

<script lang="ts" setup>
import { earn as earnMeta } from "@/data/meta";
import EarnWithdrawView from "@/views/earn/EarnWithdraw.vue";

useSeoMeta({
  title: earnMeta.title,
  ogTitle: earnMeta.title,
  description: earnMeta.description,
  ogDescription: earnMeta.description,
  ogImage: earnMeta.previewImg.src,
  ogImageAlt: earnMeta.previewImg.alt,
  twitterImage: earnMeta.previewImg.src,
  twitterImageAlt: earnMeta.previewImg.alt,
  twitterCard: "summary_large_image",
});
</script>

<style lang="scss" scoped></style>
