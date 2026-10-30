<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { Airbattle } from "./game.js";
import { MAX_WEAPON, SHIP } from "./field.js";
import { LEVELS } from "./waves.js";
import { airbattleLayout } from "./layout.js";
import { bindInput } from "./input.js";
import { draw, setupCanvas } from "./renderer.js";
import { createAudio } from "./audio.js";
import { useGameStats, usePrefs, useStorageAvailable, useStore } from "../../composables/useStore.js";

const GAME_ID = "airbattle";

const stageEl = ref(null);
const canvasEl = ref(null);
const rootEl = ref(null);
const hud = reactive({
  score: 0,
  best: 0,
  level: 1,
  hp: SHIP.hpStart,
  bombs: SHIP.bombsStart,
  weapon: 1,
  remaining: 0,
  seconds: "0:00",
});
const banner = ref(null);
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
  { key: "hp", label: "生命" },
  { key: "bombs", label: "炸弹" },
  { key: "weapon", label: "火力" },
  { key: "remaining", label: "本关剩余" },
  { key: "seconds", label: "用时" },
];

let game = null;
let audio = null;
let input = null;
let ctx = null;
let observer = null;
let rafId = 0;
let timerId = 0;
let settleLayoutId = 0;
let ticker = null;
let last = 0;
let lastPump = 0;
let layout = null;
let css = { width: 1, height: 1 };
let statsCache = "";
let storedBest = 0;
let session = null;

const OVERLAY = {
  ready: {
    title: "准备起飞",
    text: "在画面任意处按住拖动就能开飞机，松手停在原地；飞机自动连射，捡到 ▲ 升火力、+ 回血、● 补炸弹。方向键也能飞，B / Shift 投弹。",
    button: "开始游戏",
  },
  paused: { title: "已暂停", text: "按 P / Esc 或点「继续」恢复。", button: "继续" },
  over: {
    title: "座机坠落",
    text: () =>
      `${game.death === "ram" ? "被撞中了" : "被弹幕击中了"}，本局 ${game.score} 分、走完 ${game.level + 1} / ${LEVELS.length} 关、击坠 ${game.kills} 架。`,
    button: "再来一次",
  },
  won: {
    title: "全部通关",
    text: () =>
      `母舰被打下来了：${game.score} 分（含剩余生命与炸弹奖励 ${game.bonus} 分）、击坠 ${game.kills} 架、最高连击 ${game.maxCombo}。`,
    button: "再来一次",
  },
};

const overlay = computed(() => (OVERLAY[status.value] ? { ...OVERLAY[status.value] } : null));

/** 一局只在结束时落一次盘：通关、坠落、中途退出都留档 */
function beginSession() {
  session = { startedAt: Date.now() };
}

function endSession(outcome) {
  if (!session) return;
  const ms = Math.max(0, Date.now() - session.startedAt);
  session = null;
  storedBest = store.commitRun(GAME_ID, { score: game.score, level: game.level + 1, ms, outcome });
}

const OUTCOME = { over: "座机坠落", won: "全部通关", quit: "中途退出" };

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
  layout = airbattleLayout(viewport, availableBox());
  css = layout.css;
  game.resize({ device: layout.device, orientation: layout.orientation });
  ctx = setupCanvas(canvasEl.value, css, layout.device);
}

function syncHud() {
  const next = game.hud();
  const signature = `${next.score}|${next.level}|${next.hp}|${next.bombs}|${next.weapon}|${next.remaining}|${next.seconds}`;
  if (signature === statsCache) return;
  statsCache = signature;
  hud.score = next.score;
  hud.best = Math.max(storedBest, next.score);
  hud.level = `${next.level} / ${next.levels}`;
  hud.hp = `${next.hp} / ${next.hpMax}`;
  hud.bombs = `${next.bombs} / ${next.bombsMax}`;
  hud.weapon = `${next.weapon} / ${MAX_WEAPON}`;
  hud.remaining = next.remaining;
  hud.seconds = formatSeconds(next.seconds);
  banner.value = next.banner;
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
  } else if (game.status === "playing" || game.status === "paused") {
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

function dropBomb() {
  audio.unlock();
  if (game.status === "ready") {
    game.start();
    beginSession();
  }
  game.bomb();
  syncStatus();
}

/** 键盘轴的归零由输入层负责；这里只保证引擎收到 (0,0) */
function steer(x, y) {
  game.setAxis(x, y);
}

function dragBy(dxUnits, dyUnits) {
  audio.unlock();
  if (game.status === "ready") {
    game.start();
    beginSession();
    syncStatus();
  }
  game.drag(dxUnits, dyUnits);
}

function toggleSound() {
  audio.unlock();
  muted.value = !muted.value;
  audio.setMuted(muted.value);
  store.setPref("muted", muted.value);
}

function jumpLevel(index) {
  const target = Math.max(0, Math.min(LEVELS.length - 1, Number(index) || 0));
  if (game.status === "over" || game.status === "won") startRun();
  else if (game.status === "ready") {
    game.start();
    beginSession();
  }
  game.jumpTo(target);
  syncStatus();
}

function render(ts) {
  if (!ctx || !layout) return;
  draw(ctx, game, layout, ts);
}

function pump(ts) {
  if (!last) last = ts;
  // 切回标签或 watchdog 补帧时 dt 会很大：夹到 0.05 秒，宁可慢放也不让飞机一帧穿过弹幕
  const dt = Math.max(0, Math.min(0.05, (ts - last) / 1000));
  last = ts;
  game.update(dt);
  syncStatus();
  render(ts);
}

function frame(ts) {
  lastPump = ts;
  pump(ts);
  rafId = requestAnimationFrame(frame);
}

/** rAF 在不透明的页面里一帧不发，setInterval 又被节流到 ~1 秒；这条看门狗只兜住"两边都哑"的情况 */
function watchdog() {
  const now = performance.now();
  if (now - lastPump < 250) return;
  lastPump = now;
  pump(now);
}

/** 手动喂帧：hidden 页面里三条驱动源都可能不响，验证只能靠这条入口 */
function advance(frames, ms = 1000 / 60) {
  const total = Math.max(0, Number(frames) || 0);
  for (let i = 0; i < total; i += 1) {
    game.update(ms / 1000);
    syncStatus();
  }
  return { status: game.status, time: game.timeSec, score: game.score, enemies: game.enemies.length };
}

onMounted(() => {
  storedBest = profile.value.best;
  muted.value = prefs.value.muted === true;
  audio = createAudio();
  audio.setMuted(muted.value);
  game = new Airbattle({
    device: window.innerWidth < 500 ? "phone" : "desktop",
    orientation: window.innerWidth > window.innerHeight ? "landscape" : "portrait",
    onSound: (name) => audio.play(name),
  });

  relayout();
  syncStatus();

  input = bindInput({
    canvas: canvasEl.value,
    getUnit: () => layout?.unit ?? 1,
    onDrag: dragBy,
    onAxis: steer,
    onAction: (name) => {
      audio.unlock();
      if (name === "primary") primaryAction();
      else if (name === "bomb") dropBomb();
      else if (name === "pause") togglePause();
      else if (name === "restart") restart();
      else if (name === "mute") toggleSound();
    },
  });

  observer = new ResizeObserver(() => relayout());
  observer.observe(stageEl.value);
  window.addEventListener("orientationchange", onRotate);
  window.addEventListener("resize", relayout);
  document.addEventListener("visibilitychange", onVisibility);

  timerId = setInterval(watchdog, 100);
  /*
   * Worker 心跳：内置预览与后台标签里 rAF 完全不发，主线程定时器还被节流。
   * 三条驱动源共用 pump 与同一个 last 游标，谁先到都只按真实流逝推进。
   */
  try {
    ticker = new Worker(new URL("./tick.js", import.meta.url), { type: "module" });
    ticker.onmessage = () => pump(performance.now());
  } catch {
    ticker = null;
  }

  last = performance.now();
  lastPump = last;
  rafId = requestAnimationFrame(frame);
  // 手机控制带里的统计条可能在首帧后才撑开高度，补一次重排
  settleLayoutId = setTimeout(relayout, 60);

  if (import.meta.env.DEV) {
    window.airbattle = game;
    window.airbattleLayout = () => layout;
    window.airbattleRelayout = relayout;
    window.airbattleAdvance = advance;
    window.airbattleMove = (dx, dy) => {
      dragBy(Number(dx) || 0, Number(dy) || 0);
      return { x: game.ship.x, y: game.ship.y, tx: game.target.x, ty: game.target.y };
    };
    window.airbattleBomb = () => {
      dropBomb();
      return { bombs: game.ship.bombs, enemies: game.enemies.length, shots: game.eshots.length };
    };
    window.airbattleLevel = (index) => jumpLevel(Number(index) || 0);
    /** 逐按钮命中 + 画布是否被浮层吃掉：与另两款同一套验收口径 */
    window.airbattleBoxes = () => {
      const root = rootEl.value;
      const rect = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top) };
      };
      const hits = [];
      for (const el of root?.querySelectorAll(".controls .btn") ?? []) {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue; // 桌面/平板档位下 .exit 是 display:none，不计入命中检查
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        hits.push({ label: el.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height), clickable: hit === el || el.contains(hit) });
      }
      const side = root?.querySelector(".side");
      return {
        viewport: { w: window.innerWidth, h: window.innerHeight },
        device: document.documentElement.dataset.device,
        orientation: document.documentElement.dataset.orientation,
        unit: layout ? Number(layout.unit.toFixed(3)) : null,
        view: layout ? { ...layout.view } : null,
        full: rect(root),
        stage: rect(root?.querySelector(".stage")),
        canvas: rect(root?.querySelector(".board")),
        side: rect(side),
        controls: rect(root?.querySelector(".controls")),
        /** 控制带是否溢出屏幕：横屏带内排布一改就可能把最下面一排按键顶出去 */
        sideScroll: side ? { scroll: Math.round(side.scrollHeight), client: Math.round(side.clientHeight) } : null,
        hits,
        bareCanvasHit: (() => {
          const el = canvasEl.value;
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const probe = document.elementFromPoint(r.left + r.width * 0.5, r.top + r.height * 0.35);
          return probe === el || el.contains(probe);
        })(),
      };
    };
  }
});

function onRotate() {
  setTimeout(relayout, 120);
}

function onVisibility() {
  if (document.visibilityState !== "visible") return;
  // 页面重新可见时 rAF 已经重新开跑，把时间游标清零，避免把后台那段时间一次性补进弹道
  last = 0;
  lastPump = performance.now();
}

/** 心跳只在局内需要：结算与暂停画面挂 60 Hz 的 Worker 是白烧电 */
watch(status, (value) => {
  ticker?.postMessage(value === "playing" ? "start" : "stop");
});

/** 覆盖层出现后舞台内容高度会变（手机档位下控制带也跟着变），下一拍重量一次 */
watch(status, () => {
  nextTick(() => relayout());
});

onBeforeUnmount(() => {
  endSession("quit");
  cancelAnimationFrame(rafId);
  clearInterval(timerId);
  clearTimeout(settleLayoutId);
  ticker?.terminate();
  observer?.disconnect();
  window.removeEventListener("resize", relayout);
  window.removeEventListener("orientationchange", onRotate);
  document.removeEventListener("visibilitychange", onVisibility);
  // 卸载前把键盘轴归零，避免下一次进来还带着上次的"按住"
  steer(0, 0);
  input?.unbind();
  audio?.dispose?.();
  if (import.meta.env.DEV) {
    delete window.airbattle;
    delete window.airbattleLayout;
    delete window.airbattleRelayout;
    delete window.airbattleAdvance;
    delete window.airbattleMove;
    delete window.airbattleBomb;
    delete window.airbattleLevel;
    delete window.airbattleBoxes;
  }
});
</script>

<template>
  <div ref="rootEl" class="playfield">
    <div ref="stageEl" class="stage">
      <canvas ref="canvasEl" class="board" aria-label="飞机大战游戏画面" />
      <p v-if="banner && status === 'playing'" class="banner">{{ banner }}</p>
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
          <dd>{{ hud[item.key] }}</dd>
        </template>
      </dl>

      <div class="controls">
        <button class="btn" @click="dropBomb">投弹</button>
        <button class="btn" @click="togglePause">{{ status === "playing" ? "暂停" : "开始" }}</button>
        <button class="btn" @click="restart">重开</button>
        <button class="btn" @click="toggleSound">{{ soundLabel }}</button>
        <RouterLink class="btn exit" :to="{ name: 'home' }">退出</RouterLink>
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
        <p v-else class="muted">还没有战绩，坠落与中途退出都会留档。</p>
      </section>

      <details class="guide">
        <summary>编成与计分</summary>
        <p class="muted">
          六关手写编成：{{ LEVELS.map((level) => level.name).join(" → ") }}。第 6 关的母舰有 64 点血，
          击坠它才算通关。敌机分值 100 / 140 / 220 / 320 / 520 / 4000，连击每阶 +2%（最高 20 阶）；
          通关另加剩余生命 800、剩余炸弹 400。
        </p>
        <p class="muted">
          空域恒为 9×16 单位：三端只有每单位像素不同，敌机穿越时间与弹幕密度处处一致。
          火力 4 档（{{ MAX_WEAPON }} 档上限），受伤后有 {{ SHIP.invuln }} 秒无敌。
        </p>
        <p class="keys muted">
          <kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd> 或 <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> 飞行 ·
          <kbd>B</kbd>/<kbd>Shift</kbd> 投弹 · <kbd>空格</kbd> 开始 · <kbd>P</kbd> 暂停 · <kbd>R</kbd> 重开 ·
          <kbd>M</kbd> 静音；触屏在画面里按住拖动即可，轻点开始。
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

/* 关卡提示只盖住画布上方一条，不吃手势：拖动飞行与提示互不干扰 */
.banner {
  position: absolute;
  top: 12%;
  left: 0;
  right: 0;
  margin: 0;
  text-align: center;
  color: #ffe9a8;
  font-size: 15px;
  letter-spacing: 1px;
  pointer-events: none;
}

.overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  padding: var(--gap);
  /* 遮罩本体不吃手势，只有卡片按钮可点 */
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
  grid-template-columns: repeat(4, minmax(0, 1fr));
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

.controls {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}

.controls .btn {
  padding: 8px 10px;
  white-space: nowrap;
}

/* 出口只给手机端的全屏层用（页头的「← 游戏厅」会被盖住），桌面/平板照常收起 */
.exit {
  display: none;
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

/* 平板横屏：窄一点的右侧栏，按键排两列 */
html[data-device="tablet"][data-orientation="landscape"] .playfield {
  grid-template-columns: minmax(0, 1fr) 240px;
}

html[data-device="tablet"][data-orientation="landscape"] .controls {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

/* 平板竖屏：侧栏移到画布下方，统计排成一行 */
html[data-device="tablet"][data-orientation="portrait"] .playfield {
  grid-template-rows: minmax(0, 1fr) auto;
}

html[data-device="tablet"][data-orientation="portrait"] .stats {
  grid-template-columns: repeat(8, minmax(0, 1fr));
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
  flex: 1 1 260px;
}

html[data-device="tablet"][data-orientation="portrait"] .guide {
  display: none;
}

html[data-device="tablet"][data-orientation="portrait"] .history {
  flex: 1;
}

/* 手机端不在此处写规则：全屏层与压缩后的控制带由 src/styles/playfield.css 统一负责，
   组件里再写一条 html[data-device="phone"] .X 会因为 scoped 属性把特异度顶到同一档，
   后加载的异步 chunk 就会盖住公共层（上一版手机端画布只剩 194 px 宽的病根）。 */
</style>
