<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { Delta } from "./game.js";
import { MAPS, compileMap } from "./map.js";
import { ITEM_KEYS, ITEMS } from "./loot.js";
import { WEAPONS } from "./weapons.js";
import {
  EMPTY_SAVE,
  SKILLS,
  buyItem,
  ensureTask,
  equipFromStash,
  raidReadiness,
  refillAmmo,
  refillMeds,
  sanitizeSave,
  sellItem,
  setSkill,
  settleRaid,
  taskById,
  unequip,
} from "./economy.js";
import { applyField, canvasBox, computeLayout, resolveViewport } from "./layout.js";
import { bindInput } from "./input.js";
import { createAudio } from "./audio.js";
import { draw, drawMinimapOverlay, setupCanvas } from "./renderer.js";
import { LOOK_TAU_PER_WIDTH } from "./scene3d.js";
import { useGameSave, usePrefs, useStorageAvailable, useStore } from "../../composables/useStore.js";
import { useDevice } from "../../composables/useDevice.js";
import { DEVICE_LABEL } from "../../utils/device.js";

const GAME_ID = "delta";

/** 地图是静态数据，编译一次就够；每次 computed 都重跑会把 32×24 的网格重建在渲染热路上 */
const MAP_LIST = MAPS.map((def) => compileMap(def));

const stageEl = ref(null);
const stackEl = ref(null);
const canvasEl = ref(null);
const glCanvasEl = ref(null);
/** 视图模式：topdown 是原来的 2D 俯视，fps 走 three 的 WebGL；两者共用同一个引擎与同一条主循环 */
const viewMode = ref("topdown");
const hud = reactive({});
const phase = ref("lobby");
const muted = ref(false);
const message = ref("");
const ledger = ref(null);
const mapId = ref(MAP_LIST[0].id);

const store = useStore();
const prefs = usePrefs();
const device = useDevice();
const storageOk = useStorageAvailable();
const { save: rawSave, write } = useGameSave(GAME_ID, EMPTY_SAVE);

let game = null;
let audio = null;
let input = null;
let ctx = null;
let observer = null;
let rafId = 0;
let timerId = 0;
let ticker = null;
let last = 0;
let lastPump = 0;
let layout = null;
/** three 的绑定层实例：只有切过第一人称才存在，卸载与新局都要释放 */
let threeView = null;
/** 局内提示条的自动消失计时器（提示压在画布上，不留着挡视线） */
let msgTimer = 0;
/** 键盘转向档位（-1/0/1），由输入层回调写、pump 里按 dt 积分 */
let lookRate = 0;
/** 像素→弧度的换算系数，syncLayout 按当前画布宽度刷新（整屏拖动 ≈ 300°） */
let lookRadPerPx = 1 / 900;
let runId = 0;
let settled = false;
let hudTick = 0;
let prev = { shots: 0, kills: 0, searched: 0, hp: 0, reloading: 0, meds: 0, skill: 0, exfil: false };

/** 读档必须清洗：手改的 JSON 也走这条路，sanitizeSave 保证拿到的是完整可用的存档 */
const save = computed(() => sanitizeSave(rawSave.value, { itemKeys: ITEM_KEYS }));
const task = computed(() => taskById(save.value.tasks.active));
const readiness = computed(() => raidReadiness(save.value));
const maps = MAP_LIST;
const currentMap = computed(() => maps.find((m) => m.id === mapId.value) ?? maps[0]);

function mapName(id) {
  return maps.find((m) => m.id === id)?.name ?? id;
}

const SLOT_LABEL = { primary: "主武器", sidearm: "副武器", armor: "防弹衣", helmet: "头盔", bag: "背包" };
const LOADOUT_SLOTS = ["primary", "sidearm", "armor", "helmet", "bag"];

function itemName(key) {
  return ITEMS[key]?.label ?? key;
}

function money(value) {
  return `${Math.round(value).toLocaleString("zh-CN")}`;
}

/** 落盘只在这两个时机：一局结算一次、配装或商店变更一次。帧循环里绝不写存储。 */
function persist(next) {
  write(next);
}

function mutate(result) {
  if (!result || !result.ok) {
    if (result?.reason) message.value = REASON[result.reason] ?? "操作失败";
    return false;
  }
  persist(result.save);
  message.value = "";
  return true;
}

const REASON = {
  wallet: "柯尔不足",
  "stash-full": "仓库格子不够",
  "safebox-full": "保险箱格子不够",
  "not-in-stash": "仓库里没有这件",
  "not-in-safebox": "保险箱里没有这件",
  "wrong-slot": "这件装不进这个槽位",
  "bad-slot": "槽位不认识",
  unknown: "未知物品",
  empty: "这一格是空的",
};

function autoEquip() {
  let doc = ensureTask(save.value);
  for (const slot of LOADOUT_SLOTS) {
    if (doc.loadout[slot]) continue;
    const candidate = doc.stash.items.find((entry) => {
      const spec = ITEMS[entry.key];
      if (!spec || spec.kind !== (slot === "primary" || slot === "sidearm" ? "weapon" : slot)) return false;
      if (slot === "primary") return WEAPONS[entry.key]?.slot === "primary";
      if (slot === "sidearm") return WEAPONS[entry.key]?.slot === "sidearm";
      return true;
    });
    if (!candidate) continue;
    const verdict = equipFromStash(doc, candidate.key, slot);
    if (verdict.ok) doc = verdict.save;
  }
  if (!doc.loadout.ammo.kind || doc.loadout.ammo.count <= 0) {
    const kind = WEAPONS[doc.loadout.primary]?.ammo ?? WEAPONS[doc.loadout.sidearm]?.ammo ?? "am_9";
    const stock = doc.stash.items.find((entry) => entry.key === kind);
    if (stock) {
      const filled = refillAmmo(doc, kind, stock.qty);
      if (filled.ok) doc = filled.save;
    }
  }
  if (doc.loadout.meds <= 0) {
    const stock = doc.stash.items.find((entry) => ITEMS[entry.key]?.kind === "med");
    if (stock) {
      const filled = refillMeds(doc, stock.qty);
      if (filled.ok) doc = filled.save;
    }
  }
  if (!doc.loadout.skill) {
    const picked = setSkill(doc, SKILLS[0]);
    if (picked.ok) doc = picked.save;
  }
  persist(doc);
  message.value = "已按仓库现有物资配装";
}

function equip(key, slot) {
  mutate(equipFromStash(save.value, key, slot));
}

function dropSlot(slot) {
  mutate(unequip(save.value, slot));
}

function buy(key, qty = 1) {
  mutate(buyItem(save.value, key, qty));
}

function sell(key, qty = 1) {
  mutate(sellItem(save.value, key, qty));
}

function pickSkill(skill) {
  mutate(setSkill(save.value, skill));
}

function stashInSlot(slot) {
  return save.value.stash.items.filter((entry) => {
    const spec = ITEMS[entry.key];
    if (!spec) return false;
    if (slot === "primary" || slot === "sidearm") return spec.kind === "weapon" && WEAPONS[entry.key]?.slot === slot;
    return spec.kind === slot;
  });
}

function startRaid() {
  if (!readiness.value.ready) {
    message.value = `出征还缺：${readiness.value.missing.join("、")}`;
    return;
  }
  runId = Date.now();
  settled = false;
  ledger.value = null;
  game = new Delta({
    mapId: mapId.value,
    loadout: save.value.loadout,
    skill: save.value.loadout.skill,
    rng: Math.random,
    debug: import.meta.env.DEV,
  });
  if (import.meta.env.DEV) window.delta = game;
  audio?.unlock();
  syncHud(true);
  phase.value = "playing";
  message.value = "";
  void rebindView();
}

/**
 * 新局可能换了地图，旧场景一定要丢掉（几何是按 map 编译的）；视图偏好继续生效，
 * 起不来 WebGL 就退回俯视——引擎只认 viewMode，退回去不会弄脏任何状态。
 */
async function rebindView() {
  threeView?.dispose();
  threeView = null;
  if (viewMode.value === "fps") {
    try {
      await ensureThreeView(glCanvasEl.value);
    } catch (error) {
      viewMode.value = "topdown";
      game?.setViewMode("topdown");
      // 偏好也要跟着退：不然下次进局还按 fps 重建 WebGL，每局都白失败一次
      prefsSetView("topdown");
      flash(`这台设备起不了 WebGL，已退回俯视图（${error?.message ?? error}）`);
      return;
    }
  }
  game?.setViewMode(viewMode.value);
  await nextTick();
  syncLayout();
  renderFrame(performance.now());
}

function syncHud(force = false) {
  if (!game) return;
  if (!force && (hudTick += 1) % 5 !== 0) return;
  const next = game.hud();
  for (const key of Object.keys(next)) hud[key] = next[key];
}

function pumpAudio() {
  if (!game || !audio) return;
  const s = game.stats;
  if (s.shots > prev.shots) audio.play(game.weapon.sfx ?? "click");
  if (s.kills > prev.kills) audio.play("hit");
  if (s.searched > prev.searched) audio.play("search");
  if (game.player.hp < prev.hp) audio.play("hurt");
  if (game.reloading > prev.reloading) audio.play("reload");
  if (game.meds < prev.meds) audio.play("med");
  if ((game.skill?.uses ?? 0) < prev.skill) audio.play("skill");
  if (game.exfilHoldSec > 0 && !prev.exfil) audio.play("exfil");
  prev = {
    shots: s.shots,
    kills: s.kills,
    searched: s.searched,
    hp: game.player.hp,
    reloading: game.reloading,
    meds: game.meds,
    skill: game.skill?.uses ?? 0,
    exfil: game.exfilHoldSec > 0,
  };
}

/** 存储层的战绩只认 over/won/quit 三种结局，delta 的四态在这一处翻译，别在两个调用点各写一遍 */
const RUN_OUTCOME = { escaped: "won", killed: "over", timeout: "over", aborted: "quit" };

function commitResult(result) {
  store.commitRun(GAME_ID, {
    score: result.value,
    level: result.mapTier,
    ms: Math.round(result.timeSec * 1000),
    outcome: RUN_OUTCOME[result.outcome] ?? "quit",
  });
}

function endRaid() {
  if (settled || !game) return;
  settled = true;
  const result = game.settle();
  const outcome = settleRaid(save.value, result, { now: Date.now(), runId });
  if (!outcome.deduped) {
    persist(outcome.save);
    ledger.value = { ...outcome.ledger, result };
    commitResult(result);
  } else {
    ledger.value = ledger.value ?? { outcome: result.outcome, kept: [], lost: [], droppedForOverload: [], result };
  }
  audio?.play(result.outcome === "escaped" ? "escape" : "dead");
  syncHud(true);
  phase.value = "result";
}

function onAction(action) {
  audio?.unlock();
  if (phase.value === "result") {
    if (action === "restart") backToLobby();
    return;
  }
  if (phase.value === "lobby") {
    if (action === "primary" || action === "restart") startRaid();
    else if (action === "pause") backToLobby();
    return;
  }
  switch (action) {
    case "pause":
      // 同一个键（P / Esc）进出暂停：只往一个方向走的话，暂停后就再也出不来了
      if (phase.value === "paused") resume();
      else pause();
      break;
    case "mute":
      toggleMute();
      break;
    case "view":
      // 建 WebGL 是异步的（three 懒加载），这里不 await：失败会写进 message，游戏照常跑
      void toggleView();
      break;
    default:
      game?.enqueue(action);
      break;
  }
}

function setStick(x, y) {
  game?.setStick(x, y);
}

function pause() {
  if (phase.value !== "playing") return;
  phase.value = "paused";
  setStick(0, 0);
  lookRate = 0;
  // 暂停期间没人消费待消化转向，重新声明一次视图模式把它清空，免得恢复时突然回头
  game?.setViewMode(viewMode.value);
}

function resume() {
  if (phase.value !== "paused") return;
  phase.value = "playing";
  last = 0;
}

/** 中途返回：资产按"撤离"处理但不带货（引擎的 aborted 已经这么判），落盘一次 */
function quitRaid() {
  if (!game || phase.value === "result") return;
  const result = game.abort();
  if (!settled) {
    settled = true;
    const outcome = settleRaid(save.value, result, { now: Date.now(), runId });
    persist(outcome.save);
    ledger.value = { ...outcome.ledger, result };
    commitResult(result);
  }
  game.destroy?.();
  game = null;
  phase.value = "result";
}

function backToLobby() {
  if (game && !settled && phase.value !== "result") quitRaid();
  else if (phase.value === "result") {
    game?.destroy?.();
    game = null;
    ledger.value = null;
    settled = false;
    phase.value = "lobby";
    // 阵亡回来时槽位是全空的（补发的基础装备在仓库里），不自动装一次就只能看见一个点不动的出征按钮
    if (!readiness.value.ready) autoEquip();
  } else {
    phase.value = "lobby";
  }
  syncLayout();
}

function toggleMute() {
  const next = audio ? audio.toggleMute() : !muted.value;
  muted.value = next;
  store.setPref("muted", next);
}

/**
 * three 只在第一次切到第一人称时才动态 import：俯视玩家不该为 WebGL 库付下载。
 * Vite 把它切成独立 chunk，dev 与生产走同一套懒加载语义。
 */
let createThreeView = null;
async function ensureThreeView(canvas) {
  // 拿不到画布不能静默返回：调用方会照样把 viewMode 设成 fps，
  // 结果画面还是俯视、按钮却变成"俯视"，玩家看到的就是"点了没反应"。
  if (!canvas) throw new Error("第一人称画布还没就绪，请先开始一局再切换视角");
  if (!createThreeView) {
    const mod = await import("./three-view.js");
    createThreeView = mod.createThreeView;
  }
  if (threeView) return threeView;
  threeView = createThreeView({ canvas, map: currentMap.value });
  return threeView;
}

/** 键盘转向角速度：9 rad/s ≈ 516°/s，够追上冲过来的近身，又不至于一点就转半圈 */
const LOOK_KEY_RATE = 9;

/**
 * 切换视图。失败（无 WebGL/老设备）不改变游戏，只把原因写进提示条并保持俯视，
 * 因为引擎不认视图模式之外的任何东西，退回俯视不会弄脏状态。
 */
async function setView(mode) {
  const next = mode === "fps" ? "fps" : "topdown";
  if (next === viewMode.value) return true;
  if (next === "fps") {
    try {
      await ensureThreeView(glCanvasEl.value);
    } catch (error) {
      flash(`切不了第一人称：${error?.message ?? error}`);
      return false;
    }
  }
  viewMode.value = next;
  game?.setViewMode(next);
  prefsSetView(next);
  message.value = "";
  await nextTick();
  syncLayout();
  renderFrame(performance.now());
  return true;
}

function toggleView() {
  return setView(viewMode.value === "fps" ? "topdown" : "fps");
}

/** 局内提示：切视图/动作失败的原因要让玩家当场看见，只在 lobby 渲染等于没有提示 */
function flash(text, ms = 2800) {
  message.value = text;
  clearTimeout(msgTimer);
  if (ms > 0) msgTimer = setTimeout(() => { message.value = ""; }, ms);
}

/** 偏好里记住上次用的视图；坏值一律当俯视 */
function prefsSetView(mode) {
  try {
    store.setPref("deltaView", mode);
  } catch {
    // 偏好写不进去不影响游戏
  }
}

/**
 * 主循环：rAF 优先，另挂一条不依赖 rAF 的兜底链路。
 * Qoder 内置浏览器和后台标签里 rAF 会一帧都不回调（实测 hidden 时 3 秒 0 帧），
 * 只靠 rAF 的话点了开始后画面与计时全冻，玩家看到的就是"没反应"。
 * 兜底用的是同一条推进逻辑，时间仍然按真实时间戳差值走，语义不变。
 */
const CATCHUP_SEC = 0.5;

function pump(ts) {
  if (!game || phase.value !== "playing") {
    last = 0;
    renderFrame(ts);
    return;
  }
  if (!last) last = ts;
  let dt = (ts - last) / 1000;
  last = ts;
  if (dt <= 0) return;
  if (dt > CATCHUP_SEC) dt = CATCHUP_SEC;
  // 键盘转向按 dt 积分成"这一帧转多少弧度"，塞进引擎的待消化转向；拖动转向在 onLook 里已经直接塞过
  if (lookRate !== 0 && viewMode.value === "fps") game.setLook(lookRate * LOOK_KEY_RATE * dt);
  // 引擎单次 step 最多消化 0.05 秒，被节流的定时器要切片补上，否则慢放成静态
  let left = dt;
  do {
    const slice = Math.min(left, 0.05);
    game.step(slice);
    left -= slice;
  } while (left > 1e-4 && game.status !== "over" && game.status !== "won");
  syncHud();
  pumpAudio();
  renderFrame(ts);
  if (game.status === "over" || game.status === "won") endRaid();
}

/**
 * 一帧绘制：两个视图共用同一个时间戳与同一份引擎状态，切换视图不影响推进。
 * 第一人称下 2D 画布只留小地图（透明叠加在 WebGL 画面之上），全局感不丢。
 */
function renderFrame(ts) {
  if (!game || !layout || !ctx) return;
  if (viewMode.value === "fps" && threeView) {
    threeView.sync(game, { phase: ts / 1000 });
    threeView.render();
    drawMinimapOverlay(ctx, game, { metrics: layout.metrics });
    return;
  }
  draw(ctx, game, { phase: ts / 1000, metrics: layout.metrics });
}

function frame(ts) {
  rafId = requestAnimationFrame(frame);
  lastPump = ts;
  pump(ts);
}

/**
 * rAF 还活着（250 ms 内进过帧）就完全交给它，否则自己按真实时间推。
 * 走的是同一个 pump，因此共享 `last` 游标，不会和 rAF 各推一遍造成时间翻倍。
 * 后台标签里 setInterval 会被节流到约 1 秒一次，pump 内部按 0.05 秒切片补帧，
 * 最坏情况是慢放而不是静止——静止才是玩家眼中的"没反应"。
 */
function watchdog() {
  const now = performance.now();
  if (now - lastPump < 250) return;
  lastPump = now;
  pump(now);
}

function syncLayout() {
  const stage = stageEl.value;
  const canvas = canvasEl.value;
  if (!stage || !canvas) return;
  /**
   * 盒子取 .stack 而不是 .stage：控制带进了流，画布真正能用的只有它上面那一格；
   * 按整块 stage 算，横屏时会多出整整一条控制带的高度、把按钮盖在画面下面。
   *
   * 藏身处/结算页里舞台是 display:none，getBoundingClientRect 恒为 0×0，
   * 直接喂给 canvasBox 会得到 2×1 的画布（进局后后台标签的 ResizeObserver 未必回调，就一直空白）。
   * 所以逐级退回 .stage → 外层容器 → 视口，保证任何时候量到的都是能用的盒子。
   */
  const usable = (box) => Boolean(box) && box.width >= 40 && box.height >= 40;
  const candidates = [
    stackEl.value?.getBoundingClientRect(),
    stage.getBoundingClientRect(),
    stage.parentElement?.getBoundingClientRect(),
    { width: window.innerWidth, height: Math.round(window.innerHeight * 0.7) },
  ];
  const box = candidates.find(usable) ?? candidates[candidates.length - 1];
  // 旋转事件抢跑时窗口值还是旧的，朝向以容器为准（见 layout.js 的 resolveViewport）
  layout = computeLayout(resolveViewport({ width: window.innerWidth, height: window.innerHeight }, box), box);
  applyField(layout.field, layout.device, layout.orientation);
  const css = canvasBox(layout, box);
  canvas.style.width = `${css.width}px`;
  canvas.style.height = `${css.height}px`;
  ctx = setupCanvas(canvas, css);
  // 转向灵敏度按画布宽度归一：整屏宽拖动 ≈ 300°，手机行程短也能转到位
  lookRadPerPx = (Math.PI * 2 * LOOK_TAU_PER_WIDTH) / Math.max(120, css.width);
  const glCanvas = glCanvasEl.value;
  if (glCanvas) {
    glCanvas.style.width = `${css.width}px`;
    glCanvas.style.height = `${css.height}px`;
    threeView?.resize(css);
  }
}

const OUTCOME_TEXT = {
  escaped: { title: "成功撤离", tone: "good" },
  killed: { title: "行动中失联", tone: "bad" },
  timeout: { title: "超时失联", tone: "bad" },
  aborted: { title: "中途返回", tone: "neutral" },
};

const ledgerTitle = computed(() => OUTCOME_TEXT[ledger.value?.outcome] ?? { title: "结算", tone: "neutral" });

onMounted(() => {
  audio = createAudio();
  muted.value = prefs.value.muted === true;
  // 视图偏好只认这两个值，坏值当俯视；真正建 WebGL 要等进局（rebindView）
  if (prefs.value.deltaView === "fps") viewMode.value = "fps";
  audio.setMuted(muted.value);
  if (!save.value.tasks.active) persist(ensureTask(save.value));
  // 新档的仓库里有起手包但槽位是空的：直接替玩家装上，否则第一次进来只能看见一个灰掉的出征按钮
  if (!readiness.value.ready) autoEquip();
  syncLayout();
  observer = new ResizeObserver(syncLayout);
  observer.observe(stageEl.value);
  // 画布盒子取自 .stack，所以它也必须被观察：控制带换行数（转屏/改档位）时只有它变
  observer.observe(stackEl.value);
  window.addEventListener("orientationchange", syncLayout);
  input = bindInput({
    canvas: canvasEl.value,
    // 用 getter 而不是快照：转屏后摇杆半径要跟着档位走，否则手机上摇杆比视觉大一圈
    metrics: { get padRadius() { return layout?.metrics.padRadius ?? 64; } },
    shouldHandle: () => phase.value === "playing" || phase.value === "paused",
    onStick: setStick,
    onAction,
    // 第一人称的两条转向通道：拖动给像素增量（这里换算成弧度），键盘给档位（pump 里按 dt 积分）
    isFps: () => viewMode.value === "fps",
    onLook: (dxPx) => game?.setLook(dxPx * lookRadPerPx),
    onLookRate: (dir) => { lookRate = dir; },
  });
  rafId = requestAnimationFrame(frame);
  timerId = setInterval(watchdog, 100);
  /**
   * Worker 心跳：不可见的页面里 rAF 一帧不发、定时器还被逐级节流（实测 2 秒只回 3 次），
   * 唯一不受这套限制的是 Worker 的 postMessage（同一页面实测 2 秒收到 177 条）。
   * 建不出来（老 WebView、严格 CSP 禁 worker-src）就退回上面的 setInterval，不报错。
   */
  try {
    ticker = new Worker(new URL("./tick.js", import.meta.url), { type: "module" });
    ticker.onmessage = () => pump(performance.now());
  } catch {
    ticker = null;
  }
  // 隐藏标签里 rAF 一帧不发、定时器还会被逐步节流到分钟级，页面自己救不了自己；
  // 能做的是切回可见的瞬间重挂 rAF 并清零时间游标，既不用等 watchdog 的 250 ms 门限，
  // 也不会把整段离场时间当成一帧的 dt 补进来（那会立刻超时/被 AI 打死后排）。
  document.addEventListener("visibilitychange", onVisibility);
});

/** 切回前台：丢弃冻结期间的 rAF 排期，从当前时刻重新起算 */
function onVisibility() {
  if (document.hidden) return;
  last = 0;
  lastPump = 0;
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(frame);
}

/** 档位/朝向变了但舞台盒子可能没变（桌面拖窗口边缘、折叠屏展开），补一次重算 */
watch(() => `${device.device}:${device.width}x${device.height}`, syncLayout);

/** 相位切换会让舞台从 display:none 变成有尺寸，DOM 更新后要按真实盒子重算一次 */
watch(phase, async () => {
  await nextTick();
  syncLayout();
  // 心跳只在局内需要：藏身处/结算页挂 60 Hz 的 Worker 是白烧电
  ticker?.postMessage(phase.value === "playing" ? "start" : "stop");
  /**
   * 立刻补一帧：主循环只在收到帧时绘制，而隐藏标签里 rAF 一帧都不发，
   * 不补这一帧的话点了"进入"看到的是全黑画布，玩家读到的是"点了没反应"。
   */
  if (ctx && layout && game) renderFrame(performance.now());
});

onBeforeUnmount(() => {
  if (game && !settled && phase.value !== "result") quitRaid();
  cancelAnimationFrame(rafId);
  rafId = 0;
  clearInterval(timerId);
  timerId = 0;
  clearTimeout(msgTimer);
  msgTimer = 0;
  ticker?.terminate();
  ticker = null;
  observer?.disconnect();
  observer = null;
  window.removeEventListener("orientationchange", syncLayout);
  document.removeEventListener("visibilitychange", onVisibility);
  input?.unbind();
  input = null;
  // WebGL 资源挂在 GPU 上下文上，不 dispose 就是每次进出局泄漏一张场景
  threeView?.dispose();
  threeView = null;
  lookRate = 0;
  audio?.dispose();
  audio = null;
  game?.destroy?.();
  game = null;
  ctx = null;
  if (import.meta.env.DEV) delete window.delta;
});

if (import.meta.env.DEV) {
  window.deltaLayout = () => layout;
  window.deltaRelayout = syncLayout;
  /**
   * 全屏布局的验收探针：整屏层/画布格子/控制带各自的盒子，外加每个按钮的命中测试。
   * "看不见"和"点不动"是两件事——叠层吃掉点击在以前就真实发生过，所以这里一次都回读。
   */
  window.deltaBoxes = () => {
    const rect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const raid = document.querySelector(".raid");
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      device: document.documentElement.dataset.device,
      orientation: document.documentElement.dataset.orientation,
      raid: { ...rect(raid), position: raid ? getComputedStyle(raid).position : null },
      stack: rect(stackEl.value),
      pads: rect(document.querySelector(".pads")),
      canvas: rect(canvasEl.value),
      glCanvas: rect(glCanvasEl.value),
      buttons: [...document.querySelectorAll(".pads .act")].map((b) => {
        const r = b.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { label: b.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height), hit: hit === b || b.contains(hit) };
      }),
    };
  };
  /** 脚本里切视图与读视图状态：WebGL 起没起来、当前哪个视图，验证时都要能观测到 */
  window.deltaSetView = (mode) => setView(mode);
  window.deltaView = () => ({ mode: viewMode.value, gl: !!threeView, lookRadPerPx });
  /**
   * 直接回读 GL 帧缓冲的中心取样：内置浏览器在 hidden 页面里给不了截图（rAF 冻结、
   * 合成器不干活），"画面到底画出来没有"只能靠 readPixels 自己数亮像素。
   * readPixels 必须在同一轮任务里紧跟 render 调用，否则绘制缓冲可能已被丢弃。
   */
  window.deltaGlSample = (w = 96, h = 64) => {
    const glCanvas = glCanvasEl.value;
    const gl = glCanvas && (glCanvas.getContext("webgl2") ?? glCanvas.getContext("webgl"));
    if (!gl) return { ok: false, reason: "no gl context" };
    const rendered = !!(game && threeView);
    if (rendered) {
      threeView.sync(game, { phase: performance.now() / 1000 });
      threeView.render();
    }
    const x = Math.max(0, Math.floor((gl.drawingBufferWidth - w) / 2));
    const y = Math.max(0, Math.floor((gl.drawingBufferHeight - h) / 2));
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let lit = 0;
    const colors = new Set();
    for (let i = 0; i < buf.length; i += 4) {
      if (buf[i] + buf[i + 1] + buf[i + 2] > 12) lit += 1;
      colors.add(`${buf[i]},${buf[i + 1]},${buf[i + 2]}`);
    }
    const draw = threeView ? threeView.info() : null;
    return {
      ok: true,
      rendered,
      // 绘制回执：calls=0 说明这一帧根本没往这张画布上画；cam/lights 用来解释"画了但全黑"
      draw: draw ? { ...draw, domIsCanvas: draw.domElement === glCanvas } : null,
      lit,
      total: w * h,
      colors: colors.size,
      buffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
    };
  };
  window.deltaThree = () => threeView;
  /** 内置浏览器与后台标签拿不到 rAF，用这个入口按固定步长手工喂帧，验证推进、渲染与结算链路 */
  window.deltaFrames = (n = 60, stepMs = 16.7) => {
    let ts = performance.now();
    for (let i = 0; i < n; i += 1) {
      ts += stepMs;
      lastPump = ts;
      pump(ts);
    }
    return game ? { timeSec: Number(game.timeSec.toFixed(2)), status: game.status } : null;
  };
}
</script>

<template>
  <section class="raid" :class="[`phase-${phase}`, hud.timeSlot === 'night' ? 'night' : 'day']">
    <div class="bar">
      <p class="muted small">
        {{ DEVICE_LABEL[device.device] }} · 视口恒 28×18 m
      </p>
      <div class="wallet">
        <span class="chip">Lv.{{ save.level }}</span>
        <span class="chip">柯尔 {{ money(save.wallet) }}</span>
        <span class="chip">带出 {{ money(save.stats.bestRaidValue) }}</span>
        <button class="ghost" type="button" @click="toggleMute">{{ muted ? '已静音' : '静音' }}</button>
      </div>
    </div>

    <p v-if="!storageOk" class="warn">浏览器存储不可用，本次进度只留在当前页面。</p>

    <div v-if="phase === 'lobby'" class="lobby">
      <div class="maps">
        <button
          v-for="m in maps"
          :key="m.id"
          type="button"
          class="map"
          :class="{ on: m.id === mapId }"
          @click="mapId = m.id"
        >
          <strong>{{ m.name }}</strong>
          <span class="muted small">威胁 {{ m.tier }} · {{ m.timeSlot === 'night' ? '夜间' : '白天' }} · 限时 {{ Math.round(m.timeLimitSec / 60) }} 分 · 容器 {{ m.containers.length }}</span>
          <span class="small">{{ m.desc }}</span>
        </button>
      </div>

      <div class="gear">
        <div class="slots">
          <div v-for="slot in LOADOUT_SLOTS" :key="slot" class="slot">
            <span class="slot-label">{{ SLOT_LABEL[slot] }}</span>
            <template v-if="save.loadout[slot]">
              <span class="slot-value">{{ itemName(save.loadout[slot]) }}</span>
              <span v-if="slot === 'armor'" class="muted small">耐久 {{ save.loadout.armorDur }}</span>
              <button class="mini" type="button" @click="dropSlot(slot)">卸下</button>
            </template>
            <span v-else class="muted small">未装备</span>
            <div v-if="phase === 'lobby'" class="pick">
              <button
                v-for="entry in stashInSlot(slot).slice(0, 3)"
                :key="entry.key"
                class="mini"
                type="button"
                @click="equip(entry.key, slot)"
              >{{ itemName(entry.key) }}</button>
            </div>
          </div>
          <div class="slot">
            <span class="slot-label">弹药 / 医疗</span>
            <span class="slot-value">{{ save.loadout.ammo.kind ? itemName(save.loadout.ammo.kind) : '无弹药' }} ×{{ save.loadout.ammo.count }}</span>
            <span class="slot-value">医疗包 ×{{ save.loadout.meds }}</span>
          </div>
          <div class="slot">
            <span class="slot-label">技能</span>
            <button
              v-for="s in SKILLS"
              :key="s"
              class="mini"
              :class="{ on: save.loadout.skill === s }"
              type="button"
              @click="pickSkill(s)"
            >{{ s === 'smoke' ? '烟幕' : '脉冲' }}</button>
          </div>
        </div>

        <div class="shop">
          <div class="shop-head">
            <strong>黑市</strong>
            <span class="muted small">买价 = 价值 ×1.7，回收 = 价值 ×0.6</span>
          </div>
          <div class="shop-list">
            <button v-for="key in ['wp_smg', 'wp_shotgun', 'ar_light', 'ar_heavy', 'bg_mid', 'bg_large', 'md_medkit', 'am_9', 'am_556']" :key="key" class="goods" type="button" @click="buy(key, key.startsWith('am_') ? 30 : 1)">
              <span>{{ itemName(key) }}</span>
              <b>{{ money(ITEMS[key].value * 1.7) }}</b>
            </button>
          </div>
          <div class="shop-head"><strong>仓库</strong><span class="muted small">{{ save.stash.items.length }} / {{ save.stash.slots }} 格 · 保险箱 {{ save.safeBox.items.length }} / {{ save.safeBox.slots }}</span></div>
          <div class="shop-list">
            <button v-for="entry in save.stash.items" :key="entry.key" class="goods" type="button" @click="sell(entry.key, 1)">
              <span>{{ itemName(entry.key) }} ×{{ entry.qty }}</span>
              <b>+{{ money(ITEMS[entry.key].value * 0.6) }}</b>
            </button>
          </div>
        </div>
      </div>

      <div class="task">
        <strong>当前任务</strong>
        <span>{{ task?.label ?? '暂无' }}</span>
        <span class="muted small">进度 {{ save.tasks.got }} / {{ save.tasks.need }} · 奖励 柯尔 {{ task?.reward.wallet ?? 0 }}、经验 {{ task?.reward.xp ?? 0 }}</span>
      </div>

      <div class="launch">
        <p v-if="message" class="msg">{{ message }}</p>
        <p v-if="!readiness.ready" class="warn">出征还缺：{{ readiness.missing.join("、") }}</p>
        <div class="cta">
          <button class="primary" type="button" :disabled="!readiness.ready" @click="startRaid">进入 {{ currentMap.name }}</button>
          <button class="ghost" type="button" @click="autoEquip">一键配装</button>
        </div>
      </div>
      <p class="muted small rules">
        拖动屏幕（或 <kbd>WASD</kbd>）移动 · 轻点画布（或 <kbd>F</kbd>）搜刮 · <kbd>空格</kbd> 开关自动开火 ·
        <kbd>R</kbd> 换弹 · <kbd>H</kbd> 打药 · <kbd>Q</kbd> 技能 · <kbd>P</kbd> 暂停 · 站进绿圈 5 秒撤离。<b>阵亡或超时会丢掉身上全部装备与货物，只有保险箱留得住。</b>
        <br>
        <kbd>V</kbd> 或"第一人称"按钮切换视角：第一人称下左半屏拖动走路、右半屏拖动转身（<kbd>←</kbd> <kbd>→</kbd> 也能转身），左上角保留俯视小地图。
      </p>
    </div>

    <div v-show="phase === 'playing' || phase === 'paused' || phase === 'result'" ref="stageEl" class="stage">
      <div ref="stackEl" class="stack">
        <canvas ref="glCanvasEl" v-show="viewMode === 'fps'" class="board gl"></canvas>
        <canvas ref="canvasEl" class="board" :class="{ overlay: viewMode === 'fps' }"></canvas>
        <div v-if="viewMode === 'fps'" class="crosshair" aria-hidden="true"><i></i><b></b></div>
      </div>

      <div class="top">
        <span class="bar-hp"><i :style="{ width: `${(hud.hp / (hud.hpMax || 1)) * 100}%` }"></i></span>
        <span class="chip">{{ hud.weapon }} <b>{{ hud.mag }}</b>/{{ hud.magSize }} · {{ hud.ammoKind }} {{ hud.ammoReserve }}</span>
        <span class="chip" :class="{ warn: !hud.ammoMatched }">{{ hud.timeLeft }} s</span>
        <span class="chip">货 {{ hud.bagUsed }}/{{ hud.bagSlots }} · {{ money(hud.lootValue) }}</span>
        <span class="chip">防具 {{ hud.armorDur }}/{{ hud.armorMax }} · 击倒 {{ hud.kills }} · 剩敌 {{ hud.aiAlive }}</span>
      </div>
      <div v-if="hud.search" class="search">搜刮 {{ hud.search.label }} {{ Math.round((hud.search.progress / (hud.search.needed || 1)) * 100) }}%</div>
      <div v-if="hud.exfilNear" class="exfil">撤离中 {{ Math.round((hud.exfilProgress / (hud.exfilNeeded || 1)) * 100) }}%</div>
      <div v-if="hud.pulse" class="pulse">脉冲标记中</div>

      <div class="pads">
        <button class="act" :class="{ on: viewMode === 'fps' }" type="button" @click="toggleView">
          {{ viewMode === 'fps' ? '俯视' : '第一人称' }}
        </button>
        <button class="act" type="button" @click="onAction('interact')">搜刮</button>
        <button class="act" type="button" @click="onAction('reload')">换弹</button>
        <button class="act" type="button" @click="onAction('med')">打药 {{ hud.meds }}</button>
        <button class="act" :disabled="!hud.skill || hud.skill.usesLeft <= 0 || hud.skill.cooldown > 0" type="button" @click="onAction('skill')">
          {{ hud.skill ? `${hud.skill.label} ${hud.skill.usesLeft}` : '技能' }}
        </button>
        <button class="act" :class="{ on: hud.fireEnabled }" type="button" @click="onAction('fire-toggle')">开火</button>
        <button class="act" type="button" @click="pause">暂停</button>
        <button class="act quit" type="button" @click="quitRaid">返回</button>
      </div>

      <p v-if="message" class="msg stage-msg">{{ message }}</p>

      <div v-if="phase === 'paused'" class="cover">
        <div class="panel">
          <h2>已暂停</h2>
          <p class="muted">时限由引擎累加，暂停与切后台都不消耗。</p>
          <p class="muted small">
            {{ DEVICE_LABEL[device.device] }} · 视口恒 28×18 m · Lv.{{ save.level }} · 柯尔
            {{ money(save.wallet) }}
          </p>
          <button class="primary" type="button" @click="resume">继续</button>
          <div class="row">
            <button class="ghost" type="button" @click="toggleMute">{{ muted ? '已静音' : '静音' }}</button>
          </div>
          <button class="ghost" type="button" @click="quitRaid">中途返回</button>
        </div>
      </div>
    </div>

    <div v-if="phase === 'result' && ledger" class="result">
      <div class="panel" :class="ledgerTitle.tone">
        <h2>{{ ledgerTitle.title }}</h2>
        <p class="muted">{{ mapName(ledger.result.mapId) }} · 用时 {{ ledger.result.timeSec }} 秒 · 击倒 {{ ledger.result.kills }} · 搜刮 {{ ledger.result.searched }} 箱</p>
        <ul v-if="ledger.kept.length">
          <li v-for="entry in ledger.kept" :key="`k-${entry.key}`">带回 {{ itemName(entry.key) }} ×{{ entry.qty }}</li>
        </ul>
        <ul v-if="ledger.lost.length" class="bad">
          <li v-for="entry in ledger.lost" :key="`l-${entry.key}`">失去 {{ itemName(entry.key) }} ×{{ entry.qty }}</li>
        </ul>
        <ul v-if="ledger.droppedForOverload.length" class="bad">
          <li v-for="entry in ledger.droppedForOverload" :key="`d-${entry.key}`">仓库装不下，遗落在战场：{{ entry.label ?? itemName(entry.key) }} ×{{ entry.qty }}</li>
        </ul>
        <p v-if="ledger.reissued?.length" class="muted small">部队补发：{{ ledger.reissued.map((e) => `${e.label ?? itemName(e.key)} ×${e.qty}`).join('、') }}</p>
        <p v-if="ledger.taskDone" class="good">任务完成：{{ ledger.taskDone.label }} +{{ ledger.taskDone.reward.wallet }} 柯尔</p>
        <p v-if="ledger.levelUp" class="good">等级 {{ ledger.levelUp.from }} → {{ ledger.levelUp.to }}（保险箱格子会变多）</p>
        <p class="chip">经验 +{{ ledger.xpGained }} · 柯尔 {{ ledger.walletDelta >= 0 ? '+' : '' }}{{ ledger.walletDelta }} · 当前 {{ money(save.wallet) }}</p>
        <div class="cta">
          <button class="primary" type="button" @click="backToLobby">回藏身处</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.raid {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
  max-width: 1100px;
  margin: 0 auto;
  padding: 0 var(--gutter) calc(env(safe-area-inset-bottom) + 18px);
  /* 藏身处的配装+黑市比一屏长：不给滚动条，手机上「进入」按钮直接被裁到屏幕外面 */
  overflow-y: auto;
  overscroll-behavior: contain;
}

/*
 * 局内三态整块钉成全屏层。站点栏与游戏标题栏只是被盖在身后，画布因此才拿得到整屏高度：
 * 竖屏 390 px 宽的手机上，画布从 154×240（每米 8.6 px，人形 6 px）变成 390×607（每米 21.7 px）。
 * 父链上没有 transform/filter，fixed 的包含块就是视口；padding 走 safe-area，刘海与圆角不吃画面。
 */
.raid.phase-playing,
.raid.phase-paused,
.raid.phase-result {
  position: fixed;
  inset: 0;
  z-index: 30;
  max-width: none;
  gap: 0;
  overflow: hidden;
  padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom)
    env(safe-area-inset-left);
  background: var(--bg);
}

/* 设备标签与钱包条在局内只会白吃首屏高度，同样的数 HUD 上已经有了 */
.phase-playing .bar,
.phase-paused .bar,
.phase-result .bar,
.phase-playing .warn,
.phase-paused .warn {
  display: none;
}

.bar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.bar h1 {
  font-size: clamp(18px, 3.4vw, 24px);
  margin: 0;
}

.wallet {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}

.small {
  font-size: 12px;
}

.chip {
  padding: 4px 8px;
  border-radius: 8px;
  background: var(--bg-soft);
  font-size: 12px;
  white-space: nowrap;
}

.chip.warn {
  color: #f87171;
}

.ghost,
.mini,
.act,
.primary {
  min-height: 32px;
  padding: 6px 10px;
  border-radius: 10px;
  border: 1px solid var(--line, rgba(255, 255, 255, 0.12));
  background: var(--bg-soft);
  color: var(--text, #e6edf7);
  font-size: 13px;
  cursor: pointer;
}

.primary {
  background: var(--accent);
  color: #08111c;
  border-color: transparent;
  font-weight: 600;
}

.primary:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.act.on {
  border-color: var(--accent);
  color: var(--accent);
}

.lobby {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.maps {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr));
  gap: 10px;
}

.map {
  display: flex;
  flex-direction: column;
  gap: 4px;
  text-align: left;
  padding: 12px;
  border-radius: 14px;
  border: 1px solid var(--line, rgba(255, 255, 255, 0.12));
  background: var(--bg-soft);
  color: inherit;
  cursor: pointer;
}

.map.on {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent) inset;
}

.gear {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr));
  gap: 12px;
}

.slots,
.shop {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border-radius: 14px;
  background: var(--bg-soft);
}

.slot {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding-bottom: 6px;
  border-bottom: 1px dashed rgba(255, 255, 255, 0.08);
}

.slot-label {
  font-size: 12px;
  color: var(--text-muted);
  min-width: 68px;
}

.slot-value {
  font-size: 13px;
}

.pick {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.shop-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.shop-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.goods {
  display: flex;
  gap: 6px;
  align-items: center;
  min-height: 40px;
  padding: 6px 8px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 12px;
}

.goods b {
  color: var(--accent);
}

.task {
  display: flex;
  gap: 10px;
  align-items: baseline;
  flex-wrap: wrap;
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--bg-soft);
}

.msg {
  margin: 0;
  color: var(--accent);
  font-size: 13px;
}

.warn {
  margin: 0;
  color: #f0b072;
  font-size: 13px;
}

.cta {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

/*
 * 藏身处（地图 + 配装 + 黑市 + 仓库 + 任务）在 390×844 竖屏上约 1224 px 高，一屏装不下，
 * 出征按钮因此落在首屏之外。整块吸底常驻，缺装备的提示也一起挂在上面，
 * 滑到 .rules 时自然归位。渐变底是为了压住从按钮缝里漏上来的滚动内容。
 */
.launch {
  position: sticky;
  bottom: 0;
  z-index: 4;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 0 4px;
  background: linear-gradient(180deg, rgba(11, 18, 32, 0), var(--bg) 42%);
}

.cta .primary {
  min-height: 48px;
  padding: 10px 18px;
}

.row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.rules {
  margin: 0;
  line-height: 1.7;
}

kbd {
  padding: 1px 5px;
  border-radius: 5px;
  background: var(--bg-soft);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
}

.stage {
  position: relative;
  width: 100%;
  /* 画布高度全靠这里要：以前只有 min-height:240px，canvasBox 内接完就是 154×240 的一条 */
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  touch-action: none;
  /* 控制带的高度：提示条要避开它，所以做成变量而不是到处写死 bottom */
  --pads-h: 56px;
}

.board {
  display: block;
  background: #141b25;
}

/* 两张画布占同一个格子才能叠：GL 在下、2D 在上（小地图要看得见），准星再上一层 */
.stack {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  justify-items: center;
  align-items: center;
}

.stack > canvas {
  grid-area: 1 / 1;
}

.gl {
  z-index: 1;
}

.overlay {
  z-index: 2;
  background: transparent;
}

.crosshair {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 22px;
  height: 22px;
  transform: translate(-50%, -50%);
  z-index: 3;
  pointer-events: none;
}

.crosshair i,
.crosshair b {
  position: absolute;
  background: rgba(230, 240, 250, 0.82);
  border-radius: 1px;
}

.crosshair i {
  left: 50%;
  top: 0;
  width: 1.5px;
  height: 100%;
  transform: translateX(-50%);
}

.crosshair b {
  top: 50%;
  left: 0;
  height: 1.5px;
  width: 100%;
  transform: translateY(-50%);
}

.top {
  position: absolute;
  inset: 6px 6px auto;
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
  pointer-events: none;
  z-index: 5;
}

.bar-hp {
  width: 92px;
  height: 10px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.14);
  overflow: hidden;
}

.bar-hp i {
  display: block;
  height: 100%;
  background: #7ee787;
}

.search,
.exfil,
.pulse {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  /* 顶部留给 HUD 换行（手机上标签能到三四行），进度条改贴在控制带上方，拇指和视线都在那儿 */
  top: auto;
  bottom: calc(var(--pads-h) + 46px);
  padding: 4px 10px;
  border-radius: 10px;
  background: rgba(10, 15, 24, 0.72);
  font-size: 13px;
  pointer-events: none;
  z-index: 5;
}

.pulse {
  bottom: calc(var(--pads-h) + 76px);
  color: #4ac1ff;
}

.exfil {
  color: #7ee787;
}

/* 局内提示条：叠层画布盖住整块场区（z-index 2），提示要压在它上面才看得见 */
.stage-msg {
  position: absolute;
  left: 50%;
  bottom: calc(var(--pads-h) + 10px);
  transform: translateX(-50%);
  max-width: 86%;
  padding: 6px 12px;
  border-radius: 10px;
  background: rgba(10, 15, 24, 0.86);
  text-align: center;
  pointer-events: none;
  z-index: 6;
}

.pads {
  /* 从"绝对浮在画布上"改成画布下方的常驻控制带：8 个按钮压在 154 px 宽的画布上会竖到 4 行，
     整个战场被自己的手指盖住——这是手机上没法玩的第二个原因。 */
  flex: 0 0 auto;
  height: var(--pads-h);
  display: grid;
  grid-template-columns: repeat(8, minmax(0, 1fr));
  gap: 6px;
  padding: 6px;
  background: #0e1522;
  /* 仍然要压过两张画布：fps 下 2D 叠层是 z-index:2，命中测试按绘制顺序而非像素透明度，
     控件留在 auto 会被整块画布吃掉点击——切进第一人称后连切回来的按钮都点不动（实测）。 */
  z-index: 5;
}

.act {
  min-height: 44px;
  padding: 4px;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.act.quit {
  color: #f87171;
}

.cover {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(8, 12, 20, 0.72);
  /* 暂停面板里的"继续/中途返回"也是按钮，同样要压过 fps 的叠层画布 */
  z-index: 6;
}

.panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px;
  border-radius: 16px;
  background: var(--bg-soft, #1b2431);
  max-width: 92%;
}

.panel h2 {
  margin: 0;
  font-size: 20px;
}

.panel.good,
.result .good {
  color: #7ee787;
}

.result {
  /* 全屏层里结算必须做成叠层：它是 .stage 的兄弟节点，留在流里会被 flex:1 的画布顶出屏幕 */
  position: absolute;
  inset: 0;
  z-index: 8;
  display: flex;
  /* 居中交给 .panel 的 margin:auto：一长串战利品时 align-items:center 会把标题顶到滚动区上沿之外，滚不回去 */
  padding: 16px;
  overflow-y: auto;
  overscroll-behavior: contain;
  background: rgba(6, 10, 17, 0.74);
}

.result .panel {
  margin: auto;
}

/* 战利品多到溢出时，「回藏身处」仍要一眼可见、一按就到 */
.result .cta {
  position: sticky;
  bottom: 0;
}

.result ul {
  margin: 0;
  padding-left: 18px;
  font-size: 13px;
  line-height: 1.7;
}

.result .bad li {
  color: #f87171;
}

.phase-result .stage {
  opacity: 0.35;
}

html[data-device="phone"] .top {
  font-size: 11px;
  gap: 4px;
  /* 右上角是小地图（minimapSize 72 逻辑 px，手机上≈65 CSS px）：标签铺满整宽会把它整个盖住 */
  right: 84px;
}

html[data-device="phone"] .gear {
  grid-template-columns: 1fr;
}

/* 竖屏手机宽度只够 4 个按钮一行，控制带让出两行高度；画布仍按 18×28 m 内接，宽度铺满 */
html[data-device="phone"] .stage {
  --pads-h: 106px;
}

html[data-device="phone"] .pads {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

/* 横屏手机高度太矮（≈390 px），两行控制带会吃掉三分之一屏幕，改回一行 */
html[data-device="phone"][data-orientation="landscape"] .stage {
  --pads-h: 56px;
}

html[data-device="phone"][data-orientation="landscape"] .pads {
  grid-template-columns: repeat(8, minmax(0, 1fr));
}

/* 暂停/结算面板里的幽灵按钮：默认 32 px 高在手机上只有 33 px 实测触点，够不上拇指 */
html[data-device="phone"] .ghost,
html[data-device="phone"] .primary {
  min-height: 44px;
}
</style>
