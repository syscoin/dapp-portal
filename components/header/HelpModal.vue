<template>
  <CommonModal title="Help">
    <div class="-mx-block-padding-1/2">
      <DestinationItem
        label="Discord"
        description="Get support, follow announcements, and connect with the Syscoin community"
        as="a"
        href="https://discord.gg/syscoin"
        target="_blank"
        :icon="ArrowTopRightOnSquareIcon"
        variant="light"
      >
        <template #image>
          <div class="flex h-full w-full items-center justify-center rounded-full bg-[#5865F2] text-white">
            <IconsDiscord class="h-6 w-6" />
          </div>
        </template>
      </DestinationItem>
      <DestinationItem
        label="Syscoin Docs"
        description="Read network, wallet, and ecosystem documentation"
        as="a"
        href="https://docs.syscoin.org"
        target="_blank"
        :icon="ArrowTopRightOnSquareIcon"
        variant="light"
      >
        <template #image>
          <DestinationIconContainer>
            <QuestionMarkCircleIcon aria-hidden="true" />
          </DestinationIconContainer>
        </template>
      </DestinationItem>
      <DestinationItem
        label="zkSYS Explorer"
        description="Inspect zkSYS blocks, transactions, and contracts"
        as="a"
        href="https://explorer-zk.tanenbaum.io"
        target="_blank"
        :icon="ArrowTopRightOnSquareIcon"
        variant="light"
      >
        <template #image>
          <DestinationIconContainer>
            <BookOpenIcon aria-hidden="true" />
          </DestinationIconContainer>
        </template>
      </DestinationItem>
    </div>
  </CommonModal>
</template>

<script lang="ts" setup>
import { ArrowTopRightOnSquareIcon, BookOpenIcon, QuestionMarkCircleIcon } from "@heroicons/vue/24/outline";
</script>
