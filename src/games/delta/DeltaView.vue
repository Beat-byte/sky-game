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
const moveSeatEl = ref(null);
const lookSeatEl = ref(null);
/**
 * 可见摇杆：输入层把当前那根手指所在摇杆的画布内坐标报上来，这里只负责画圈。
 * 它 pointer-events:none，手指照样落在画布上 —— 可视化不能把触控吃掉。
 * move 是左下"前进后退"，look 是右下"转身"；没有固定座的档位只用 move（浮动那枚）。
 */
const stickPad = reactive({ active: false, originX: 0, originY: 0, knobX: 0, knobY: 0, radius: 58 });
const lookPad = reactive({ active: false, originX: 0, originY: 0, knobX: 0, knobY: 0, radius: 58 });
/** 两枚固定座在画布内的几何（画布 CSS 像素）；null 表示当前档位不铺固定摇杆，退回浮动 */
const padRigs = ref(null);
/** 画布在 .stack 里的实际盒（横屏 full-bleed 后仍有左右留白，摇杆坐标要按画布原点算） */
const boardBox = ref({ width: 0, height: 0 });
/** 扳机按下的视觉态：引擎那份 triggerHeld 是游戏状态，这里的是"手指还压着没有" */
const triggerHeld = ref(false);
/** 视图模式：topdown 是原来的 2D 俯视，fps 走 three 的 WebGL；两者共用同一个引擎与同一条主循环 */
const viewMode = ref("topdown");
const hud = reactive({});
const phase = ref("lobby");
/**
 * 竖屏「请横屏」引导：横屏才有铺满整屏的画布与右侧那枚按住开火的圆钮，竖屏只能带着控制带玩。
 * 网页不能替玩家锁定方向（`screen.orientation.lock` 只在 Android 全屏里有效，iOS 直接抛错），
 * 所以这里做的是"出征前拦一道、讲清楚、让玩家自己转"：转成横屏当场放行，坚持竖屏也行，
 * "不再提示"走 store.setPref（持久化只有这一条路，组件不许碰 localStorage）。
 */
const landscapeHint = ref(false);
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
/** 转向速率（-1..1），分两个来源：键盘（±1）与横屏右摇杆（连续量），各自按各自的角速度积分 */
let lookKeyRate = 0;
let lookStickRate = 0;
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

function startRaid(skipHint = false) {
  if (!readiness.value.ready) {
    message.value = `出征还缺：${readiness.value.missing.join("、")}`;
    return;
  }
  // 模板里是 @click="startRaid"，会把 PointerEvent 当第一个参数递进来，所以只认字面量 true
  if (skipHint !== true && wantsLandscapeHint()) {
    landscapeHint.value = true;
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
  // 新局是全新的引擎实例，扳机与摇杆的视觉态必须跟着清零
  triggerHeld.value = false;
  stickPad.active = false;
  lookPad.active = false;
  lookKeyRate = 0;
  lookStickRate = 0;
  audio?.unlock();
  syncHud(true);
  phase.value = "playing";
  message.value = "";
  void rebindView();
}

/** 只有手机竖屏、且没点过"不再提示"才拦：平板/桌面本来就没有横屏一说，不许弹 */
function wantsLandscapeHint() {
  return device.device === "phone" && device.orientation === "portrait" && prefs.value.deltaLandscapeHintOff !== true;
}

function startInPortrait() {
  landscapeHint.value = false;
  startRaid(true);
}

function neverAskLandscapeHint() {
  store.setPref("deltaLandscapeHintOff", true);
  startInPortrait();
}

/** 关掉引导但不进局：玩家可能只是想回藏身处换把枪 */
function closeLandscapeHint() {
  landscapeHint.value = false;
}

// 引导开着的时候把手机转横了，就当场放行 —— 这一步不该要玩家再点一次出征
watch(
  () => device.orientation,
  (next) => {
    if (landscapeHint.value && next !== "portrait") {
      landscapeHint.value = false;
      startRaid(true);
    }
  }
);

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

/**
 * 手机＝和平精英式固定双摇杆：座子常显、钉在画布下沿两角，判定圈由 syncLayout 现场量座子得到。
 * 平板/桌面不铺座子（量到 0×0 → `getPads()` 交 null → 输入层自动退回浮动摇杆），
 * 那两档本来就有键盘，不该在战场上画两个大圈。
 */
const isFixedStickLayout = computed(() => device.device === "phone");

/**
 * 扳机只有一条规矩：按下与松开必须成对，任何中断路径（暂停、切视图、卸载、页面隐藏）
 * 都要走这里补一次 false，否则恢复游戏就变成无限连发。
 */
function pressTrigger(pressed) {
  triggerHeld.value = Boolean(pressed);
  game?.setTrigger(triggerHeld.value);
}

/** 外圈以按下点为心（浮动档），旋钮按输入层夹过的位移贴过去；固定座档原点点就是座心，同一套偏移照用 */
const stickStyle = computed(() => ({
  left: `${stickPad.originX}px`,
  top: `${stickPad.originY}px`,
  width: `${stickPad.radius * 2}px`,
  height: `${stickPad.radius * 2}px`,
}));
const knobStyle = computed(() => ({
  transform: `translate(calc(-50% + ${stickPad.knobX - stickPad.originX}px), calc(-50% + ${stickPad.knobY - stickPad.originY}px))`,
}));
const lookKnobStyle = computed(() => ({
  transform: `translate(calc(-50% + ${lookPad.knobX - lookPad.originX}px), calc(-50% + ${lookPad.knobY - lookPad.originY}px))`,
}));

function pause() {
  if (phase.value !== "playing") return;
  phase.value = "paused";
  setStick(0, 0);
  pressTrigger(false);
  lookKeyRate = 0;
  lookStickRate = 0;
  // 暂停后没人再消费摇杆量：两枚座的旋钮必须弹回中心，否则恢复第一眼看到的就是"还推着"
  stickPad.active = false;
  lookPad.active = false;
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
 * 右摇杆满偏角速度：5.5 rad/s ≈ 315°/s。比键盘慢是因为拇指推满是"贴着屏幕划到座沿"，
 * 全程满偏的手势比按一个键长得多，快了会直接转过头；死区内的微量由输入层归零。
 */
const LOOK_STICK_RATE = 5.5;

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
  // 转向速率按 dt 积分成"这一帧转多少弧度"，塞进引擎的待消化转向。
  // 俯视现在也吃这条通道（站着不动只转身 = 右下那枚摇杆）；拖动转向在 onLook 里已经直接塞过。
  if (lookKeyRate !== 0) game.setLook(lookKeyRate * LOOK_KEY_RATE * dt);
  if (lookStickRate !== 0) game.setLook(lookStickRate * LOOK_STICK_RATE * dt);
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

/**
 * 量两枚固定摇杆座（画布内 CSS 像素，含半径）。座子的位置与大小唯一来源是 CSS：
 * 只有手机档（横屏与竖屏）把它们 display 打开，平板/桌面 rect 恒 0×0 → 返回 null，
 * 输入层随即退回"按在哪长在哪"的浮动摇杆。这样判定圈与画出来的圈永远同一个圆，
 * 不会出现看得见的在左下角、摸得到的在屏幕中间。
 */
function measureSeats(canvas) {
  const c = canvas.getBoundingClientRect();
  const seatOf = (el) => {
    if (!el) return null;
    const box = el.getBoundingClientRect();
    if (box.width < 24 || box.height < 24) return null;
    return { x: box.left - c.left + box.width / 2, y: box.top - c.top + box.height / 2, r: Math.min(box.width, box.height) / 2 };
  };
  const move = seatOf(moveSeatEl.value);
  const look = seatOf(lookSeatEl.value);
  return move && look ? { move, look } : null;
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
  // 摇杆圈要按画布原点定位：横屏 full-bleed 后画布两侧仍有留白，用 .stack 的原点会偏
  boardBox.value = { width: css.width, height: css.height };
  padRigs.value = measureSeats(canvas);
  /**
   * `.padlayer` 的宽高是绑在 boardBox 上的，Vue 要到下一拍才把它写进 DOM ——
   * 而座子是按 `.padlayer` 的下沿定位的，所以在这一拍立刻量会拿到**上一版盒子**里的座子，
   * 转屏/重开局那一下判定圆就会整体偏移（实测座心 72 报成 87.5）。
   * 先按现状量一次保证任何时候都有圆可用，再等 DOM 落地重量一次。
   */
  nextTick(() => {
    if (canvas.isConnected) padRigs.value = measureSeats(canvas);
  });
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
    // 转向的两条通道：拖动给像素增量（这里换算成弧度），键盘与右摇杆给速率（pump 里按 dt 积分）
    isFps: () => viewMode.value === "fps",
    onLook: (dxPx) => game?.setLook(dxPx * lookRadPerPx),
    onLookRate: (dir, source) => {
      // 来源分开记：键盘是 ±1 档位、摇杆是连续量，角速度不同；不带来源=全局归零（失焦/隐藏/卸载）
      if (source === "stick") lookStickRate = dir;
      else if (source === "key") lookKeyRate = dir;
      else {
        lookKeyRate = 0;
        lookStickRate = 0;
      }
    },
    // 摇杆可视化：坐标是画布 CSS 像素，按 zone 分流到两个座上画旋钮（都不吃触控）
    onStickPad: (pad) => {
      Object.assign(pad.zone === "look" ? lookPad : stickPad, pad);
    },
    // 固定双摇杆档（手机档，横屏与竖屏）才有；量不到座子就交 null，输入层退回浮动摇杆
    getPads: () => padRigs.value,
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
  if (document.hidden) {
    // 页面被切走后再也没有 pointerup 了：扳机与摇杆在这里自己收尾，回来才不会无限连发
    pressTrigger(false);
    stickPad.active = false;
    lookPad.active = false;
    lookKeyRate = 0;
    lookStickRate = 0;
    return;
  }
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
  // unbind 里的 cancelAll 只清引擎侧向量；扳机与摇杆是 DOM 态，这里自己收尾
  triggerHeld.value = false;
  stickPad.active = false;
  lookPad.active = false;
  padRigs.value = null;
  // WebGL 资源挂在 GPU 上下文上，不 dispose 就是每次进出局泄漏一张场景
  threeView?.dispose();
  threeView = null;
  lookKeyRate = 0;
  lookStickRate = 0;
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
      pads: { ...rect(document.querySelector(".pads")), position: getComputedStyle(document.querySelector(".pads")).position, pointerEvents: getComputedStyle(document.querySelector(".pads")).pointerEvents },
      canvas: rect(canvasEl.value),
      glCanvas: rect(glCanvasEl.value),
      /** 浮层化之后画布必须铺满可用高度，控制带不再占位；这两条是"有没有 full-bleed"的判据 */
      padsHeightVar: getComputedStyle(document.querySelector(".stage")).getPropertyValue("--pads-h").trim(),
      /** 两枚固定座与浮动圈的盒子：手机档两座必须都在画面下沿（横屏贴屏幕、竖屏贴画布），量不到就是没铺双摇杆 */
      seatMove: rect(moveSeatEl.value),
      seatLook: rect(lookSeatEl.value),
      floatingStick: rect(document.querySelector(".stick:not(.seat)")),
      /** 输入层实际拿到的判定圆（画布内坐标）：与座子盒子对不上就是"看得见摸不着" */
      rigs: padRigs.value ? JSON.parse(JSON.stringify(padRigs.value)) : null,
      buttons: [...document.querySelectorAll(".pads .act")].map((b) => {
        const r = b.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { label: b.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height), hit: hit === b || b.contains(hit) };
      }),
      /** 空白处必须还给画布：浮层容器若吃掉触控，摇杆与转身当场失效 */
      bareCanvasHit: (() => {
        const el = canvasEl.value;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const probe = document.elementFromPoint(r.left + r.width * 0.25, r.top + r.height * 0.5);
        return probe === el || el.contains(probe);
      })(),
    };
  };
  /** 摇杆可视化与扳机态：验证"推上就前进""推右就转身""按住才开火"时要能同时读到 DOM 与引擎两侧 */
  window.deltaStick = () => ({
    dom: { move: { ...stickPad }, look: { ...lookPad } },
    rigs: padRigs.value ? JSON.parse(JSON.stringify(padRigs.value)) : null,
    rates: { key: lookKeyRate, stick: lookStickRate },
    engine: game ? { stick: { ...game.stick }, angle: game.player.angle, turned: game.turnedThisStep } : null,
  });
  window.deltaLook = (dir) => {
    if (dir === undefined) return { key: lookKeyRate, stick: lookStickRate, angle: game?.player.angle ?? null, pending: game?.lookPending ?? null };
    // 探针直接写速率变量（与输入层回调同一个落点），不冒充回调函数
    lookStickRate = Math.max(-1, Math.min(1, Number(dir) || 0));
    return { stick: lookStickRate, angle: game?.player.angle ?? null, pending: game?.lookPending ?? null };
  };
  window.deltaTrigger = (pressed) => {
    pressTrigger(pressed);
    return { dom: triggerHeld.value, engine: game ? game.triggerHeld : null };
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
        拖动屏幕（或 <kbd>WASD</kbd>）移动 · 轻点画布（或 <kbd>F</kbd>）搜刮 · <b>按住"开火"键</b>射击（<kbd>空格</kbd> 切换自动开火）·
        <kbd>R</kbd> 换弹 · <kbd>H</kbd> 打药 · <kbd>Q</kbd> 技能 · <kbd>P</kbd> 暂停 · 站进绿圈 5 秒撤离。<b>阵亡或超时会丢掉身上全部装备与货物，只有保险箱留得住。</b>
        <br>
        <kbd>V</kbd> 或"第一人称"按钮切换视角：第一人称下左半屏走路、右半屏转身（<kbd>←</kbd> <kbd>→</kbd> 也能转身），左上角保留俯视小地图。俯视下站着不动也能只用右摇杆转身。
        <template v-if="isFixedStickLayout"><br>手机端＝和平精英式双摇杆：两枚座子<b>默认就显示</b>在画面下沿的左右两角（横屏贴屏幕下沿），位置钉死不会跟着手指跑 —— 左杆推=前进后退/横移，右杆推=转身（只认左右，上下不影响，这引擎没有俯仰）；座子之外的右半屏照样能拖动细瞄，横屏时右侧中部那枚圆钮按住就开火。</template>
      </p>
    </div>

    <div v-show="phase === 'playing' || phase === 'paused' || phase === 'result'" ref="stageEl" class="stage">
      <div ref="stackEl" class="stack">
        <canvas ref="glCanvasEl" v-show="viewMode === 'fps'" class="board gl"></canvas>
        <canvas ref="canvasEl" class="board" :class="{ overlay: viewMode === 'fps' }"></canvas>
        <div v-if="viewMode === 'fps'" class="crosshair" aria-hidden="true"><i></i><b></b></div>
        <!-- 摇杆与分区提示只"画"在画面上：pointer-events:none，手指照样落在画布上 -->
        <div class="padlayer" :style="{ width: `${boardBox.width}px`, height: `${boardBox.height}px` }">
          <!-- 平板/桌面（没有固定座）：浮动摇杆，按在哪长在哪 -->
          <div v-if="stickPad.active && !isFixedStickLayout" class="stick" :style="stickStyle" aria-hidden="true">
            <b :style="knobStyle"></b>
          </div>
          <!-- 手机＝和平精英那套：两枚座子常显并钉在画布下沿两角，左手前进后退、右手转身，
               座子不动、旋钮跟手指；判定圈由 syncLayout 量这两枚元素得到，画与摸同一个圆 -->
          <div ref="moveSeatEl" class="stick seat" :class="{ on: stickPad.active }" aria-hidden="true">
            <b :style="knobStyle"></b><span>移动</span>
          </div>
          <div ref="lookSeatEl" class="stick seat look" :class="{ on: lookPad.active }" aria-hidden="true">
            <b :style="lookKnobStyle"></b><span>转身</span>
          </div>
        </div>
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
        <div class="cluster nav">
          <button class="act" :class="{ on: viewMode === 'fps' }" type="button" @click="toggleView">
            {{ viewMode === 'fps' ? '俯视' : '第一人称' }}
          </button>
          <button class="act" type="button" @click="pause">暂停</button>
          <button class="act quit" type="button" @click="quitRaid">返回</button>
        </div>
        <div class="cluster fight">
          <button class="act" type="button" @click="onAction('interact')">搜刮</button>
          <button class="act" type="button" @click="onAction('med')">打药 {{ hud.meds }}</button>
          <button class="act" type="button" @click="onAction('reload')">换弹</button>
          <button class="act" :disabled="!hud.skill || hud.skill.usesLeft <= 0 || hud.skill.cooldown > 0" type="button" @click="onAction('skill')">
            {{ hud.skill ? `${hud.skill.label} ${hud.skill.usesLeft}` : '技能' }}
          </button>
          <!-- 按住才开火（吃鸡那套扳机）：抬手、手指滑出、系统中断都算松手，漏一次就是无限连发 -->
          <button
            class="act fire"
            :class="{ held: triggerHeld }"
            type="button"
            @pointerdown.prevent="pressTrigger(true)"
            @pointerup="pressTrigger(false)"
            @pointercancel="pressTrigger(false)"
            @pointerleave="pressTrigger(false)"
            @contextmenu.prevent
          >
            <span class="fire-label">开火</span>
            <span class="fire-mag">{{ hud.mag }}</span>
          </button>
        </div>
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

    <!-- 竖屏出征前的横屏引导：fixed 盖住整屏（藏身处是流式布局，.cover 那套 absolute 在这儿不生效） -->
    <div v-if="landscapeHint" class="rotate-hint" role="dialog" aria-modal="true" aria-label="建议转成横屏">
      <div class="panel">
        <h2>建议转成横屏</h2>
        <p class="muted">横屏画布铺满整屏，比竖屏那条控制带多看 36% 战场；左下摇杆座走路、右下摇杆座转身，右侧中部那枚圆钮按住就开火。</p>
        <p class="muted small">网页不能替你锁定方向：请在系统里打开自动旋转，或直接把手机转横 —— 转过来就立刻进局。竖屏照样能玩，两枚座子一样钉在画面下沿、位置不动。</p>
        <button class="primary" type="button" @click="startInPortrait">继续竖屏进入</button>
        <div class="row">
          <button class="ghost" type="button" @click="neverAskLandscapeHint">不再提示并进入</button>
          <button class="ghost" type="button" @click="closeLandscapeHint">先回藏身处</button>
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

/* 竖屏/平板/桌面用 display:contents：按钮直接落进 .pads 那张网格里，分区只是 DOM 语义 */
.cluster {
  display: contents;
}

/* 摇杆画在画布之上、控件之下：它自己不吃触控，坐标原点与画布左上角对齐 */
.padlayer {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  z-index: 4;
  pointer-events: none;
}

.stick {
  position: absolute;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  border: 1.5px solid rgba(230, 240, 250, 0.34);
  background: rgba(10, 15, 24, 0.22);
}

.stick b {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: rgba(126, 231, 135, 0.46);
  border: 1.5px solid rgba(230, 240, 250, 0.72);
}

/*
 * 固定摇杆座（手机的两枚）：非手机档位不显示 —— 平板/桌面量到 0×0，
 * measureSeats 直接交 null，输入层就退回"按在哪长在哪"的浮动摇杆（那两档有键盘）。
 * 座子的直径就是判定半径×2（syncLayout 量的正是这个盒子），画与摸同一个圆。
 */
.stick.seat {
  display: none;
  transform: none;
  width: 128px;
  height: 128px;
}

.stick.seat span {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  font-size: 11px;
  letter-spacing: 1px;
  color: rgba(230, 240, 250, 0.42);
}

/* 按下时座子亮一点，玩家知道这根手指归哪个摇杆管 */
.stick.seat.on {
  border-color: rgba(230, 240, 250, 0.6);
  background: rgba(10, 15, 24, 0.4);
}

.stick.seat.on span {
  color: rgba(230, 240, 250, 0.62);
}

.fire {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.fire-mag {
  font-variant-numeric: tabular-nums;
  opacity: 0.8;
}

.act.fire.held {
  background: #f2703f;
  border-color: #ffd6be;
  color: #14100c;
}

/*
 * 横屏引导层：藏身处是流式布局、全屏层 .raid 是 fixed，两种形态都要被压住，
 * 所以它自己只能 fixed，z-index 高过 .raid。竖屏时它出现在屏幕正中，
 * 玩家转成横屏由 watch(device.orientation) 当场放行，不必再点一次出征。
 */
.rotate-hint {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(6, 10, 17, 0.82);
}

.rotate-hint .panel {
  max-width: min(420px, 92%);
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

/*
 * 手机横屏＝和平精英式双摇杆（有意推翻"控制带不进浮层"的旧结论，理由记在 docs/rules/delta.md）：
 * 旧版是一条 56 px 控制带 —— 画布被顶到 334 px 高、8 个等宽小格排一行、开火只是"切换"、
 * 摇杆完全看不见。横屏本来就只有 390 px 高，再让出一条带等于把战场压成缩略图。
 * 现形态：画布 full-bleed（--pads-h: 0）＋ 两枚摇杆座钉在屏幕下沿 ＋ 右侧中部开火圆钮。
 * 命门有两条：① .pads 容器 pointer-events:none、按钮各自 auto —— 空白处仍然归画布；
 * ② 判定圈由 syncLayout 量这两枚座子得到 —— 看得见的圆和摸得到的圆是同一个，
 *    绝不出现"控件在中间、拇指在底下"。
 */
html[data-device="phone"][data-orientation="landscape"] .stage {
  --pads-h: 0px;
}

html[data-device="phone"][data-orientation="landscape"] .pads {
  position: absolute;
  inset: 0;
  height: auto;
  display: block;
  gap: 0;
  padding: 0;
  background: transparent;
  pointer-events: none;
}

html[data-device="phone"][data-orientation="landscape"] .cluster {
  display: flex;
  gap: 6px;
  pointer-events: auto;
}

/* 导航簇（视角/暂停/返回）在左上，HUD 标签整排下移让位；小地图仍在右上角不动 */
html[data-device="phone"][data-orientation="landscape"] .cluster.nav {
  position: absolute;
  left: calc(8px + env(safe-area-inset-left));
  top: calc(8px + env(safe-area-inset-top));
}

html[data-device="phone"][data-orientation="landscape"] .cluster.nav .act {
  min-height: 44px;
  padding: 0 10px;
  font-size: 12px;
  background: rgba(14, 21, 34, 0.78);
}

html[data-device="phone"][data-orientation="landscape"] .top {
  top: 58px;
}

/*
 * 手机＝两枚座子常显、位置钉死（和平精英那套）：竖屏贴在画布下沿左右两角 —— 控制带在画布下方
 * 另占一条 106 px，两者的盒子不重叠；横屏画布铺满整屏，座子就是屏幕下沿。
 * 判定圈由 syncLayout 量这两枚盒子得到，所以改这里的 left/bottom/width 就自动改了手感。
 */
html[data-device="phone"] .stick.seat {
  display: block;
  left: calc(8px + env(safe-area-inset-left));
  bottom: calc(8px + env(safe-area-inset-bottom));
}

html[data-device="phone"] .stick.seat.look {
  left: auto;
  right: calc(8px + env(safe-area-inset-right));
}

/* 横屏拇指根落在屏幕角上，座子往外让 6 px 并按安全区避让（特异度必须压过上面那条 .look） */
html[data-device="phone"][data-orientation="landscape"] .stick.seat {
  left: calc(14px + env(safe-area-inset-left));
  bottom: calc(14px + env(safe-area-inset-bottom));
}

html[data-device="phone"][data-orientation="landscape"] .stick.seat.look {
  left: auto;
  right: calc(14px + env(safe-area-inset-right));
}

/* 功能键 2×2 ＋ 右侧中部开火：整簇抬到转身座上方，互不吃触控（和平精英的开火就在这个位置） */
html[data-device="phone"][data-orientation="landscape"] .cluster.fight {
  position: absolute;
  right: calc(14px + env(safe-area-inset-right));
  bottom: calc(150px + env(safe-area-inset-bottom));
  display: grid;
  grid-template-columns: repeat(2, 50px) 84px;
  grid-template-rows: repeat(2, 50px);
  gap: 8px;
}

html[data-device="phone"][data-orientation="landscape"] .cluster.fight .act {
  width: 50px;
  min-height: 50px;
  padding: 0;
  border-radius: 14px;
  font-size: 12px;
  background: rgba(14, 21, 34, 0.78);
}

html[data-device="phone"][data-orientation="landscape"] .cluster.fight .act.fire {
  grid-column: 3;
  grid-row: 1 / span 2;
  align-self: center;
  width: 84px;
  height: 84px;
  border-radius: 50%;
  flex-direction: column;
  gap: 0;
  font-size: 13px;
  background: rgba(217, 84, 43, 0.82);
  border-color: rgba(255, 214, 190, 0.55);
}

/* 提示条改贴左下、且抬到移动座上方：居中会把身体压到座子上，贴着底边又会被拇指盖住 */
html[data-device="phone"][data-orientation="landscape"] .stage-msg {
  left: calc(14px + env(safe-area-inset-left));
  transform: none;
  text-align: left;
  max-width: 42%;
  bottom: calc(150px + env(safe-area-inset-bottom));
}

/* 暂停/结算面板里的幽灵按钮：默认 32 px 高在手机上只有 33 px 实测触点，够不上拇指 */
html[data-device="phone"] .ghost,
html[data-device="phone"] .primary {
  min-height: 44px;
}
</style>
