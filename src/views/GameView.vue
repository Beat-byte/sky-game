<script setup>
import { computed, defineAsyncComponent, shallowRef, watchEffect } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { findGame } from "../games/registry.js";

const route = useRoute();
const game = computed(() => findGame(route.params.id));
const view = shallowRef(null);

// 每个游戏的组件按需异步加载：首页不会把游戏代码一起下载
watchEffect(() => {
  const current = game.value;
  view.value = current && current.status === "ready" ? defineAsyncComponent(current.load) : null;
});
</script>

<template>
  <section v-if="game" class="game-page">
    <header class="game-head">
      <RouterLink class="btn btn--back" :to="{ name: 'home' }">← 游戏厅</RouterLink>
      <div class="game-name">
        <h1>{{ game.name }}</h1>
        <p class="muted">{{ game.subtitle }}</p>
      </div>
    </header>

    <div v-if="view" class="game-body">
      <component :is="view" />
    </div>
    <div v-else class="game-soon">
      <p>《{{ game.name }}》还在计划中，先回去玩已上线的游戏吧。</p>
      <RouterLink class="btn btn--primary" :to="{ name: 'home' }">返回游戏厅</RouterLink>
    </div>
  </section>
</template>

<style scoped>
.game-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  padding: 0 var(--gutter) calc(env(safe-area-inset-bottom) + 10px);
}

.game-head {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 4px 0 10px;
}

.game-name h1 {
  margin: 0;
  font-size: clamp(17px, 3vw, 24px);
  letter-spacing: 0.5px;
}

.game-name p {
  margin: 0;
  font-size: 12px;
}

.btn--back {
  min-height: 40px;
  padding: 8px 14px;
  color: inherit;
  text-decoration: none;
  font-size: 14px;
}

.game-body {
  display: flex;
  flex: 1;
  min-height: 0;
}

.game-soon {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 40px 16px;
  text-align: center;
}

/* 手机竖屏：返回按钮收成图标块，标题占满剩余宽度 */
html[data-device="phone"] .game-head {
  gap: 10px;
}

html[data-device="phone"] .btn--back {
  min-width: 84px;
}

html[data-device="phone"][data-orientation="landscape"] .game-head {
  padding-bottom: 4px;
}

html[data-device="phone"][data-orientation="landscape"] .game-name p {
  display: none;
}
</style>
