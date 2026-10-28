<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { RouterLink } from "vue-router";
import { Game, LINES_PER_LEVEL } from "./game.js";
import { COLS, ROWS, applyField, canvasBox, computeLayout } from "./layout.js";
import { PIECES, trimMatrix } from "./pieces.js";
import { bindInput } from "./input.js";
import { draw, setupCanvas } from "./renderer.js";
import { createAudio } from "./audio.js";
import { useGameStats, usePrefs, useStorageAvailable, useStore } from "../../composables/useStore.js";

const GAME_ID = "tetris";

const stageEl = ref(null);
const canvasEl = ref(null);
const hud = reactive({
  score: 0,
  best: 0,
  level: 1,
  lines: 0,
  nextId: null,
  holdId: null,
  holdUsed: false,
  danger: false,
});
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
  { key: "level", label: "关卡" },
  { key: "lines", label: "消行" },
];

/** 触屏动作按钮：手机上没有键盘，全靠这几个键 */
const padActions = [
  { key: "left", label: "←" },
  { key: "right", label: "→" },
  { key: "rotate", label: "旋转" },
  { key: "soft", label: "软降" },
  { key: "hard", label: "硬降" },
  { key: "hold", label: "暂存" },
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
    text: `棋盘恒定 ${COLS} 列 × ${ROWS} 行，三端难度一致。手机上左右拖动移动、轻点旋转、快速下甩硬降；PC 用方向键、空格硬降、C 暂存。`,
    button: "开始游戏",
  },
  paused: { title: "已暂停", text: "按 P / Esc 或点击「继续」恢复。", button: "继续" },
  over: { title: "游戏结束", text: () => `新方块出生位置被占，最终得分 ${game.score} 分、消 ${game.lines} 行。`, button: "再来一次" },
};

const overlay = computed(() => (OVERLAY[status.value] ? { ...OVERLAY[status.value] } : null));

/** 预览小格：把方块裁掉空白后铺成 CSS 网格，DOM 与画布面板共用同一份形状 */
function previewOf(id) {
  if (!id || !PIECES[id]) return { cols: 1, cells: [""] };
  const shape = trimMatrix(PIECES[id].shape);
  const cells = [];
  for (const row of shape) for (const value of row) cells.push(value ? PIECES[id].color : "");
  return { cols: shape[0].length, cells };
}

const nextPreview = computed(() => previewOf(hud.nextId));
const holdPreview = computed(() => previewOf(hud.holdId));

/**
 * 一局只在结束时落一次盘。挂载就记时间戳（这样中途直接离开也能算出用时），
 * 但只有真正开过局（started）才写记录，免得战绩里塞满 0 分的空局。
 */
function beginSession(started = false) {
  session = { startedAt: Date.now(), started };
}

function endSession(outcome) {
  if (!session) return;
  const { startedAt, started } = session;
  session = null;
  if (!started) return;
  storedBest = store.commitRun(GAME_ID, {
    score: game.score,
    level: game.level,
    ms: Math.max(0, Date.now() - startedAt),
    outcome,
  });
}

const OUTCOME = { over: "堆到顶了", won: "全部通关", quit: "中途退出" };

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

/** 舞台可用盒子：扣掉边框，保证画布永不溢出视口 */
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
  const signature = `${next.score}|${next.level}|${next.lines}|${next.nextId}|${next.holdId}|${next.holdUsed}|${next.danger}`;
  if (signature === statsCache) return;
  statsCache = signature;
  Object.assign(hud, next, { best: Math.max(storedBest, next.score) });
}

function syncStatus() {
  syncHud();
  if (game.status !== status.value && game.status === "over") {
    endSession("over");
  }
  status.value = game.status;
}

function primaryAction() {
  audio.unlock();
  switch (game.status) {
    case "ready":
      game.start();
      beginSession(true);
      break;
    case "paused":
      game.togglePause();
      break;
    case "over":
      game.reset();
      game.start();
      beginSession(true);
      break;
    default:
      break;
  }
  syncStatus();
}

function togglePause() {
  audio.unlock();
  if (game.status === "ready") {
    game.start();
    beginSession(true);
  } else if (game.status === "over") {
    primaryAction();
    return;
  } else {
    game.togglePause();
  }
  syncStatus();
}

function restart() {
  audio.unlock();
  endSession("quit");
  game.reset();
  game.start();
  beginSession(true);
  syncStatus();
}

function toggleSound() {
  audio.unlock();
  muted.value = !muted.value;
  audio.setMuted(muted.value);
  store.setPref("muted", muted.value);
}

/** 触屏按钮与手势共用同一条队列，顺序才不会打架 */
function act(name) {
  audio.unlock();
  game.enqueue(name);
}

function frame(now) {
  const delta = Math.min(0.05, (now - last) / 1000);
  last = now;

  game.update(delta);
  syncStatus();
  if (ctx) draw(ctx, game, now / 1000);
  rafId = requestAnimationFrame(frame);
}

function onRotate() {
  // 旋转后先让布局稳定一帧再重排，否则拿到的是过渡中的容器尺寸
  setTimeout(relayout, 120);
}

onMounted(() => {
  storedBest = profile.value.best;
  muted.value = prefs.value.muted === true;
  audio = createAudio();
  audio.setMuted(muted.value);
  game = new Game({ onSound: (name) => audio.play(name) });
  // 组件挂载即记录开局时间戳：中途直接离开页面也能算出这局玩了多久
  beginSession();
  input = bindInput({
    canvas: canvasEl.value,
    getStatus: () => game.status,
    enqueue: (action) => game.enqueue(action),
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
    window.tetris = game;
    window.tetrisLayout = () => layout;
    window.tetrisRelayout = relayout;
  }
});

onBeforeUnmount(() => {
  // 仍在 playing/paused 就离开页面：按中途退出落一盘（没真正开局则不落盘）
  endSession("quit");
  cancelAnimationFrame(rafId);
  observer?.disconnect();
  window.removeEventListener("resize", relayout);
  window.removeEventListener("orientationchange", onRotate);
  input?.unbind();
  audio?.dispose?.();
  if (import.meta.env.DEV) {
    delete window.tetris;
    delete window.tetrisLayout;
    delete window.tetrisRelayout;
  }
});
</script>

<template>
  <div class="playfield">
    <div ref="stageEl" class="stage">
      <canvas ref="canvasEl" class="board" aria-label="方块堆叠游戏画面" />
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
          <dd :class="{ 'is-danger': item.key === 'lines' && hud.danger }">
            {{ item.key === "level" ? `${hud.level}（每 ${LINES_PER_LEVEL} 行 +1）` : hud[item.key] }}
          </dd>
        </template>
      </dl>

      <div class="previews">
        <div class="preview">
          <span class="preview-label">下一块</span>
          <span class="mini" :style="{ gridTemplateColumns: `repeat(${nextPreview.cols}, 1fr)` }">
            <i
              v-for="(color, i) in nextPreview.cells"
              :key="`n${i}`"
              :style="{ background: color || 'transparent' }"
            />
          </span>
        </div>
        <div class="preview">
          <span class="preview-label">暂存{{ hud.holdUsed ? "（本块已用）" : "" }}</span>
          <span class="mini" :class="{ 'is-spent': hud.holdUsed }" :style="{ gridTemplateColumns: `repeat(${holdPreview.cols}, 1fr)` }">
            <i
              v-for="(color, i) in holdPreview.cells"
              :key="`h${i}`"
              :style="{ background: color || 'transparent' }"
            />
          </span>
        </div>
      </div>

      <div class="controls">
        <button class="btn btn--primary" @click="primaryAction">
          {{ status === "ready" ? "开始" : status === "paused" ? "继续" : "重来" }}
        </button>
        <button class="btn" @click="togglePause">暂停</button>
        <button class="btn" @click="restart">重开</button>
        <button class="btn" @click="toggleSound">{{ soundLabel }}</button>
        <RouterLink class="btn exit" :to="{ name: 'home' }">退出</RouterLink>
      </div>

      <div class="pad">
        <button v-for="item in padActions" :key="item.key" class="btn pad-btn" @click="act(item.key)">
          {{ item.label }}
        </button>
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
        <summary>玩法与操作</summary>
        <ul class="legend">
          <li v-for="item in stats" :key="`g-${item.key}`">
            <span>{{ item.label }}</span>
            <span class="muted">{{ item.key === "score" ? "消行 + 软降/硬降加分" : "—" }}</span>
          </li>
        </ul>
        <p class="keys muted">
          <kbd>←</kbd><kbd>→</kbd> 移动 · <kbd>↓</kbd> 软降（每格 1 分）· <kbd>↑</kbd>/<kbd>X</kbd> 旋转 ·
          <kbd>Z</kbd> 反向旋转 · <kbd>空格</kbd> 硬降（每格 2 分）· <kbd>C</kbd> 暂存 · <kbd>P</kbd> 暂停 ·
          <kbd>R</kbd> 重开 · <kbd>M</kbd> 静音。消 1/2/3/4 行得 100/300/500/800 × 关卡。
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
  /* 遮罩本身不拦截手势：暂停/准备界面下仍能透过它操作棋盘 */
  pointer-events: none;
}

.overlay-card {
  max-width: min(420px, 100%);
  padding: 18px clamp(14px, 3vw, 24px);
  border: 1px solid var(--panel-edge);
  border-radius: var(--radius);
  background: var(--panel);
  text-align: center;
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
  grid-template-columns: repeat(4, minmax(0, 1fr));
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

.stats .is-danger {
  color: var(--danger);
}

.previews {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.preview {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border: 1px solid var(--panel-edge);
  border-radius: var(--radius);
  background: var(--bg-soft);
}

.preview-label {
  color: var(--text-muted);
  font-size: 11px;
  letter-spacing: 1px;
}

/* 预览小格：用 CSS 网格铺方块形状，跟画布面板同一份数据 */
.mini {
  display: grid;
  gap: 2px;
  justify-content: start;
}

.mini i {
  display: block;
  width: clamp(8px, 1.4vw, 12px);
  height: clamp(8px, 1.4vw, 12px);
  border-radius: 2px;
}

.mini.is-spent {
  filter: grayscale(0.6);
  opacity: 0.6;
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

/* 出口只给手机端的全屏层用（页头的「← 游戏厅」会被盖住），桌面/平板照常收起 */
.exit {
  display: none;
}

.pad {
  /* PC 默认收起，触屏设备才显示；纯键盘玩家用快捷键即可 */
  display: none;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.pad-btn {
  padding: 8px 6px;
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
  gap: 6px;
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

.keys {
  margin: 0;
  font-size: 12px;
}

/* 桌面：主舞台 + 300px 侧栏，画布按场地长宽比铺满，横向余量在画布里画预览面板 */
html[data-device="desktop"] .playfield {
  grid-template-columns: minmax(0, 1fr) 300px;
  align-items: stretch;
}

/* 平板横屏：窄一点的右侧栏，按钮排两列才不会折行 */
html[data-device="tablet"][data-orientation="landscape"] .playfield {
  grid-template-columns: minmax(0, 1fr) 240px;
}

html[data-device="tablet"][data-orientation="landscape"] .controls {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

html[data-device="tablet"] .pad {
  display: grid;
}

/* 平板竖屏：侧栏移到舞台下方，统计排成一行，隐藏说明区 */
html[data-device="tablet"][data-orientation="portrait"] .playfield {
  grid-template-rows: minmax(0, 1fr) auto;
}

html[data-device="tablet"][data-orientation="portrait"] .side {
  flex-direction: row;
  flex-wrap: wrap;
  align-items: flex-start;
}

html[data-device="tablet"][data-orientation="portrait"] .stats {
  grid-template-columns: repeat(4, minmax(0, 1fr));
  flex: 1 1 100%;
}

html[data-device="tablet"][data-orientation="portrait"] .controls {
  flex: 1;
}

html[data-device="tablet"][data-orientation="portrait"] .previews {
  flex: 1;
}

html[data-device="tablet"][data-orientation="portrait"] .pad {
  flex: 1 1 100%;
  grid-template-columns: repeat(6, minmax(0, 1fr));
}

html[data-device="tablet"][data-orientation="portrait"] .history {
  flex: 1;
}

html[data-device="tablet"][data-orientation="portrait"] .guide {
  display: none;
}

/* 手机端不在此处写规则：全屏层与压缩后的控制带由 src/styles/playfield.css 统一负责，
   组件里再写一条 html[data-device="phone"] .X 会因为 scoped 属性把特异度顶到同一档，
   后加载的异步 chunk 就会盖住公共层（上一版手机端画布被侧栏挤到只剩一条的病根）。 */
</style>
