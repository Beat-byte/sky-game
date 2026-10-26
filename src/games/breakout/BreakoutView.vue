<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { Game } from "./game.js";
import { LEVELS } from "./levels.js";
import { applyField, canvasBox, computeLayout } from "./layout.js";
import { bindInput } from "./input.js";
import { draw, setupCanvas } from "./renderer.js";
import { createAudio } from "./audio.js";
import { POWERUPS, POWERUP_KEYS } from "./powerups.js";
import { useGameStats, usePrefs, useStorageAvailable, useStore } from "../../composables/useStore.js";

const GAME_ID = "breakout";

const stageEl = ref(null);
const canvasEl = ref(null);
const hud = reactive({ score: 0, best: 0, lives: 3, level: 1, bricksLeft: 0, combo: 1 });
const status = ref("ready");
const muted = ref(false);
const soundLabel = computed(() => (muted.value ? "已静音" : "静音"));
const store = useStore();
const profile = useGameStats(GAME_ID);
const prefs = usePrefs();
const storageOk = useStorageAvailable();

const stats = [
  { key: "score", label: "分数" },
  { key: "best", label: "最高" },
  { key: "lives", label: "生命" },
  { key: "level", label: "关卡" },
  { key: "bricksLeft", label: "剩余砖" },
  { key: "combo", label: "连击" },
];

let game = null;
let audio = null;
let input = null;
let ctx = null;
let observer = null;
let rafId = 0;
let last = 0;
let statsCache = "";
let storedBest = 0;
let session = null;
let layout = null;

const OVERLAY = {
  ready: {
    title: "准备开始",
    text: `拖动或鼠标移动挡板，轻点或空格发射。共 ${LEVELS.length} 关，钢块打不碎。`,
    button: "开始游戏",
  },
  paused: { title: "已暂停", text: "按 P / Esc 或点击「继续」恢复。", button: "继续" },
  cleared: { title: "关卡通过", text: "奖励 200 分，下一关小球更快。", button: "进入下一关" },
  over: { title: "游戏结束", text: () => `最终得分 ${game.score} 分。`, button: "再来一次" },
  won: { title: "全部通关", text: () => `恭喜！总分 ${game.score} 分。`, button: "重新挑战" },
};

const overlay = computed(() => (OVERLAY[status.value] ? { ...OVERLAY[status.value] } : null));
const legend = POWERUP_KEYS.map((key) => ({ key, ...POWERUPS[key] }));

/** 一局只在结束时落一次盘：开局记时间戳，通关、生命用尽、中途退出都会留档 */
function beginSession() {
  session = { startedAt: Date.now() };
}

function endSession(outcome) {
  if (!session) return;
  const ms = Math.max(0, Date.now() - session.startedAt);
  session = null;
  storedBest = store.commitRun(GAME_ID, { score: game.score, level: game.levelIndex + 1, ms, outcome });
}

const OUTCOME = { over: "生命用尽", won: "全部通关", quit: "中途退出" };

function runLabel(run) {
  if (run.legacy) return "旧版最高分";
  return OUTCOME[run.outcome] ?? "中途退出";
}

function formatMs(ms) {
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  return minutes > 0 ? `${minutes} 分 ${String(total % 60).padStart(2, "0")} 秒` : `${total} 秒`;
}

function formatAt(at) {
  const d = new Date(at);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 舞台可用盒子：扣掉边框与滚动条，保证画布永不溢出视口 */
function availableBox() {
  const rect = stageEl.value.getBoundingClientRect();
  return { width: Math.max(1, rect.width - 2), height: Math.max(1, rect.height - 2) };
}

function relayout() {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  layout = computeLayout(viewport, availableBox());
  applyField(layout.field, layout.device);
  game.relayout();
  ctx = setupCanvas(canvasEl.value, canvasBox(layout, availableBox()));
}

function syncHud() {
  const next = game.hud();
  const signature = `${next.score}|${next.lives}|${next.level}|${next.bricksLeft}|${next.combo}`;
  if (signature === statsCache) return;
  statsCache = signature;
  Object.assign(hud, next, { best: Math.max(storedBest, next.score) });
}

function syncStatus() {
  syncHud();
  if (game.status !== status.value && (game.status === "over" || game.status === "won")) {
    endSession(game.status);
  }
  status.value = game.status;
}

function primaryAction() {
  audio.unlock();
  switch (game.status) {
    case "ready":
      game.start();
      beginSession();
      break;
    case "paused":
      game.togglePause();
      break;
    case "cleared":
      game.nextLevel();
      break;
    case "over":
    case "won":
      game.reset();
      game.start();
      beginSession();
      break;
    default:
      game.launch();
  }
  syncStatus();
}

function launchOrContinue() {
  audio.unlock();
  if (game.status === "paused") game.togglePause();
  else game.launch();
  syncStatus();
}

function togglePause() {
  if (game.status === "ready") {
    game.start();
    beginSession();
  } else {
    game.togglePause();
  }
  syncStatus();
}

function restart() {
  endSession("quit");
  game.reset();
  game.start();
  beginSession();
  syncStatus();
}

function toggleSound() {
  audio.unlock();
  muted.value = !muted.value;
  audio.setMuted(muted.value);
  store.setPref("muted", muted.value);
}

function frame(now) {
  const delta = Math.min(0.05, (now - last) / 1000);
  last = now;

  const dx = input.readPaddleDelta(1);
  if (dx !== 0) game.movePaddleTo(game.paddle.x + game.paddle.w / 2 + dx);

  game.update(delta);
  syncStatus();
  if (ctx) draw(ctx, game, now / 1000);
  rafId = requestAnimationFrame(frame);
}

onMounted(() => {
  storedBest = profile.value.best;
  muted.value = prefs.value.muted === true;
  audio = createAudio();
  audio.setMuted(muted.value);
  game = new Game({ onSound: (name) => audio.play(name) });
  input = bindInput({
    canvas: canvasEl.value,
    onPointer: (x) => {
      audio.unlock();
      game.movePaddleTo(x);
    },
    onAction: (name) => {
      audio.unlock();
      if (name === "primary" || name === "confirm") primaryAction();
      else if (name === "restart") restart();
      else if (name === "pause") togglePause();
      else if (name === "mute") toggleSound();
    },
  });

  relayout();
  syncStatus();

  observer = new ResizeObserver(() => relayout());
  observer.observe(stageEl.value);
  window.addEventListener("orientationchange", onRotate);
  window.addEventListener("resize", relayout);

  last = performance.now();
  rafId = requestAnimationFrame(frame);

  if (import.meta.env.DEV) {
    // 便于在控制台或自动化脚本里检查运行状态与强制重排
    window.game = game;
    window.layout = () => layout;
    window.relayout = relayout;
  }
});

function onRotate() {
  setTimeout(relayout, 120);
}

onBeforeUnmount(() => {
  endSession("quit");
  cancelAnimationFrame(rafId);
  observer?.disconnect();
  window.removeEventListener("resize", relayout);
  window.removeEventListener("orientationchange", onRotate);
  input?.unbind();
  audio?.dispose?.();
  if (import.meta.env.DEV) {
    delete window.game;
    delete window.layout;
    delete window.relayout;
  }
});
</script>

<template>
  <div class="playfield">
    <div ref="stageEl" class="stage">
      <canvas ref="canvasEl" class="board" aria-label="像素弹球游戏画面" />
      <div v-if="overlay" class="overlay">
        <div class="overlay-card">
          <h2>{{ overlay.title }}</h2>
          <p>{{ typeof overlay.text === "function" ? overlay.text() : overlay.text }}</p>
          <button class="btn btn--primary" @click="primaryAction">{{ overlay.button }}</button>
        </div>
      </div>
    </div>

    <aside class="side">
      <dl class="stats">
        <template v-for="item in stats" :key="item.key">
          <dt>{{ item.label }}</dt>
          <dd :class="{ 'is-combo': item.key === 'combo' && hud.combo > 1 }">
            {{ item.key === "lives" ? "♥".repeat(Math.max(0, hud.lives)) : item.key === "level" ? `${hud.level} / ${LEVELS.length}` : item.key === "combo" ? (hud.combo > 1 ? `×${Math.min(4, 1 + (hud.combo - 1) * 0.25).toFixed(2)}` : "—") : hud[item.key] }}
          </dd>
        </template>
      </dl>

      <div class="controls">
        <button class="btn btn--primary" @click="launchOrContinue">发射</button>
        <button class="btn" @click="togglePause">暂停</button>
        <button class="btn" @click="restart">重开</button>
        <button class="btn" @click="toggleSound">{{ soundLabel }}</button>
      </div>

      <p v-if="!storageOk" class="notice">本地存储写不进去（隐私模式或配额已满），本局成绩不会保存。</p>

      <section class="history">
        <h3 class="history-title">
          最近战绩<span class="muted">累计 {{ profile.plays }} 局</span>
        </h3>
        <ol v-if="profile.recent.length" class="history-list">
          <li v-for="(run, i) in profile.recent" :key="`${run.at}-${i}`">
            <b>{{ run.score }}</b>
            <span>{{ run.legacy ? "—" : `第 ${run.level} 关` }}</span>
            <span>{{ run.ms ? formatMs(run.ms) : "—" }}</span>
            <span class="muted">{{ runLabel(run) }}</span>
            <time class="muted">{{ formatAt(run.at) }}</time>
          </li>
        </ol>
        <p v-else class="muted">还没有战绩，打完一局或中途退出都会留档。</p>
      </section>

      <details class="guide">
        <summary>道具与操作</summary>
        <ul class="legend">
          <li v-for="item in legend" :key="item.key">
            <span class="dot" :style="{ background: item.color }">{{ item.label }}</span>
            <span class="muted">{{ item.seconds ? `${item.seconds} 秒` : "本局有效" }}</span>
          </li>
        </ul>
        <p class="keys muted">
          <kbd>←</kbd><kbd>→</kbd> 或 <kbd>A</kbd><kbd>D</kbd> 移动 · <kbd>空格</kbd> 发射 · <kbd>P</kbd> 暂停 ·
          <kbd>R</kbd> 重开 · <kbd>M</kbd> 静音；触屏直接拖动挡板，轻点发射。
        </p>
      </details>
    </aside>
  </div>
</template>

<style scoped>
.playfield {
  display: grid;
  flex: 1;
  gap: var(--gap);
  min-height: 0;
  grid-template-columns: minmax(0, 1fr);
  width: 100%;
  max-width: 1440px;
  margin: 0 auto;
}

.stage {
  position: relative;
  display: flex;
  min-height: 0;
  min-width: 0;
}

.board {
  display: block;
  margin: auto;
  border: 1px solid var(--panel-edge);
  border-radius: 14px;
  background: #0a1120;
  /* 交给 Pointer Events 处理，禁止浏览器把手势当成页面滚动/缩放 */
  touch-action: none;
  user-select: none;
}

.overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 12px;
  border-radius: 14px;
  background: rgba(6, 12, 22, 0.72);
  backdrop-filter: blur(3px);
  /* 遮罩本身不拦截手势：暂停/准备界面下仍能透过它拖动挡板 */
  pointer-events: none;
}

.overlay-card {
  max-width: min(420px, 100%);
  padding: 18px clamp(14px, 3vw, 24px);
  border: 1px solid var(--panel-edge);
  border-radius: var(--radius);
  background: var(--panel);
  text-align: center;
  /* 只有卡片本身接手势，其余区域透下去给画布 */
  pointer-events: auto;
}

.overlay-card h2 {
  margin: 0 0 8px;
  font-size: clamp(18px, 3.4vw, 26px);
}

.overlay-card p {
  margin: 0 0 14px;
  color: var(--text-muted);
  font-size: clamp(12px, 2.4vw, 15px);
}

.side {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  min-width: 0;
}

.stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px 10px;
  margin: 0;
}

.stats dt {
  color: var(--text-muted);
  font-size: 11px;
  letter-spacing: 1px;
}

.stats dd {
  margin: 0;
  font-size: clamp(15px, 2.6vw, 20px);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.stats .is-combo {
  color: var(--warn);
}

.controls {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}

/* 按钮文字不换行：窄侧栏里靠减内边距而不是折行来腾地方 */
.controls .btn {
  padding: 8px 10px;
  font-size: 14px;
  white-space: nowrap;
}

.history {
  padding: 10px 12px;
  border: 1px solid var(--panel-edge);
  border-radius: var(--radius);
  background: var(--bg-soft);
}

.history-title {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
}

.history-list {
  display: grid;
  gap: 5px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 12px;
}

.history-list li {
  display: grid;
  grid-template-columns: auto auto 1fr auto;
  align-items: baseline;
  gap: 6px;
  color: var(--text-muted);
}

.history-list b {
  color: var(--text);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.notice {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--warn);
  border-radius: var(--radius);
  color: var(--warn);
  font-size: 12px;
}

.guide {
  padding: 10px 12px;
  border: 1px solid var(--panel-edge);
  border-radius: var(--radius);
  background: var(--bg-soft);
  font-size: 13px;
}
.guide summary {
  cursor: pointer;
  font-weight: 600;
}

.legend {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px 12px;
  margin: 10px 0;
  padding: 0;
  list-style: none;
}

.legend li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.dot {
  display: grid;
  place-items: center;
  width: 26px;
  height: 20px;
  border-radius: 6px;
  color: #04101c;
  font-size: 12px;
  font-weight: 700;
}

.keys {
  margin: 0;
  font-size: 12px;
}

/* 桌面：右侧栏 + 主舞台 */
html[data-device="desktop"] .playfield {
  grid-template-columns: minmax(0, 1fr) 300px;
  align-items: stretch;
}

/* 平板横屏：窄一点的右侧栏 */
html[data-device="tablet"][data-orientation="landscape"] .playfield {
  grid-template-columns: minmax(0, 1fr) 240px;
}

/* 平板竖屏：侧栏移到舞台下方，统计排成一行 */
html[data-device="tablet"][data-orientation="portrait"] .playfield {
  grid-template-rows: minmax(0, 1fr) auto;
}

html[data-device="tablet"][data-orientation="portrait"] .stats {
  grid-template-columns: repeat(6, minmax(0, 1fr));
}

html[data-device="tablet"][data-orientation="portrait"] .side {
  flex-direction: row;
  flex-wrap: wrap;
  align-items: flex-start;
}

html[data-device="tablet"][data-orientation="portrait"] .stats {
  flex: 1 1 100%;
}

html[data-device="tablet"][data-orientation="portrait"] .controls {
  flex: 1;
}

html[data-device="tablet"][data-orientation="portrait"] .guide {
  display: none;
}

html[data-device="tablet"][data-orientation="portrait"] .history {
  flex: 1;
}

/* 手机屏高优先给画布：战绩只在看板与首页卡片上看 */
html[data-device="phone"] .history {
  display: none;
}

/* 平板横屏侧栏只有 240px，按钮排两列才不会折行 */
html[data-device="tablet"][data-orientation="landscape"] .controls {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

/* 手机：侧栏在下，按钮一行放满四个以省出画布高度，同时保证 48px 触控高度 */
html[data-device="phone"] .playfield {
  grid-template-rows: minmax(0, 1fr) auto;
  gap: 10px;
}

html[data-device="phone"] .btn {
  min-height: 48px;
}

html[data-device="phone"][data-orientation="landscape"] .playfield {
  grid-template-rows: minmax(0, 1fr) auto;
}

html[data-device="phone"][data-orientation="landscape"] .stats {
  grid-template-columns: repeat(6, minmax(0, 1fr));
}

html[data-device="phone"][data-orientation="landscape"] .controls {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

html[data-device="phone"][data-orientation="landscape"] .guide {
  display: none;
}

html[data-device="phone"][data-orientation="portrait"] .legend {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
</style>
