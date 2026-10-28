<script setup lang="ts">
import { MessagingFriends } from '@proj-airi/stage-ui/components'
</script>

<template>
  <MessagingFriends />
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.modules.messaging-friends.title
  subtitleKey: settings.title
  stageTransition:
    name: slide
    pageSpecificAvailable: true
</route>
