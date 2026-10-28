<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { Birds } from "./game.js";
import { BIRDS, LEVELS, SLING } from "./levels.js";
import { GRAB_RADIUS, aimFromPull, birdsLayout, cameraFor, worldToScreen } from "./layout.js";
import { bindInput } from "./input.js";
import { draw, setupCanvas } from "./renderer.js";
import { createAudio } from "./audio.js";
import { useGameSave, useGameStats, usePrefs, useStorageAvailable, useStore } from "../../composables/useStore.js";

const GAME_ID = "birds";

/**
 * 跨局进度：解锁到第几关、每关最好星数与最高分。
 * 必须是模块级常量 —— useGameSave 把它放在 computed 里参与读档，写字面量会让缓存失效。
 */
const DEFAULT_SAVE = { unlocked: 1, stars: {}, best: 0 };

const stageEl = ref(null);
const canvasEl = ref(null);
const rootEl = ref(null);
const hud = reactive({ score: 0, best: 0, level: 1, levelName: "", pigs: 0, left: 0, power: 0, angle: 45, stars: 0, seconds: 0, message: "", hint: "" });
const status = ref("ready");
const phase = ref("aim");
/* 首帧渲染早于 onMounted：game 还是个普通 null，computed 一旦在 render 期读它就崩，
   而且它不是响应式的，光靠 status 变化不会重算。booted 这条 ref 就是给 overlay 用的依赖。 */
const booted = ref(false);
const muted = ref(false);
const queue = ref([]);
const store = useStore();
const profile = useGameStats(GAME_ID);
const prefs = usePrefs();
const storageOk = useStorageAvailable();
const { save, write: writeSave } = useGameSave(GAME_ID, DEFAULT_SAVE);

const soundLabel = computed(() => (muted.value ? "已静音" : "静音"));
/* 控制带这一枚按钮要按状态换字：ready 显示「继续」会让玩家以为局已经在跑 */
const pauseLabel = computed(() => (status.value === "playing" ? "暂停" : status.value === "paused" ? "继续" : status.value === "ready" ? "开始" : "重开"));
const levelCount = LEVELS.length;
/* 必须是 computed：通关后 save 里的星数与解锁会变，写死成常量选关面板就永远停在进入页面那一刻 */
const levelChoices = computed(() =>
  LEVELS.map((lv, i) => ({
    index: i,
    id: lv.id,
    name: lv.name,
    stars: save.value.stars?.[lv.id] ?? 0,
    open: i + 1 <= (save.value.unlocked ?? 1),
  }))
);

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
let cam = { x: 0, y: 0 };
let session = null;
let statsCache = "";
let storedBest = 0;

const OVERLAY = {
  ready: {
    title: () => game.level.name,
    text: () => game.level.hint,
    button: "开始射击",
  },
  paused: { title: "已暂停", text: () => "按 P / Esc 或点「继续」恢复。", button: "继续" },
  won: {
    title: () => `${game.level.name} 通关 · ${game.stars} 星`,
    text: () => `${game.score} 分。${game.message}`,
    button: () => (game.index >= levelCount - 1 ? "再来一遍" : "下一关"),
  },
  over: {
    title: () => "鸟不够了",
    text: () => `${game.message}，本局 ${game.score} 分。`,
    button: "重试本关",
  },
};

const overlay = computed(() => {
  if (!booted.value) return null;
  const entry = OVERLAY[status.value];
  if (!entry) return null;
  return {
    title: typeof entry.title === "function" ? entry.title() : entry.title,
    text: typeof entry.text === "function" ? entry.text() : entry.text,
    button: typeof entry.button === "function" ? entry.button() : entry.button,
  };
});

const showLevels = computed(() => status.value === "ready" || status.value === "won" || status.value === "over");

const OUTCOME = { won: "通关", over: "鸟用完", quit: "中途退出" };

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

function starsMark(n) {
  return "★".repeat(n) + "☆".repeat(Math.max(0, 3 - n));
}

function availableBox() {
  const rect = stageEl.value.getBoundingClientRect();
  return { width: Math.max(1, rect.width - 2), height: Math.max(1, rect.height - 2) };
}

function relayout() {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  layout = birdsLayout(viewport, availableBox());
  ctx = setupCanvas(canvasEl.value, layout.css);
  cam = cameraFor(layout, game?.focus() ?? { x: SLING.x, y: 0 });
}

/** 一局 = 一次关卡尝试：通关、鸟用完、中途退出都落一次盘，绝不每帧写 */
function beginSession() {
  session = { startedAt: Date.now() };
}

function endSession(outcome) {
  if (!session) return;
  const ms = Math.max(0, Date.now() - session.startedAt);
  session = null;
  storedBest = store.commitRun(GAME_ID, { score: game.score, level: game.index + 1, ms, outcome });
  if (outcome === "won") recordProgress();
}

/** 通关才动跨局存档：解锁下一关 + 记下更好的星数 */
function recordProgress() {
  const doc = save.value;
  const stars = { ...(doc.stars ?? {}) };
  const id = game.level.id;
  stars[id] = Math.max(stars[id] ?? 0, game.stars);
  const next = {
    unlocked: Math.max(doc.unlocked ?? 1, Math.min(levelCount, game.index + 2)),
    stars,
    best: Math.max(doc.best ?? 0, game.score),
  };
  writeSave(next);
}

function syncHud() {
  const next = game.hud();
  const signature = `${next.score}|${next.left}|${next.pigs}|${next.power}|${next.angle}|${next.stars}|${next.seconds}`;
  if (signature === statsCache) return;
  statsCache = signature;
  hud.score = next.score;
  hud.best = Math.max(storedBest, next.score);
  hud.level = next.level;
  hud.levelName = next.levelName;
  hud.pigs = next.pigs;
  hud.left = next.left;
  hud.power = next.power;
  hud.angle = next.angle;
  hud.stars = next.stars;
  hud.seconds = formatSeconds(next.seconds);
  hud.message = next.message;
  hud.hint = next.hint;
  queue.value = next.birds;
}

function syncStatus() {
  syncHud();
  if (game.status !== status.value && (game.status === "over" || game.status === "won")) {
    endSession(game.status);
  }
  status.value = game.status;
  phase.value = game.phase;
}

function startLevel(index) {
  game.loadLevel(index);
  game.start();
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
  } else if (game.status === "won") {
    if (game.index >= levelCount - 1) startLevel(0);
    else startLevel(game.index + 1);
    return;
  } else if (game.status === "over") {
    startLevel(game.index);
    return;
  } else if (game.phase === "aim") {
    game.launch();
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

/** 控制带那枚按钮的标签会随状态变（开始/暂停/继续/重开），动作也跟着变 */
function bandAction() {
  if (game.status === "won" || game.status === "over") {
    restart();
    return;
  }
  togglePause();
}

function restart() {
  audio.unlock();
  endSession("quit");
  startLevel(game.index);
}

function launch() {
  audio.unlock();
  if (game.status === "ready") {
    game.start();
    beginSession();
  }
  game.launch();
  syncStatus();
}

function ability() {
  audio.unlock();
  game.ability();
  syncStatus();
}

function trim(dPower, dAngle) {
  audio.unlock();
  game.trim(dPower, dAngle);
  syncStatus();
}

function toggleSound() {
  audio.unlock();
  muted.value = !muted.value;
  audio.setMuted(muted.value);
  store.setPref("muted", muted.value);
}

function onPull(dxPx, dyPx) {
  audio.unlock();
  if (!layout) return;
  // 换算只有一条通路：layout.aimFromPull 用屏幕行程归一功率，三端手指距离一致
  const aim = aimFromPull(layout, dxPx, dyPx);
  game.setAim(aim.power, aim.angle);
  syncStatus();
}

function onRelease() {
  if (game.phase !== "aim") return;
  if (game.aim.power < 0.08) {
    game.setAim(0, game.aim.angle);
    syncStatus();
    return;
  }
  game.launch();
  syncStatus();
}

function getAim() {
  if (!layout) return { grabbable: false, flying: false, anchor: { x: 0, y: 0 }, pullRef: 40, grab: 96 };
  const anchor = worldToScreen(layout, cam, SLING.x, SLING.y);
  return {
    grabbable: game.status === "playing" && game.phase === "aim",
    flying: game.status === "playing" && game.phase === "flight",
    anchor,
    pullRef: layout.pullRef,
    grab: layout.pullRef * GRAB_RADIUS,
  };
}

function render(ts) {
  if (!ctx || !layout) return;
  cam = cameraFor(layout, game.focus());
  draw(ctx, game, layout, cam, ts);
}

function pump(ts) {
  if (!last) last = ts;
  // 切回标签或 watchdog 补帧时 dt 会很大：夹到 0.05 秒，宁可慢放也不让鸟一帧穿墙
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

onMounted(() => {
  storedBest = profile.value.best;
  muted.value = prefs.value.muted === true;
  audio = createAudio();
  audio.setMuted(muted.value);
  game = new Birds({ level: Math.min(save.value.unlocked ?? 1, levelCount) - 1, onSound: (name) => audio.play(name) });

  relayout();
  syncStatus();

  input = bindInput({
    canvas: canvasEl.value,
    onPull,
    onRelease,
    onAbility: ability,
    onTrim: trim,
    getAim,
    onAction: (name) => {
      audio.unlock();
      if (name === "primary") primaryAction();
      else if (name === "ability") ability();
      else if (name === "pause") togglePause();
      else if (name === "restart") restart();
      else if (name === "mute") toggleSound();
      else if (name === "next") {
        if (game.status === "won" && game.index < levelCount - 1) startLevel(game.index + 1);
      }
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
  booted.value = true;
  /*
   * 首帧之后才渲染的东西（鸟队 chip、选关条）会把控制带撑高，画布就得重排一次。
   * ResizeObserver 挂在"更新渲染"这一步上，hidden 预览页根本不派发，所以这里补一个定时器兜底。
   */
  settleLayoutId = setTimeout(relayout, 60);

  if (import.meta.env.DEV) {
    window.birds = game;
    window.birdsLayout = () => layout;
    window.birdsCamera = () => cam;
    window.birdsRelayout = relayout;
    window.birdsLevel = (index) => startLevel(Number(index) || 0);
    window.birdsShoot = (power, angle) => {
      if (game.status === "ready") startLevel(game.index);
      game.setAim(Number(power), Number(angle));
      game.launch();
      syncStatus();
    };
    window.birdsBoxes = () => {
      const root = rootEl.value;
      const rect = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top) };
      };
      const hits = [];
      for (const el of root?.querySelectorAll(".pad .btn, .controls .btn, .preview .btn") ?? []) {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue; // 桌面/平板档位下 .exit 是 display:none，不计入命中检查
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        hits.push({ label: el.textContent.trim(), clickable: hit === el || el.contains(hit) });
      }
      // full 取组件根本身：它自己就带 .playfield，querySelector 找不到自己
      return { viewport: { w: window.innerWidth, h: window.innerHeight }, full: rect(root), stage: rect(root?.querySelector(".stage")), canvas: rect(root?.querySelector(".board")), side: rect(root?.querySelector(".side")), band: rect(root?.querySelector(".pad")), controls: rect(root?.querySelector(".controls")), hits };
    };
  }
});

function onRotate() {
  setTimeout(relayout, 120);
}

function onVisibility() {
  if (document.visibilityState !== "visible") return;
  // 页面重新可见时 rAF 已经重新开跑，把时间游标清零，避免把后台那段时间一次性补进物理
  last = 0;
  lastPump = performance.now();
}

/** 心跳只在局内需要：结算与暂停画面挂 60 Hz 的 Worker 是白烧电 */
watch(status, (value) => {
  ticker?.postMessage(value === "playing" ? "start" : "stop");
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
  input?.unbind();
  audio?.dispose?.();
  if (import.meta.env.DEV) {
    delete window.birds;
    delete window.birdsLayout;
    delete window.birdsCamera;
    delete window.birdsRelayout;
    delete window.birdsLevel;
    delete window.birdsShoot;
    delete window.birdsBoxes;
  }
});
</script>

<template>
  <div ref="rootEl" class="playfield">
    <div ref="stageEl" class="stage">
      <canvas ref="canvasEl" class="board" aria-label="愤怒的小鸟游戏画面" />
      <div v-if="overlay" class="overlay">
        <div class="overlay-card">
          <h2>{{ overlay.title }}</h2>
          <p>{{ overlay.text }}</p>
          <div v-if="showLevels" class="levels">
            <button
              v-for="lv in levelChoices"
              :key="lv.id"
              class="btn btn--level"
              :class="{ 'btn--locked': !lv.open, 'btn--now': lv.index + 1 === hud.level }"
              :disabled="!lv.open"
              :title="lv.open ? lv.name : '通关前一关解锁'"
              @click="lv.open && startLevel(lv.index)"
            >
              <b>{{ lv.index + 1 }}</b>
              <span class="lvl-stars">{{ starsMark(lv.stars) }}</span>
            </button>
          </div>
          <button class="btn btn--primary" @click="primaryAction">{{ overlay.button }}</button>
        </div>
      </div>
    </div>

    <aside class="side">
      <dl class="stats">
        <dt>分数</dt>
        <dd>{{ hud.score }}</dd>
        <dt>最高</dt>
        <dd>{{ hud.best }}</dd>
        <dt>关卡</dt>
        <dd>{{ hud.level }} / {{ levelCount }}</dd>
        <dt>剩余猪</dt>
        <dd>{{ hud.pigs }}</dd>
        <dt>剩余鸟</dt>
        <dd>{{ hud.left }}</dd>
        <dt>功率</dt>
        <dd>{{ hud.power }}%</dd>
        <dt>仰角</dt>
        <dd>{{ hud.angle }}°</dd>
        <dt>用时</dt>
        <dd>{{ hud.seconds }}</dd>
      </dl>

      <div class="previews">
        <div class="preview">
          <span class="preview-label">鸟队</span>
          <span class="birds">
            <i
              v-for="(b, i) in queue"
              :key="`${b.name}-${i}`"
              class="chip"
              :class="`chip--${b.state}`"
              :style="{ background: b.color }"
              :title="`${b.name}：${b.hint}`"
            />
          </span>
        </div>
        <div class="preview">
          <span class="preview-label">本关</span>
          <span class="line">{{ hud.levelName }}</span>
        </div>
      </div>

      <div class="pad" role="group" aria-label="瞄准与发射">
        <button class="btn" @click="trim(0, 0.06)" aria-label="抬高仰角">仰角+</button>
        <button class="btn" @click="trim(0, -0.06)" aria-label="压低仰角">仰角−</button>
        <button class="btn" @click="trim(0.08, 0)" aria-label="增加功率">功率+</button>
        <button class="btn" @click="trim(-0.08, 0)" aria-label="减小功率">功率−</button>
        <button class="btn btn--fire" @click="launch">发射</button>
        <button class="btn" @click="ability">技能</button>
      </div>

      <div class="controls">
        <button class="btn" @click="bandAction">{{ pauseLabel }}</button>
        <button class="btn" @click="restart">重开</button>
        <button class="btn" @click="toggleSound">{{ soundLabel }}</button>
        <RouterLink class="btn exit" :to="{ name: 'home' }">退出</RouterLink>
      </div>

      <p v-if="hud.message" class="notice notice--info">{{ hud.message }}</p>
      <p v-if="!storageOk" class="notice">本地存储写不进去（隐私模式或配额已满），通关进度不会保存。</p>

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
        <p v-else class="muted">还没有战绩，通关或鸟用光都会留档。</p>
      </section>

      <details class="guide">
        <summary>怎么玩</summary>
        <p class="muted">{{ hud.hint }}</p>
        <p class="muted">
          按住弹兜里的鸟往左下拖，拖得越远功率越大，松手发射；虚线是只按重力算的预演，实际会不会被横梁挡住要看运气。
          飞行中再点一下画面就放技能：{{ BIRDS.yellow.name }}急冲、{{ BIRDS.black.name }}原地引爆，{{ BIRDS.red.name }}没有技能。
          剩下的鸟每只折 5000 分，用越越少星越高。
        </p>
        <p class="keys muted">
          <kbd>↑</kbd><kbd>↓</kbd> 仰角 · <kbd>→</kbd><kbd>←</kbd> 功率 · <kbd>空格</kbd> 发射 · <kbd>X</kbd> 技能 ·
          <kbd>P</kbd> 暂停 · <kbd>R</kbd> 重开 · <kbd>M</kbd> 静音 · <kbd>N</kbd> 下一关
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
  overflow: hidden;
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
  /* 遮罩本体不吃手势，否则会挡住画布上的拉弓与技能点击 */
  pointer-events: none;
}

.overlay-card {
  max-width: 420px;
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
  margin: 0 0 12px;
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1.6;
}

.levels {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px;
  margin: 0 0 14px;
}

.btn--level {
  display: grid;
  gap: 2px;
  min-width: 52px;
  padding: 6px 8px;
  font-size: 12px;
}

.btn--level b {
  font-size: 14px;
}

.lvl-stars {
  color: var(--warn);
  font-size: 10px;
  letter-spacing: 1px;
}

.btn--locked {
  opacity: 0.4;
  cursor: not-allowed;
}

.btn--now {
  border-color: var(--accent);
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

.previews {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.preview {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 12px;
  border: 1px solid var(--panel-edge);
  border-radius: var(--radius);
  background: var(--bg-soft);
}

.preview-label {
  color: var(--text-muted);
  font-size: 11px;
}

.birds {
  display: flex;
  gap: 5px;
}

.chip {
  width: 16px;
  height: 16px;
  border: 1px solid rgba(8, 12, 20, 0.7);
  border-radius: 50%;
}

.chip--used {
  opacity: 0.25;
}

.chip--next {
  box-shadow: 0 0 0 2px var(--accent);
}

.line {
  font-size: 13px;
  font-weight: 600;
}

.pad {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
}

.pad .btn {
  padding: 9px 4px;
  font-size: 13px;
  white-space: nowrap;
}

.btn--fire {
  border-color: var(--danger);
  font-weight: 700;
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

/* 出口只给手机端的全屏层用（页头的「← 游戏厅」会被盖住），桌面/平板照常收起 */
.exit {
  display: none;
}

.notice--info {
  border-color: var(--accent);
  color: var(--text-muted);
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
  grid-template-columns: minmax(0, 1fr) 320px;
  align-items: stretch;
}

html[data-device="desktop"] .pad {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

/* 平板横屏：窄一点的右侧栏，控制键排两列才不会折行 */
html[data-device="tablet"][data-orientation="landscape"] .playfield {
  grid-template-columns: minmax(0, 1fr) 250px;
}

html[data-device="tablet"][data-orientation="landscape"] .controls {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

/* 平板竖屏：侧栏移到画布下方，统计排成一行，键位与按钮并排 */
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

html[data-device="tablet"][data-orientation="portrait"] .previews {
  flex: 1 1 220px;
}

html[data-device="tablet"][data-orientation="portrait"] .pad {
  flex: 1 1 300px;
}

html[data-device="tablet"][data-orientation="portrait"] .controls {
  flex: 1;
}

html[data-device="tablet"][data-orientation="portrait"] .history {
  flex: 1;
}

html[data-device="tablet"][data-orientation="portrait"] .guide {
  display: none;
}

/* 手机端不在此处写规则：全屏层与压缩后的控制带由 src/styles/playfield.css 统一负责，
   组件里再写一条 html[data-device="phone"] .X 会因为 scoped 属性把特异度顶到同一档，
   后加载的异步 chunk 就会盖住公共层（上一版手机端画布只剩 194 px 宽的病根）。 */
</style>
