<script setup>
import { RouterLink, RouterView } from "vue-router";
import { watchEffect } from "vue";
import DeviceBadge from "./components/DeviceBadge.vue";
import { useDevice } from "./composables/useDevice.js";

const device = useDevice();

// 设备档位写在 <html> 上，CSS 用属性选择器切换三端布局，JS 与样式共用同一份判定
watchEffect(() => {
  const root = document.documentElement;
  root.dataset.device = device.device;
  root.dataset.orientation = device.orientation;
});
</script>

<template>
  <div class="app-shell">
    <header class="app-bar">
      <RouterLink class="brand" :to="{ name: 'home' }">
        <span class="brand-mark">游</span>
        <span class="brand-text">
          <strong>像素游戏厅</strong>
          <small>手机 · 平板 · PC 三端自适应</small>
        </span>
      </RouterLink>
      <DeviceBadge />
    </header>
    <main class="app-main">
      <RouterView />
    </main>
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  flex-direction: column;
  /* 固定整屏高度：首页内容超出时自己滚动，游戏页则能拿到确定的剩余高度铺满画布 */
  height: 100dvh;
  padding: calc(env(safe-area-inset-top) + 6px) env(safe-area-inset-right) 0
    env(safe-area-inset-left);
}

.app-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px clamp(12px, 3vw, 28px) 10px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  color: inherit;
  text-decoration: none;
}

.brand-mark {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border-radius: 12px;
  background: linear-gradient(150deg, #4ac1ff, #7c5cff);
  color: #04101c;
  font-weight: 800;
  font-size: 18px;
}

.brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
}

.brand-text strong {
  font-size: clamp(16px, 2.4vw, 20px);
  letter-spacing: 1px;
}

.brand-text small {
  color: var(--text-muted);
  font-size: 12px;
}

.app-main {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

html[data-device="phone"] .brand-mark {
  width: 34px;
  height: 34px;
  font-size: 16px;
}
</style>
