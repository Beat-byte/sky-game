<script setup>
import GameCard from "../components/GameCard.vue";
import { useDevice } from "../composables/useDevice.js";
import { DEVICE_LABEL } from "../utils/device.js";
import { GAMES } from "../games/registry.js";

const device = useDevice();
</script>

<template>
  <section class="home">
    <div class="hero">
      <h1>选一个开始</h1>
      <p class="muted">
        当前识别为<strong>{{ DEVICE_LABEL[device.device] }} · {{ device.orientation === "portrait" ? "竖屏" : "横屏" }}</strong>，
        布局与控件尺寸会按档位重新计算；格子类游戏的行列数恒定，战术撤离的可视范围恒为 28×18 米 —— 三端难度一致。
      </p>
      <ul class="tips">
        <li><span class="chip">手机</span> 单指拖动或滑动操作，按钮不小于 48 px</li>
        <li><span class="chip">平板</span> 横屏侧栏、竖屏下栏，触摸与键盘都能用</li>
        <li><span class="chip">PC</span> <kbd>←</kbd><kbd>→</kbd> 移动 · <kbd>空格</kbd> 发射/硬降 · <kbd>P</kbd> 暂停 · <kbd>R</kbd> 重开</li>
      </ul>
    </div>

    <div class="grid">
      <GameCard v-for="game in GAMES" :key="game.id" :game="game" />
    </div>

    <p class="note muted">
      新增游戏：在 <code>src/games/</code> 下建一个目录，并在 <code>src/games/registry.js</code> 登记一条记录，首页自动出现入口。
    </p>
  </section>
</template>

<style scoped>
.home {
  display: flex;
  flex-direction: column;
  gap: var(--gap);
  padding: 6px var(--gutter) calc(env(safe-area-inset-bottom) + 28px);
  max-width: 1240px;
  width: 100%;
  margin: 0 auto;
}

.hero h1 {
  margin: 0 0 6px;
  font-size: clamp(22px, 4.6vw, 34px);
  letter-spacing: 1px;
}

.hero p {
  margin: 0;
  font-size: clamp(13px, 2.4vw, 15px);
}

.hero strong {
  color: var(--accent);
}

.tips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
  margin: 14px 0 0;
  padding: 0;
  list-style: none;
  color: var(--text-muted);
  font-size: 13px;
}

.tips li {
  display: flex;
  align-items: center;
  gap: 8px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr));
  gap: var(--gap);
}

.note {
  margin: 0;
  font-size: 12px;
}

.note code {
  padding: 1px 5px;
  border-radius: 6px;
  background: var(--bg-soft);
  color: var(--accent);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

/* 手机竖屏一列、平板两列、桌面按宽度自动铺满（注册表加到五款也不会挤出落单的孤条） */
html[data-device="phone"] .grid {
  grid-template-columns: 1fr;
}

html[data-device="tablet"] .grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

html[data-device="desktop"] .grid {
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 1fr));
}

html[data-device="phone"][data-orientation="landscape"] .grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
</style>
