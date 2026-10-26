<script setup>
import { computed } from "vue";
import { DEVICE_LABEL } from "../utils/device.js";
import { useDevice } from "../composables/useDevice.js";

const device = useDevice();

const text = computed(
  () =>
    `${DEVICE_LABEL[device.device]} · ${device.orientation === "portrait" ? "竖屏" : "横屏"} · ${device.width}×${device.height}`
);
</script>

<template>
  <span class="badge" :data-device="device.device">{{ text }}</span>
</template>

<style scoped>
.badge {
  flex: none;
  padding: 4px 10px;
  border: 1px solid var(--panel-edge);
  border-radius: 999px;
  background: var(--bg-soft);
  color: var(--text-muted);
  font-size: 12px;
  white-space: nowrap;
}

/* 手机横屏空间紧张，只保留档位点 */
html[data-device="phone"][data-orientation="landscape"] .badge {
  padding: 4px 8px;
  font-size: 11px;
}
</style>
