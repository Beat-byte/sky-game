<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { Snake } from "./game.js";
import { MAX_TIER, SPEEDS } from "./grid.js";
import { snakeLayout } from "./layout.js";
import { bindInput } from "./input.js";
import { draw, setupCanvas } from "./renderer.js";
import { createAudio } from "./audio.js";
import { useGameStats, usePrefs, useStorageAvailable, useStore } from "../../composables/useStore.js";

const GAME_ID = "snake";

const stageEl = ref(null);
const canvasEl = ref(null);
const hud = reactive({ score: 0, best: 0, length: 3, foods: 0, tier: 1, seconds: 0 });
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
  { key: "length", label: "蛇长" },
  { key: "foods", label: "食物" },
  { key: "tier", label: "速度档" },
  { key: "seconds", label: "用时" },
];

let game = null;
let audio = null;
let input = null;
let ctx = null;
let observer = null;
let rafId = 0;
let last = 0;
let layout = null;
let css = { width: 1, height: 1 };
let statsCache = "";
let storedBest = 0;
let session = null;

const OVERLAY = {
  ready: {
    title: "准备开始",
    text: "四向滑动或方向键转向，轻点/空格开始。吃到食物变长并提速，撞墙或咬到自己就结束。",
    button: "开始游戏",
  },
  paused: { title: "已暂停", text: "按 P / Esc 或点击「继续」恢复。", button: "继续" },
  over: {
    title: "游戏结束",
    text: () =>
      `${game.death === "wall" ? "撞到了墙" : "咬到了自己"}，本局 ${game.score} 分、${game.snake.length} 格长、${game.foods} 个食物。`,
    button: "再来一次",
  },
  won: { title: "棋盘被占满", text: () => `神了！${game.score} 分、${game.snake.length} 格长。`, button: "再来一次" },
};

const overlay = computed(() => (OVERLAY[status.value] ? { ...OVERLAY[status.value] } : null));

/** 一局只在结束时落一次盘：通关、撞死、中途退出都留档 */
function beginSession() {
  session = { startedAt: Date.now() };
}

function endSession(outcome) {
  if (!session) return;
  const ms = Math.max(0, Date.now() - session.startedAt);
  session = null;
  storedBest = store.commitRun(GAME_ID, { score: game.score, level: game.tier + 1, ms, outcome });
}

const OUTCOME = { over: "撞死收场", won: "占满棋盘", quit: "中途退出" };

function runLabel(run) {
  if (run.legacy) return "旧版最高分";
  return OUTCOME[run.outcome] ?? "中途退出";
}

function formatMs(ms) {
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  return minutes > 0 ? `${minutes} 分 ${String(total % 60).padStart(2, "0")} 秒` : `${total} 秒`;
}

function formatSeconds(seconds) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatAt(at) {
  const d = new Date(at);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function availableBox() {
  const rect = stageEl.value.getBoundingClientRect();
  return { width: Math.max(1, rect.width - 2), height: Math.max(1, rect.height - 2) };
}

function relayout() {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  layout = snakeLayout(viewport, availableBox());
  css = layout.css;
  game.resize(layout.grid);
  ctx = setupCanvas(canvasEl.value, css);
}

function syncHud() {
  const next = game.hud();
  const signature = `${next.score}|${next.length}|${next.foods}|${next.tier}|${next.seconds}`;
  if (signature === statsCache) return;
  statsCache = signature;
  hud.score = next.score;
  hud.best = Math.max(storedBest, next.score);
  hud.length = next.length;
  hud.foods = next.foods;
  hud.tier = next.tier + 1;
  hud.seconds = formatSeconds(next.seconds);
}

function syncStatus() {
  syncHud();
  if (game.status !== status.value && (game.status === "over" || game.status === "won")) {
    endSession(game.status);
  }
  status.value = game.status;
}

function startRun() {
  game.reset().start();
  beginSession();
  syncStatus();
}

function primaryAction() {
  audio.unlock();
  if (game.status === "ready") {
    game.start();
    beginSession();
  } else if (game.status === "paused") {
    game.togglePause();
  } else if (game.status === "over" || game.status === "won") {
    startRun();
    return;
  }
  syncStatus();
}

function togglePause() {
  audio.unlock();
  if (game.status === "ready") {
    game.start();
    beginSession();
  } else {
    game.togglePause();
  }
  syncStatus();
}

function restart() {
  audio.unlock();
  // 中途重开也要给上一局留档，否则当局成绩直接丢失
  endSession("quit");
  startRun();
}

function turn(dir) {
  if (game.status === "ready") {
    game.start();
    beginSession();
    syncStatus();
  }
  game.enqueue(dir);
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
  game.update(delta);
  syncStatus();
  if (ctx) draw(ctx, game, css, now);
  rafId = requestAnimationFrame(frame);
}

onMounted(() => {
  storedBest = profile.value.best;
  muted.value = prefs.value.muted === true;
  audio = createAudio();
  audio.setMuted(muted.value);
  game = new Snake({
    orientation: window.innerWidth > window.innerHeight ? "landscape" : "portrait",
    onSound: (name) => audio.play(name),
  });
  input = bindInput({
    canvas: canvasEl.value,
    onDir: (dir) => {
      audio.unlock();
      if (dir) turn(dir);
    },
    onAction: (name) => {
      audio.unlock();
      if (name === "primary") primaryAction();
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
    window.snake = game;
    window.snakeLayout = () => layout;
    window.snakeRelayout = relayout;
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
    delete window.snake;
    delete window.snakeLayout;
    delete window.snakeRelayout;
  }
});
</script>

<template>
  <div class="playfield">
    <div ref="stageEl" class="stage">
      <canvas ref="canvasEl" class="board" aria-label="像素贪吃蛇游戏画面" />
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
          <dd>{{ item.key === "tier" ? `${hud.tier} / ${MAX_TIER + 1}（${SPEEDS[hud.tier - 1]} 格每秒）` : hud[item.key] }}</dd>
        </template>
      </dl>

      <div class="dpad" role="group" aria-label="方向">
        <span />
        <button class="btn" @click="turn('up')" aria-label="上">↑</button>
        <span />
        <button class="btn" @click="turn('left')" aria-label="左">←</button>
        <button class="btn btn--center" @click="togglePause">{{ status === 'playing' ? '暂停' : '开始' }}</button>
        <button class="btn" @click="turn('right')" aria-label="右">→</button>
        <span />
        <button class="btn" @click="turn('down')" aria-label="下">↓</button>
        <span />
      </div>

      <div class="controls">
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
            <span>{{ run.legacy ? "—" : `${run.level} 档` }}</span>
            <span>{{ run.ms ? formatMs(run.ms) : "—" }}</span>
            <span class="muted">{{ runLabel(run) }}</span>
            <time class="muted">{{ formatAt(run.at) }}</time>
          </li>
        </ol>
        <p v-else class="muted">还没有战绩，撞死或中途退出都会留档。</p>
      </section>

      <details class="guide">
        <summary>计分与提速</summary>
        <p class="muted">
          每个食物 10 分起步，每吃 4 个升一档、基础分再加 5；速度从每秒 4.2 格一路升到 14 格，共 8 档。
          竖屏 13×20、横屏 20×13，格子总数恒为 260，所以三端难度完全一样。
        </p>
        <p class="keys muted">
          <kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd> 或 <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> 转向 ·
          <kbd>空格</kbd> 开始 · <kbd>P</kbd> 暂停 · <kbd>R</kbd> 重开 · <kbd>M</kbd> 静音；触屏四向滑动转向、轻点开始。
        </p>
      </details>
    </aside>
  </div>
</template>

<style scoped>
.playfield {
  display: grid;
  flex: 1;
  min-height: 0;
  gap: var(--gap);
  grid-template-rows: minmax(0, 1fr) auto;
}

.stage {
  position: relative;
  display: grid;
  place-items: center;
  min-height: 0;
  padding: 1px;
  border: 1px solid var(--panel-edge);
  border-radius: var(--radius);
  background: var(--panel);
}

.board {
  display: block;
  border-radius: 10px;
  touch-action: none;
}

.overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  padding: var(--gap);
  /* 遮罩本体不吃手势，只有卡片按钮可点，避免挡住画布上的滑动 */
  pointer-events: none;
}

.overlay-card {
  max-width: 380px;
  padding: 18px 20px;
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  background: rgba(11, 18, 32, 0.92);
  text-align: center;
  pointer-events: auto;
}

.overlay-card h2 {
  margin: 0 0 8px;
  font-size: 20px;
}

.overlay-card p {
  margin: 0 0 14px;
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1.6;
}

.side {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}

.stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px 10px;
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--panel-edge);
  border-radius: var(--radius);
  background: var(--panel);
  font-size: 13px;
}

.stats dt {
  color: var(--text-muted);
  font-size: 11px;
}

.stats dd {
  margin: 0;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.dpad {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
}

.dpad .btn {
  padding: 10px 0;
  font-size: 16px;
}

.dpad .btn--center {
  font-size: 13px;
}

.controls {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.controls .btn {
  padding: 8px 10px;
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

.guide p {
  margin: 10px 0 0;
  font-size: 12px;
  line-height: 1.7;
}

.keys {
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

/* 平板竖屏：侧栏移到画布下方，统计排成一行，方向盘与按钮并排 */
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

html[data-device="tablet"][data-orientation="portrait"] .dpad {
  flex: 1 1 180px;
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

/* 平板横屏侧栏只有 240px，按钮排两列才不会折行 */
html[data-device="tablet"][data-orientation="landscape"] .controls {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

/* 手机：屏高优先给画布，战绩与说明收起 */
html[data-device="phone"] .playfield {
  grid-template-rows: minmax(0, 1fr) auto;
  gap: 10px;
}

html[data-device="phone"] .btn {
  min-height: 48px;
}

html[data-device="phone"] .dpad .btn {
  min-height: 52px;
}

html[data-device="phone"][data-orientation="landscape"] .stats {
  grid-template-columns: repeat(6, minmax(0, 1fr));
}

html[data-device="phone"] .history,
html[data-device="phone"] .guide {
  display: none;
}
</style>
