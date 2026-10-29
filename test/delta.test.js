import test from "node:test";
import assert from "node:assert/strict";
import { Delta, FIXED_STEP, MAX_DELTA, MAX_STEPS, QUEUE_LIMIT, SKILL_RULES, PULSE_SEC, ACTIONS } from "../src/games/delta/game.js";
import { WORLD, circleFree, isSolid, MAPS, compileMap } from "../src/games/delta/map.js";
import { WEAPONS, MEDS } from "../src/games/delta/weapons.js";
import { viewMeters, canvasBox, computeLayout, applyField, fieldFor } from "../src/games/delta/layout.js";
import { draw, drawMinimapOverlay, inkOn } from "../src/games/delta/renderer.js";
import { BAND_M, BLOCKS, BOB_M, CAP_M, EYE_M, FAR_PAD_M, FOG_FAR_M, FOG_NEAR_RATIO, H_FOV_RAD, NEAR_M, V_FOV_MAX_DEG, GROUND_COLORS, LIGHTS, FIGURE_TONE, cssHex, buildSceneSpec, cameraConfig, eyePose, fovForAspect, horizontalFovForAspect, yawFor } from "../src/games/delta/scene3d.js";
import {
  EMPTY_SAVE,
  equipFromStash,
  ensureTask,
  raidReadiness,
  refillAmmo,
  refillMeds,
  settleRaid,
  setSkill,
} from "../src/games/delta/economy.js";

/**
 * 引擎的 rng 必须是可复现的伪随机序列：固定取 0 会让"抛硬币"的分支永远走同一边，
 * 覆盖不到东西；这里用线性同余，两个实例同种子即得到完全相同的世界。
 */
const rngAt = (seed = 7) => {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
};

const loadout = (over = {}) => ({
  primary: null,
  sidearm: "wp_pistol",
  armor: null,
  armorDur: 0,
  helmet: null,
  bag: "bg_small",
  ammo: { kind: "am_9", count: 60 },
  meds: 2,
  skill: null,
  ...over,
});

const newRaid = (over = {}, seed = 7) =>
  new Delta({ mapId: "farm", loadout: loadout(over.loadout ?? {}), skill: over.skill ?? null, rng: rngAt(seed) });

/** 按 MAX_DELTA（引擎单步上限）喂墙钟时间，与视图里的补帧切片同一条路径 */
const run = (g, sec) => {
  const n = Math.round(sec / MAX_DELTA);
  for (let i = 0; i < n; i += 1) g.step(MAX_DELTA);
  return g;
};

/** 清掉威胁：只关心位移/计时/结算的用例不希望被 AI 干扰 */
const noThreats = (g) => {
  for (const ai of g.ais) {
    ai.alive = false;
    ai.sees = false;
  }
  g.fireEnabled = false;
  return g;
};

/** 找一个"自己能站、正东 4 m 有视线"的位置：地图是手写的，不该把坐标写死进断言 */
const openSpotWithSight = (g, dx = 4) => {
  const r = WORLD.playerRadius;
  for (let y = r + 0.5; y < g.map.rows - r; y += 0.5) {
    for (let x = r + 0.5; x < g.map.cols - r - dx; x += 0.5) {
      if (!circleFree(g.map, x, y, r)) continue;
      if (g.visible({ x, y }, { x: x + dx, y })) return { x, y };
    }
  }
  return null;
};

const must = (verdict) => {
  assert.ok(verdict.ok, verdict.reason ?? "操作被拒");
  return verdict.save;
};

/** 与新档 autoEquip 等价的配装：起手包上肩、弹药打满、塞两个医疗包、选烟幕 */
const equippedSave = () => {
  let doc = ensureTask(EMPTY_SAVE);
  doc = must(equipFromStash(doc, "wp_pistol", "sidearm"));
  doc = must(equipFromStash(doc, "bg_small", "bag"));
  doc = must(refillAmmo(doc, "am_9", 36));
  doc = must(refillMeds(doc, 2));
  doc = must(setSkill(doc, "smoke"));
  return doc;
};

const settlement = (over = {}) => ({
  outcome: "escaped",
  escaped: true,
  mapId: "farm",
  mapTier: 1,
  loot: [{ key: "am_9", qty: 2 }],
  dropped: [],
  loadout: loadout(),
  kills: 0,
  searched: 1,
  value: 180,
  timeSec: 40,
  xp: 30,
  hpLeft: 80,
  left: { armorDur: 0, helmetDur: 0, ammoReserve: 48, meds: 1 },
  ...over,
});

test("固定步长：60 帧 1/60 秒与 30 帧 1/30 秒得到完全相同的世界", () => {
  const a = noThreats(newRaid({}, 11));
  const b = noThreats(newRaid({}, 11));
  a.setStick(1, 0.35);
  b.setStick(1, 0.35);
  for (let i = 0; i < 60; i += 1) a.step(1 / 60);
  for (let i = 0; i < 30; i += 1) b.step(1 / 30);
  assert.ok(a.timeSec > 0 && b.timeSec > 0);
  assert.equal(Number(a.timeSec.toFixed(9)), Number(b.timeSec.toFixed(9)));
  assert.equal(Number(a.player.x.toFixed(9)), Number(b.player.x.toFixed(9)));
  assert.equal(Number(a.player.y.toFixed(9)), Number(b.player.y.toFixed(9)));
  // 帧率无关必须连"世界"一起成立，而不只是玩家那一个圆
  assert.equal(
    a.ais.map((ai) => `${ai.x.toFixed(6)},${ai.y.toFixed(6)},${ai.state}`).join("|"),
    b.ais.map((ai) => `${ai.x.toFixed(6)},${ai.y.toFixed(6)},${ai.state}`).join("|"),
  );
});

test("一次 step 最多消化 MAX_DELTA：卡顿不会被折算成快进", () => {
  const g = noThreats(newRaid());
  const used = g.step(5);
  assert.equal(used, MAX_STEPS);
  assert.ok(g.timeSec <= MAX_DELTA + 1e-9, `实际推进 ${g.timeSec}`);
});

test("开局 ready，第一步转 running，倒计时整秒递减", () => {
  const g = noThreats(newRaid());
  assert.equal(g.status, "ready");
  assert.equal(g.timeLeftSec(), g.map.timeLimitSec);
  g.step(FIXED_STEP);
  assert.equal(g.status, "running");
  // timeLeftSec 向上取整：不足一秒不能提前显示成"少一秒"，但也不能永远不动
  assert.equal(g.timeLeftSec(), g.map.timeLimitSec);
  run(g, 1.1);
  assert.equal(g.timeLeftSec(), g.map.timeLimitSec - 1);
});

test("摇杆推满按米走：一秒约一个玩家速度，且始终留在图内", () => {
  const g = noThreats(newRaid());
  const x0 = g.player.x;
  g.setStick(1, 0);
  run(g, 1);
  const moved = g.player.x - x0;
  assert.ok(moved > WORLD.playerSpeed * 0.6 && moved <= WORLD.playerSpeed + 1e-6, `1 秒走了 ${moved} m`);
  assert.ok(g.player.x >= WORLD.playerRadius && g.player.x <= g.map.width - WORLD.playerRadius);
});

test("撞墙不穿：贴着西墙一直往左推，玩家永远不在实体格里", () => {
  const g = noThreats(newRaid());
  g.setStick(-1, 0);
  for (let i = 0; i < 200; i += 1) {
    g.step(MAX_DELTA);
    assert.equal(isSolid(g.map, Math.floor(g.player.x), Math.floor(g.player.y)), false, `第 ${i} 步卡进墙体`);
  }
  assert.ok(g.player.x < 2, `往左推了 35 秒还停在 x=${g.player.x}，位移被谁吃了？`);
});

test("非法动作与队列上限：入口只收已定义的 7 个动作，一次最多攒 4 条", () => {
  const g = newRaid();
  assert.equal(g.enqueue("shoot"), false);
  assert.equal(g.enqueue("reload"), true);
  for (const action of ACTIONS) if (action !== "reload") g.enqueue(action);
  assert.equal(g.queue.length, QUEUE_LIMIT);
  assert.equal(g.enqueue("med"), false);
});

test("自动开火打光弹匣后自动换弹，子弹总数守恒", () => {
  const g = newRaid();
  const spot = openSpotWithSight(g);
  assert.ok(spot, "农林区里找不到一块有 4 m 通视的空地，测试前提没了");
  noThreats(g);
  g.fireEnabled = true;
  g.placePlayer(spot.x, spot.y);
  g.ghostAt(spot.x + 4, spot.y, { hp: 100000 });
  const total0 = g.mag + g.ammoReserve;
  // 手枪 420 rpm + 1.6 秒换弹：清空一匣再打出去需要 4 秒左右，这里给足 6 秒
  for (let i = 0; i < 120 && g.stats.shots <= WEAPONS.wp_pistol.mag; i += 1) g.step(MAX_DELTA);
  assert.ok(g.stats.shots > WEAPONS.wp_pistol.mag, `只开了 ${g.stats.shots} 枪，没跨过整匣`);
  assert.ok(g.mag > 0, "打光弹匣后没有自动换弹");
  assert.equal(g.reloading, 0);
  assert.equal(g.mag + g.ammoReserve, total0 - g.stats.shots, "弹匣与备弹的总数对不上打出去的发数");
});

test("口径不对 ⇒ 弹匣为零、无法换弹、全程停火", () => {
  const g = newRaid({ loadout: loadout({ primary: "wp_rifle", sidearm: null, ammo: { kind: "am_9", count: 90 } }) });
  noThreats(g);
  g.fireEnabled = true;
  const spot = openSpotWithSight(g);
  g.placePlayer(spot.x, spot.y);
  g.ghostAt(spot.x + 4, spot.y, { hp: 100000 });
  g.enqueue("reload");
  run(g, 3);
  assert.equal(g.ammoMatched, false);
  assert.equal(g.mag, 0);
  assert.equal(g.stats.shots, 0);
  assert.equal(g.reloading, 0, "口径不符却进入了换弹");
  assert.equal(g.ammoReserve, 0, "不匹配的弹药不该被算成备弹");
});

test("fire-toggle 关掉后不再消耗弹药", () => {
  const g = newRaid();
  noThreats(g);
  const spot = openSpotWithSight(g);
  g.placePlayer(spot.x, spot.y);
  g.ghostAt(spot.x + 4, spot.y, { hp: 100000 });
  g.fireEnabled = true;
  assert.equal(g.fireEnabled, true);
  g.enqueue("fire-toggle");
  g.step(FIXED_STEP);
  assert.equal(g.fireEnabled, false);
  run(g, 2);
  assert.equal(g.stats.shots, 0);
  assert.equal(g.mag, WEAPONS.wp_pistol.mag);
});

test("按住扳机：空场（视野里没人）也出枪，松手立刻停", () => {
  const g = noThreats(newRaid());
  const spot = openSpotWithSight(g);
  g.placePlayer(spot.x, spot.y);
  // 自动开火关到最严：这一匣只能是被扳机打出去的
  assert.equal(g.fireEnabled, false);
  g.setTrigger(true);
  run(g, 1.2);
  const fired = g.stats.shots;
  assert.ok(fired > 0, "按住扳机一枪没开 —— 吃鸡式开火没接进 autoFire");
  assert.ok(fired <= WEAPONS.wp_pistol.mag, `1.2 秒打了 ${fired} 枪，扳机绕过了射速上限`);
  g.setTrigger(false);
  run(g, 1.5);
  assert.equal(g.stats.shots, fired, "松手之后还在开火");
});

test("扳机不污染自动开火：按下/松开都不动 fireEnabled", () => {
  const g = newRaid();
  assert.equal(g.fireEnabled, true, "开局的自动开火应当是开着的");
  g.setTrigger(true);
  g.step(FIXED_STEP);
  assert.equal(g.fireEnabled, true, "按住扳机把自动开火的开关改了");
  g.setTrigger(false);
  g.step(FIXED_STEP);
  assert.equal(g.fireEnabled, true, "松开扳机把自动开火关掉了");
});

test("打药：按 heal 回复、扣一件、1 秒冷却内不许连打、满血不打", () => {
  const g = noThreats(newRaid());
  g.player.hp = 40;
  g.enqueue("med");
  g.step(FIXED_STEP);
  assert.equal(g.player.hp, 40 + MEDS.md_medkit.heal);
  assert.equal(g.meds, 1);
  g.enqueue("med");
  g.step(FIXED_STEP);
  assert.equal(g.meds, 1, "冷却内又吃掉一个医疗包");
  run(g, 1.2);
  g.enqueue("med");
  g.step(FIXED_STEP);
  assert.equal(g.meds, 0);
  assert.equal(g.player.hp, g.player.hpMax);
  g.enqueue("med");
  g.step(FIXED_STEP);
  assert.equal(g.player.hp, g.player.hpMax, "满血还能继续打药");
});

test("技能：烟幕占次数与冷却并生成烟雾，脉冲点亮侦察标记", () => {
  const smoke = noThreats(newRaid({ skill: "smoke" }));
  assert.equal(smoke.skill.uses, SKILL_RULES.smoke.uses);
  smoke.enqueue("skill");
  smoke.step(FIXED_STEP);
  assert.equal(smoke.smokes.length, 1);
  assert.equal(smoke.skill.uses, SKILL_RULES.smoke.uses - 1);
  assert.ok(smoke.skill.cooldown > 0);
  smoke.enqueue("skill");
  smoke.step(FIXED_STEP);
  assert.equal(smoke.smokes.length, 1, "冷却内又放了一次烟");

  const pulse = noThreats(newRaid({ skill: "pulse" }));
  pulse.enqueue("skill");
  pulse.step(FIXED_STEP);
  // 同一个 fixed step 里时钟阶段会把 ttl 扣掉一帧，所以只断言"点亮且正在衰减"
  assert.ok(pulse.pulse.ttl > PULSE_SEC - FIXED_STEP - 1e-9 && pulse.pulse.ttl < PULSE_SEC);
  assert.equal(pulse.smokes.length, 0);
});

test("搜刮：贴住容器站桩到 searchSec 即出货并计数", () => {
  const g = noThreats(newRaid());
  const box = g.map.containers[0];
  const r = WORLD.playerRadius;
  const neighbours = [
    { x: box.x, y: box.y - 1 },
    { x: box.x, y: box.y + 1 },
    { x: box.x - 1, y: box.y },
    { x: box.x + 1, y: box.y },
  ].filter((p) => circleFree(g.map, p.x, p.y, r));
  assert.ok(neighbours.length, "容器四周没有可站立格，地图数据有问题");
  g.placePlayer(neighbours[0].x, neighbours[0].y);
  g.enqueue("interact");
  g.step(FIXED_STEP);
  assert.ok(g.searchTarget, "贴着脸却按不出搜刮");
  assert.equal(g.stats.searched, 0);
  run(g, box.searchSec + 0.3);
  assert.equal(g.stats.searched, 1);
  assert.equal(g.searchTarget, null);
});

test("一动就打断搜刮：不许边翻箱子边跑位", () => {
  const g = noThreats(newRaid());
  const box = g.map.containers[0];
  const free = [
    { x: box.x, y: box.y - 1 },
    { x: box.x, y: box.y + 1 },
    { x: box.x - 1, y: box.y },
    { x: box.x + 1, y: box.y },
  ].find((p) => circleFree(g.map, p.x, p.y, WORLD.playerRadius));
  g.placePlayer(free.x, free.y);
  g.enqueue("interact");
  g.step(FIXED_STEP);
  assert.ok(g.searchTarget);
  g.setStick(1, 0);
  g.step(FIXED_STEP);
  assert.equal(g.searchTarget, null);
  assert.equal(g.searchProgress, 0);
});

test("撤离：站进绿圈满 5 秒判赢，中途离开进度清零不衰减", () => {
  const g = noThreats(newRaid());
  const point = g.map.exfils[0];
  const spot = [point, { x: point.x - 1, y: point.y }, { x: point.x + 1, y: point.y }, { x: point.x, y: point.y - 1 }]
    .find((p) => circleFree(g.map, p.x, p.y, WORLD.playerRadius));
  g.placePlayer(spot.x, spot.y);
  run(g, 3);
  assert.ok(g.exfilHoldSec > 2.9 && g.status === "running", `站了 3 秒只攒到 ${g.exfilHoldSec}`);
  g.placePlayer(g.map.spawn.x, g.map.spawn.y);
  g.step(FIXED_STEP);
  assert.equal(g.exfilHoldSec, 0, "离开撤离圈还在偷偷攒进度");
  g.placePlayer(spot.x, spot.y);
  run(g, WORLD.exfilHoldSec + 0.3);
  assert.equal(g.status, "won");
  assert.equal(g.endReason, "escaped");
  assert.equal(g.settle("aborted").outcome, "escaped");
});

test("超时判负：走满 timeLimitSec 记 timeout", () => {
  const g = noThreats(newRaid());
  g.timeSec = g.map.timeLimitSec - FIXED_STEP / 2;
  g.step(FIXED_STEP);
  assert.equal(g.status, "over");
  assert.equal(g.endReason, "timeout");
});

test("阵亡判负：血量归零的那一步收尾，之后时钟与状态都不再动", () => {
  const g = noThreats(newRaid());
  g.player.hp = 0;
  g.player.alive = false;
  g.step(FIXED_STEP);
  assert.equal(g.status, "over");
  assert.equal(g.endReason, "killed");
  const t = g.timeSec;
  g.step(MAX_DELTA);
  assert.equal(g.timeSec, t, "结算之后还在走时间");
  assert.equal(g.settle().outcome, "killed");
});

test("枪声会惊动看不见的敌人：噪声半径内的 AI 由巡逻转为警戒", () => {
  const g = newRaid();
  noThreats(g);
  g.fireEnabled = true;
  const spot = openSpotWithSight(g);
  g.placePlayer(spot.x, spot.y);
  g.ghostAt(spot.x + 4, spot.y, { hp: 100000 });
  // 听觉要单独验证，所以找一个"在枪声半径内、却和玩家没有视线"的格子
  const blind = (() => {
    for (let y = 1; y < g.map.rows - 1; y += 0.5) {
      for (let x = 1; x < g.map.cols - 1; x += 0.5) {
        const dist = Math.hypot(x - spot.x, y - spot.y);
        if (dist < 4 || dist > WORLD.noiseRadiusM * 0.8) continue;
        if (!circleFree(g.map, x, y, WORLD.aiRadius)) continue;
        if (!g.visible({ x, y }, g.player)) return { x, y, dist };
      }
    }
    return null;
  })();
  assert.ok(blind, "图里没有枪声够得着却看不见的位置，听觉链路没法单独测");
  const listener = g.ais[0];
  Object.assign(listener, { alive: true, hears: false, sees: false, state: "patrol", x: blind.x, y: blind.y });
  g.step(MAX_DELTA);
  assert.ok(g.stats.shots > 0, "没能开火，噪声测试无从谈起");
  assert.ok(g.noise.ttl > 0, "开火没留下声源");
  assert.equal(listener.sees, false, "这个位置本该看不见玩家");
  assert.equal(listener.state, "alert", `听见枪声却没进警戒（实际 ${listener.state}）`);
});

test("settle 幂等，且引擎已判的胜负不允许被调用方改判", () => {
  const g = noThreats(newRaid());
  g.player.alive = false;
  g.player.hp = 0;
  g.step(FIXED_STEP);
  const first = g.settle();
  assert.equal(g.settle("aborted"), first);
  assert.equal(first.outcome, "killed", "卸载时补一次 aborted 就能把阵亡洗成正常结算");

  const fresh = noThreats(newRaid());
  assert.equal(fresh.abort().outcome, "aborted");
  assert.equal(fresh.abort().outcome, "aborted");
});

test("HUD 只吃引擎状态，字段与数值同步", () => {
  const g = noThreats(newRaid({ skill: "smoke" }));
  run(g, 1.5);
  const hud = g.hud();
  assert.equal(hud.mapName, g.map.name);
  assert.equal(hud.weapon, WEAPONS.wp_pistol.label);
  assert.equal(hud.mag, g.mag);
  assert.equal(hud.magSize, WEAPONS.wp_pistol.mag);
  assert.equal(hud.meds, g.meds);
  assert.equal(hud.bagSlots, 6);
  assert.equal(hud.timeLeft, g.timeLeftSec());
  assert.equal(hud.aiAlive, 0);
  assert.equal(hud.skill.name, "smoke");
  assert.equal(hud.skill.label, SKILL_RULES.smoke.label);
  assert.equal(hud.search, null);
});

test("三端逻辑视野恒 28×18 m，画布盒子只随容器缩放", () => {
  const meters = (field) => {
    const m = viewMeters(field);
    return { long: Math.max(m.width, m.height), short: Math.min(m.width, m.height) };
  };
  const phone = computeLayout({ width: 390, height: 844 }, { width: 360, height: 640 });
  const phoneLandscape = computeLayout({ width: 844, height: 390 }, { width: 800, height: 360 });
  const desktop = computeLayout({ width: 1920, height: 1080 }, { width: 1600, height: 900 });
  assert.deepEqual(meters(phone.field), { long: 28, short: 18 });
  assert.deepEqual(meters(phoneLandscape.field), { long: 28, short: 18 });
  assert.deepEqual(meters(desktop.field), { long: 28, short: 18 });
  // 朝向只换宽高，不改米数；设备档位只改线宽字号，同样不改米数
  assert.deepEqual(phone.field, fieldFor("portrait"));
  assert.deepEqual(desktop.field, fieldFor("landscape"));
  assert.deepEqual(canvasBox(phone, { width: 800, height: 600 }), { width: 386, height: 600 });
  assert.deepEqual(canvasBox(phoneLandscape, { width: 800, height: 600 }), { width: 800, height: 514 });
  // 容器退化成 0（首帧或 display:none）时必须是可识别的退化值，视图靠它回退到外层盒子
  assert.deepEqual(canvasBox(phone, { width: 0, height: 0 }), { width: 1, height: 1 });
});

test("起手包配装齐即可出征，缺件时逐项点名", () => {
  const ready = equippedSave();
  assert.deepEqual(raidReadiness(ready), { ready: true, missing: [] });
  const naked = structuredClone(EMPTY_SAVE);
  const verdict = raidReadiness(naked);
  assert.equal(verdict.ready, false);
  assert.deepEqual(verdict.missing, ["武器", "弹药", "背包", "技能"]);
});

test("撤离结算：货进仓库、耐久与余弹回写、只记一局", () => {
  const base = equippedSave();
  const { save, ledger, deduped } = settleRaid(base, settlement(), { now: 1000, runId: 1 });
  assert.equal(deduped, false);
  assert.equal(ledger.outcome, "escaped");
  assert.equal(ledger.survived, true);
  assert.equal(save.stats.raids, 1);
  assert.equal(save.stats.escapes, 1);
  assert.equal(save.stats.containersSearched, 1);
  assert.equal(save.stats.bestRaidValue, 180);
  // 身上那套装备不能又复制一份进仓库（早期版本的刷钱洞）
  assert.equal(save.stash.items.find((entry) => entry.key === "wp_pistol"), undefined);
  // 起手包的 36 发已经装进配装格，仓库里只剩这局搜到的 2 发
  assert.equal(save.stash.items.find((entry) => entry.key === "am_9").qty, 2);
  assert.equal(save.loadout.sidearm, "wp_pistol");
  assert.equal(save.loadout.ammo.count, 48);
  assert.equal(save.loadout.meds, 1);
});

test("阵亡结算：身上全部作废，保险箱留下并补发起手包", () => {
  const base = equippedSave();
  base.safeBox.items.push({ key: "md_medkit", qty: 1 });
  const { save, ledger } = settleRaid(base, settlement({ outcome: "killed", escaped: false, left: { armorDur: 0, helmetDur: 0, ammoReserve: 0, meds: 0 } }), { now: 1000, runId: 2 });
  assert.equal(ledger.survived, false);
  assert.equal(save.stats.deaths, 1);
  assert.equal(save.loadout.sidearm, null);
  assert.equal(save.loadout.bag, null);
  assert.equal(save.loadout.ammo.count, 0);
  assert.equal(save.loadout.meds, 0);
  // 口径留着，人才能补发后直接再进图
  assert.equal(save.loadout.ammo.kind, "am_9");
  assert.ok(ledger.lost.some((entry) => entry.key === "wp_pistol"));
  assert.ok(ledger.lost.some((entry) => entry.key === "am_9"), "背上的 48 发没算进损失");
  // 保险箱那一件不受阵亡影响
  assert.equal(save.safeBox.items.find((entry) => entry.key === "md_medkit").qty, 1);
  // 破产保底：仓库里重新有枪、有包、有弹、有药
  assert.equal(save.stash.items.find((entry) => entry.key === "wp_pistol").qty, 1, "阵亡后没补发武器，新玩家会卡死在藏身处");
  assert.equal(save.stash.items.find((entry) => entry.key === "bg_small").qty, 1);
  assert.equal(save.stash.items.find((entry) => entry.key === "am_9").qty, 36);
  assert.equal(save.wallet, base.wallet, "阵亡还入账了柯尔");
  assert.equal(raidReadiness(save).ready, false, "补发进仓库的装备被自动算成了已配装");
});

test("同一 runId 重复结算直接去重，不重复入账", () => {
  const base = equippedSave();
  const first = settleRaid(base, settlement(), { now: 1000, runId: 42 });
  const again = settleRaid(first.save, settlement(), { now: 2000, runId: 42 });
  assert.equal(again.deduped, true);
  assert.equal(again.ledger, null);
  assert.equal(again.save.stats.raids, first.save.stats.raids);
  assert.equal(again.save.stash.items.find((entry) => entry.key === "am_9").qty, first.save.stash.items.find((entry) => entry.key === "am_9").qty);
});

test("脏存档清洗：越界数值与未知物品一律打回", () => {
  const dirty = {
    wallet: Number.MAX_SAFE_INTEGER,
    xp: "abc",
    level: 999,
    safeBox: { slots: 99, items: [{ key: "wp_ghost", qty: -5 }, { key: "am_9", qty: 1e9 }] },
    stash: { slots: -1, items: [{ key: "md_medkit", qty: 1.7 }] },
    loadout: { primary: "wp_rifle", sidearm: "wp_pistol", ammo: { kind: "am_nope", count: -3 }, meds: 999, skill: "laser" },
    tasks: { active: "t_nope", got: -1, need: 0, cycle: -2 },
    stats: { raids: -5 },
  };
  const clean = settleRaid(dirty, settlement(), { now: 5, runId: 9 }).save;
  assert.ok(clean.wallet <= 1e9);
  assert.equal(clean.xp >= 0, true);
  assert.ok(clean.level >= 1 && clean.level <= 30);
  assert.equal(clean.safeBox.items.length, 1, "未知物品没被剔除");
  assert.equal(clean.safeBox.items[0].qty <= 99, true);
  assert.equal(clean.loadout.skill, null);
  assert.equal(clean.loadout.ammo.kind, null);
  assert.ok(clean.tasks.got >= 0);
  assert.ok(clean.stats.raids >= 1);
});

/** 只记录、不真画的 2D 上下文桩：任何非有限数（NaN/Infinity）直接抛，绘制坐标算错当场红 */
function recordingCtx(sink) {
  const state = { fillStyle: "", strokeStyle: "", lineWidth: 0, globalAlpha: 1, lineJoin: "" };
  const ctx = {};
  for (const name of ["save", "restore", "translate", "rotate", "scale", "beginPath", "closePath", "fill", "stroke", "clearRect", "fillRect", "strokeRect", "arc", "ellipse", "moveTo", "lineTo", "setLineDash", "fillText", "strokeText"]) {
    ctx[name] = (...args) => {
      for (const value of args) {
        if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`${name} 收到非有限数：${args}`);
      }
      sink.push([name, JSON.stringify(args), String(state.fillStyle), String(state.strokeStyle), state.lineWidth, state.globalAlpha]);
    };
  }
  for (const name of ["fillStyle", "strokeStyle", "lineWidth", "globalAlpha", "font", "textAlign", "textBaseline", "lineJoin"]) {
    Object.defineProperty(ctx, name, { get: () => state[name], set: (value) => { state[name] = value; } });
  }
  ctx.createRadialGradient = () => ({ addColorStop: () => {} });
  return ctx;
}

test("渲染层：画一帧不改引擎状态，同相位逐笔一致，换相位只动步态", () => {
  const layout = computeLayout({ width: 1280, height: 800 }, { width: 1280, height: 800 });
  applyField(layout.field, layout.device, layout.orientation);
  const g = newRaid();
  g.setStick(0.8, 0.3);
  for (let i = 0; i < 40; i += 1) g.step(FIXED_STEP);
  const bodies = (game) => JSON.stringify({
    player: [game.player.x, game.player.y, game.player.angle],
    ais: game.ais.map((ai) => [ai.x, ai.y, ai.angle, ai.state]),
    bags: game.groundBags.length,
    bullets: game.bullets.items.filter((b) => b.alive).length,
  });
  const before = bodies(g);
  const one = [];
  draw(recordingCtx(one), g, { phase: 1234.5, metrics: layout.metrics });
  const twice = [];
  draw(recordingCtx(twice), g, { phase: 1234.5, metrics: layout.metrics });
  assert.equal(bodies(g), before, "渲染写了状态");
  assert.deepEqual(twice, one, "同一帧画了两次结果不同（渲染层混进了随机数）");
  assert.equal(one.filter((op) => op[0] === "rotate").length, g.ais.filter((ai) => ai.alive && !ai.isGhost).length + 1, "每个活着的实体各画一个人形");
  const other = [];
  draw(recordingCtx(other), g, { phase: 1235.5, metrics: layout.metrics });
  assert.notDeepEqual(other, one, "步态相位没有影响腿摆");
  assert.equal(bodies(g), before, "第二帧又写了状态");
});

// —— 第一人称：相机数学与场景几何（WebGL 在 node 里起不来，所以断言全押在纯函数层）——

test("视场角：1:1 与宽屏锁水平 75°，竖屏夹住垂直角换取不晕", () => {
  // aspect ≥ 0.914（即反算的垂直角本就不超过 80°）时水平角锁死，宽高比只改变垂直取舍
  for (const aspect of [1, 1.2, 1.556, 16 / 9, 3]) {
    assert.ok(Math.abs(horizontalFovForAspect(aspect) - (H_FOV_RAD * 180) / Math.PI) < 1e-9, `水平视野在 ${aspect} 上没锁住`);
  }
  assert.ok(fovForAspect(16 / 9) < fovForAspect(1), "宽屏的垂直角应当更小");
  // 竖屏：不再把水平角反算成 100°+ 的垂直角（屏幕上下沿鱼眼拉伸是晕眩主因）
  for (const aspect of [0.46, 0.5, 0.643, 0.8]) {
    assert.equal(fovForAspect(aspect), V_FOV_MAX_DEG, `竖屏 ${aspect} 的垂直角没被夹住`);
    const hFov = horizontalFovForAspect(aspect);
    assert.ok(hFov < (H_FOV_RAD * 180) / Math.PI, "竖屏夹住垂直角后水平角应当收窄");
    assert.ok(hFov > 38, `竖屏 ${aspect} 的水平角只剩 ${hFov.toFixed(1)}°，成望远镜了`);
  }
  // 坏值（0/负数/NaN）当 1:1 处理，不能让相机拿到 NaN 投影矩阵
  assert.equal(fovForAspect(0), fovForAspect(1));
  assert.equal(fovForAspect(Number.NaN), fovForAspect(1));
});

test("相机四元组：aspect/near/far 各就各位，整张图都落在裁面之间", () => {
  // 回归的是"按位置把 0.06 传成 aspect、把 34 传成 near"这类错误：近裁面一大，画了也是全黑
  for (const aspect of [0.5, 0.643, 1, 1.556, 3]) {
    const cfg = cameraConfig(aspect);
    assert.equal(cfg.aspect, aspect);
    assert.equal(cfg.near, NEAR_M);
    assert.equal(cfg.far, 28 + FAR_PAD_M);
    assert.equal(cfg.fov, fovForAspect(aspect));
    assert.ok(cfg.near < cfg.far, "近裁面跑到远裁面之后了");
    // 远裁面必须落在雾远界之外：雾先糊住远处，裁面才不会在视野里切出黑边
    assert.ok(cfg.far > 28, `远裁面 ${cfg.far} 比雾远界还近`);
  }
  assert.equal(cameraConfig(0).aspect, 1, "坏宽高比没退回 1:1");
  assert.equal(cameraConfig(Number.NaN).near, NEAR_M);
});

test("轴映射：2D 朝向经 yawFor 转成 three 的相机朝向，两者指同一格", () => {
  for (const angle of [0, Math.PI / 4, Math.PI / 2, Math.PI, -1.2, 6.2]) {
    const yaw = yawFor(angle);
    // three 相机（rotation.order = YXZ）的前向是 (-sin yaw, -cos yaw)
    assert.ok(Math.abs(-Math.sin(yaw) - Math.cos(angle)) < 1e-9, "X 分量对不上");
    assert.ok(Math.abs(-Math.cos(yaw) - Math.sin(angle)) < 1e-9, "Z 分量对不上");
  }
});

test("场景规格：实体格一一对应成盒子，两次构建逐字节相同（不许随机数）", () => {
  for (const def of MAPS) {
    const map = compileMap(def);
    const spec = buildSceneSpec(map);
    const count = (ch) => map.grid.reduce((sum, row) => sum + [...row].filter((c) => c === ch).length, 0);
    const total = Object.keys(BLOCKS).reduce((sum, ch) => sum + count(ch), 0);
    const boxed = spec.groups.filter((g) => !g.kind.startsWith("exfil-")).reduce((sum, g) => sum + g.items.length, 0);
    assert.equal(boxed, total, `${map.id}：盒子数量与网格里的实体格数量不一致`);
    assert.equal(spec.groups.find((g) => g.kind === "exfil-beacon").items.length, map.exfils.length);
    assert.deepEqual(JSON.stringify(spec), JSON.stringify(buildSceneSpec(map)), `${map.id}：同一张图构建出不同几何`);
    for (const group of spec.groups) {
      assert.ok(new Set(group.items.map((i) => `${i.x},${i.y},${i.z}`)).size === group.items.length, "同一类里有重叠实例");
      for (const item of group.items) {
        assert.ok(item.x >= 0 && item.x <= spec.bounds.width && item.z >= 0 && item.z <= spec.bounds.height, "盒子跑到图外");
        assert.ok(Number.isFinite(item.ry) && Math.abs(item.ry) <= Math.PI, "容器抖动角越界");
        assert.ok(item.y > 0 && item.y <= EYE_M + 3, "盒子高度不合理");
      }
    }
    assert.ok(spec.bounds.width >= 28 && spec.bounds.height >= 18, `${map.id}：图幅装不下恒定视口`);
    assert.equal(spec.fog.far, 28, "雾远界必须与俯视的 28 m 视口对齐");
    assert.equal(def.timeSlot === "night" ? spec.lights : spec.lights, spec.lights);
  }
});

test("眼睛姿态：静止归零，起伏只由相位与摇杆幅度派生，坏输入不产生 NaN", () => {
  const idle = eyePose({ angle: 1.1, magnitude: 0, phase: 99 });
  assert.equal(idle.eyeY, EYE_M);
  assert.equal(Math.abs(idle.bob), 0);
  assert.equal(Math.abs(idle.roll), 0);
  assert.deepEqual(eyePose({ angle: 2, magnitude: 0.7, phase: 3.5 }), eyePose({ angle: 2, magnitude: 0.7, phase: 3.5 }));
  const walking = eyePose({ angle: 2, magnitude: 1, phase: 3.5 });
  assert.notEqual(walking.bob, eyePose({ angle: 2, magnitude: 1, phase: 4.2 }).bob, "换相位眼睛没有起伏");
  assert.ok(Math.abs(walking.bob) < 0.05 && Math.abs(walking.roll) < 0.05, "步态起伏大到会让人晕");
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, undefined, "x"]) {
    const pose = eyePose({ angle: bad, magnitude: bad, phase: bad });
    for (const key of ["yaw", "pitch", "eyeY", "roll", "bob"]) {
      assert.ok(Number.isFinite(pose[key]), `${key} 被坏输入算成了非有限数`);
    }
  }
});

// —— 引擎：视图模式只改"摇杆向量怎么解释"，不改任何玩法量 ——

test("俯视推哪走哪，第一人称摇杆变相对朝向：走路不许偷偷回头", () => {
  const g = newRaid();
  noThreats(g);
  const step = () => { for (let i = 0; i < 30; i += 1) g.step(FIXED_STEP); g.setStick(0, 0); };

  g.setStick(0, -1);
  const before = { x: g.player.x, y: g.player.y };
  step();
  assert.ok(g.player.y < before.y, "俯视推上应当向屏幕上方走");
  assert.ok(Math.abs(g.player.angle + Math.PI / 2) < 1e-9, "俯视的朝向应当跟着移动方向走");

  g.setViewMode("fps");
  for (const [angle, expect] of [[0, [1, 0]], [Math.PI / 2, [0, 1]], [Math.PI, [-1, 0]], [-Math.PI / 2, [0, -1]]]) {
    g.player.angle = angle;
    const origin = { x: g.player.x, y: g.player.y };
    g.setStick(0, -1);
    step();
    const dx = g.player.x - origin.x;
    const dy = g.player.y - origin.y;
    assert.ok(Math.hypot(dx, dy) > 1, `${angle} 朝向前进后没位移（撞上东西了？）`);
    const len = Math.hypot(dx, dy);
    assert.ok(Math.abs(dx / len - expect[0]) < 0.02 && Math.abs(dy / len - expect[1]) < 0.02, "第一人称前进没有沿朝向");
    assert.ok(Math.abs(g.player.angle - angle) < 1e-9, "走路把朝向改了");
    g.player.setStick?.(0, 0);
  }

  g.player.angle = Math.PI / 2;
  const sideOrigin = { x: g.player.x, y: g.player.y };
  g.setStick(1, 0);
  step();
  assert.ok(g.player.x < sideOrigin.x && Math.abs(g.player.y - sideOrigin.y) < 0.05, "面向正南时右平移应当朝西");
});

/** 角差取最短弧：断言不能被 wrapAngle 的 ±π 边界绊倒 */
const angleDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

/**
 * 转向通道过去只在第一人称生效（俯视直接丢掉待消化转向），
 * 手机横屏铺了右下那枚转身摇杆之后，"站着不动只转身"在俯视也必须成立——
 * 否则默认视图里右摇杆是个摆设。夹取、切视图清空、死了不转身这三条保持原样。
 */
test("转向通道：俯视也消化 setLook，单步夹取、切视图清空、死了不转身", () => {
  const g = newRaid();
  noThreats(g);
  g.setLook(Number.NaN);
  g.setLook("0.5");
  g.setLook(-2);
  const topAngle = g.player.angle;
  assert.equal(g.lookPending, -1, "非有限值没被忽略，或累加没有夹到 ±1");
  g.step(FIXED_STEP);
  assert.equal(g.lookPending, 0);
  assert.ok(Math.abs(angleDiff(g.player.angle, topAngle - 1)) < 1e-9, "俯视把待消化转向丢掉了，右摇杆在默认视图里就是摆设");

  g.setLook(999);
  assert.ok(Math.abs(g.lookPending) <= 1, "单步转向没有上限，一拖就能转半圈");
  g.setLook(-999);
  assert.ok(g.lookPending >= -1);

  g.setViewMode("fps");
  const angle = g.player.angle;
  g.setLook(0.3);
  g.setLook(0.2);
  assert.equal(g.lookPending, 0.5);
  g.step(FIXED_STEP);
  assert.ok(Math.abs(g.player.angle - (angle + 0.5)) < 1e-9, "待消化转向没有在一整步里被消费");
  assert.equal(g.lookPending, 0);

  g.setLook(0.4);
  g.setViewMode("topdown");
  assert.equal(g.lookPending, 0, "切回俯视留下了待消化转向");
  g.player.alive = false;
  g.setViewMode("fps");
  const deadAngle = g.player.angle;
  g.setLook(0.6);
  g.step(FIXED_STEP);
  assert.equal(g.player.angle, deadAngle, "死了还能转身");
});

/** 双摇杆的分工：右摇杆在推的这一步，走路不许把身体拧回移动方向；松手后马上恢复"推哪走哪" */
test("双摇杆：右摇杆在推时转向优先，松手恢复推哪走哪", () => {
  const g = newRaid();
  noThreats(g);
  g.setStick(0, -1);
  g.step(FIXED_STEP);
  const north = g.player.angle;
  assert.ok(Math.abs(north + Math.PI / 2) < 1e-9, `俯视默认应当推哪走哪，实得 ${north}`);

  g.setLook(0.2);
  g.step(FIXED_STEP);
  assert.ok(Math.abs(g.player.angle - (north + 0.2)) < 1e-6, "走路把右摇杆的转向覆盖了，边退边打做不到");

  g.setLook(0);
  g.step(FIXED_STEP);
  assert.ok(Math.abs(g.player.angle + Math.PI / 2) < 1e-6, "松开右摇杆后没有恢复朝向移动方向");
});

/**
 * 自动开火的两种视图共用同一组几何：玩家钉在农场北走廊 (2.5, 8.5)、敌人钉在正东 6 m 处
 * （实测该行 1→34 格连续开阔，视线不会被墙吃掉），开局朝向故意偏 -0.4 弧度、仍在 70° 锥形内。
 * 俯视下锥形内的追瞄照转（-0.4 → 0，玩家实际会走到正对），第一人称下必须一动不动——
 * 转身是玩家的权力，枪口不能替他改视野。
 */
function aimAssistSample(mode) {
  const g = newRaid({
    loadout: {
      primary: "wp_smg",
      sidearm: null,
      armor: null,
      armorDur: 0,
      helmet: null,
      bag: "bg_small",
      ammo: { kind: "am_9", count: 120 },
      meds: 2,
      skill: null,
    },
  });
  g.setViewMode(mode);
  const target = g.ais[0];
  for (const ai of g.ais) {
    if (ai !== target) {
      ai.alive = false;
      ai.sees = false;
    }
  }
  target.alive = true;
  target.isGhost = false;
  target.hp = 1000;
  g.player.x = 2.5;
  g.player.y = 8.5;
  g.player.angle = -0.4;
  for (let i = 0; i < 30; i += 1) {
    // 双方位置每步复位，等于两个"站桩"的人；只有角度交给引擎自己决定
    target.x = 8.5;
    target.y = 8.5;
    g.player.x = 2.5;
    g.player.y = 8.5;
    g.step(FIXED_STEP);
  }
  return { shots: g.stats.shots, angle: g.player.angle, hp: target.hp };
}

test("自动开火：俯视追瞄转正，第一人称不代玩家转身", () => {
  const topdown = aimAssistSample("topdown");
  const fps = aimAssistSample("fps");
  assert.ok(topdown.shots > 0 && fps.shots > 0, "锥形内都没开火，样本无效");
  assert.ok(Math.abs(topdown.angle) < 1e-6, "俯视应当把朝向追到正对敌人");
  assert.ok(Math.abs(fps.angle + 0.4) < 1e-9, "第一人称的朝向被自动开火改了");
  assert.ok(fps.hp < 1000, "第一人称不开火说明锥形判定被视图模式带偏了");
});

test("叠层小地图：只画右上角那块，且一帧不写引擎状态", () => {
  const layout = computeLayout({ width: 1280, height: 800 }, { width: 1280, height: 800 });
  applyField(layout.field, layout.device, layout.orientation);
  const g = newRaid();
  for (let i = 0; i < 30; i += 1) g.step(FIXED_STEP);
  const bodies = JSON.stringify({ p: [g.player.x, g.player.y, g.player.angle], ais: g.ais.map((a) => [a.x, a.y]) });
  const ops = [];
  drawMinimapOverlay(recordingCtx(ops), g, { metrics: layout.metrics });
  assert.equal(JSON.stringify({ p: [g.player.x, g.player.y, g.player.angle], ais: g.ais.map((a) => [a.x, a.y]) }), bodies, "小地图叠层写了状态");
  assert.ok(ops.some((op) => op[0] === "clearRect"), "叠层没清空，俯视画面会糊在 WebGL 上");
  const full = [];
  draw(recordingCtx(full), g, { phase: 10, metrics: layout.metrics });
  assert.ok(ops.filter((op) => op[0] === "fillRect").length < full.filter((op) => op[0] === "fillRect").length, "叠层画的不只是小地图");
  assert.equal(ops.filter((op) => op[0] === "rotate").length, 0, "叠层里不该有人形旋转");
});

// —— 可辨识度与抗晕（玩家原话"墙和障碍物各种颜色很难区分，很容易晕"）——
// 断言全部押在 CIELAB 色差与相机参数上：这两件事肉眼验收不可复现，只能变成数字下限。

/** sRGB hex → CIELAB（D65）。ΔE76 = 三维欧氏距离，23 上下就是"扫一眼能分开"的量级 */
function labOf(hex) {
  const lin = (v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const R = lin((hex >> 16) & 255);
  const G = lin((hex >> 8) & 255);
  const B = lin(hex & 255);
  let x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  let y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  let z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  [x, y, z] = [f(x), f(y), f(z)];
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const dE = (a, b) => Math.hypot(...labOf(a).map((v, i) => v - labOf(b)[i]));

test("配色可辨识度：七类本体两两 ΔE ≥ 25，顶盖与本体 ΔE ≥ 20", () => {
  const bodies = Object.values(BLOCKS);
  assert.equal(bodies.length, 7);
  for (let i = 0; i < bodies.length; i += 1) {
    for (let j = i + 1; j < bodies.length; j += 1) {
      const pair = `${bodies[i].kind}/${bodies[j].kind}`;
      assert.ok(dE(bodies[i].color, bodies[j].color) >= 25, `${pair} 本体色差只有 ${dE(bodies[i].color, bodies[j].color).toFixed(1)}，会看成一坨`);
      assert.ok(dE(bodies[i].cap, bodies[j].cap) >= 18, `${pair} 顶盖（俯视 fill）色差不足`);
    }
    assert.ok(dE(bodies[i].color, bodies[i].cap) >= 20, `${bodies[i].kind} 顶盖和本体没拉开，盒子读不出体积`);
  }
});

test("顶盖上那一个字读得清：墨色对底色 ΔE ≥ 45，且亮底走深墨、暗底走浅墨", () => {
  // 俯视容器格上的首字（掩/箱/弹/医/货/保）直接压在顶盖色上。旧版固定淡蓝白 #dbe4f2
  // 落在弹药 #f0ff8c、保险柜 #f6dd7e、货架 #9fe4f7 上 ΔE 只有个位数——字等于没画。
  const rgb = (css) => parseInt(css.slice(1), 16);
  for (const spec of Object.values(BLOCKS)) {
    const fill = cssHex(spec.cap);
    const ink = inkOn(fill);
    assert.ok(dE(rgb(ink), rgb(fill)) >= 45, `${spec.kind}：墨色 ${ink} 在底色 ${fill} 上只有 ${dE(rgb(ink), rgb(fill)).toFixed(1)}`);
  }
  // 六类可搜格子的顶盖都是亮色，所以字一律走深墨；地面/墙这类暗底才退回浅墨
  for (const spec of Object.values(BLOCKS).filter((s) => s.kind !== "wall")) {
    assert.ok(parseInt(inkOn(cssHex(spec.cap)).slice(1), 16) < 0x606060, `${spec.kind} 的亮顶盖上要用深墨`);
  }
  assert.equal(inkOn(cssHex(GROUND_COLORS.day.base)), "#eaf1fb", "暗底要用浅墨，别把字涂没");
  assert.equal(inkOn(cssHex(BLOCKS["#"].color)), "#eaf1fb", "墙本体是暗底，描在上面的字得是浅色");
});

test("配色不融进背景：本体对地面 ΔE ≥ 26、对雾 ≥ 22（昼与夜都要）", () => {
  // 上一版墙 #4a596e 对雾 #2a3444 只差 8 —— 距离一远墙就整个化进雾里，这是"分不清"的主要来源
  for (const slot of ["day", "night"]) {
    const ground = GROUND_COLORS[slot];
    const fog = LIGHTS[slot].fog;
    for (const spec of Object.values(BLOCKS)) {
      const againstGround = dE(spec.color, ground.base);
      const againstFog = dE(spec.color, fog);
      assert.ok(againstGround >= 26, `${slot}/${spec.kind} 与地面只差 ${againstGround.toFixed(1)}，竖直面弹不出来`);
      assert.ok(againstFog >= 22, `${slot}/${spec.kind} 与雾只差 ${againstFog.toFixed(1)}，远处会糊成一片`);
    }
    // 地面双色棋盘要看得见网格（光流线索），但又不能抢物体的对比
    assert.ok(dE(ground.base, ground.alt) >= 6, `${slot} 地面棋盘双色太弱，移动时没有参照`);
    assert.ok(dE(ground.base, ground.alt) <= 20, `${slot} 地面棋盘太花，会跟小物体抢注意力`);
  }
});

test("夜景不许压成全黑：地面与雾的绝对亮度、灯光强度都有下限", () => {
  // 上一版夜间（港口仓库）第一人称实测整屏 67% 落在 rgb(3,6,15)：ΔE 只管"两两相差多少"，
  // 全体一起压到 L*≈7 时色差照样达标，但人眼看出去是一片黑——晕眩和"分不清"同时回来。
  const lightness = (hex) => labOf(hex)[0];
  for (const slot of ["day", "night"]) {
    const ground = GROUND_COLORS[slot];
    const lights = LIGHTS[slot];
    assert.ok(lightness(ground.base) >= 10, `${slot} 地面 L*=${lightness(ground.base).toFixed(1)}，脚下没有参照物`);
    assert.ok(lightness(lights.fog) >= 16, `${slot} 雾 L*=${lightness(lights.fog).toFixed(1)}，远处会读成黑洞`);
    assert.ok(lightness(lights.fog) > lightness(ground.base), `${slot} 雾要比地面亮，空气透视才是"越远越淡"而不是"越远越黑"`);
    assert.ok(lights.hemi.intensity >= 0.9, `${slot} 半球光 ${lights.hemi.intensity} 太弱，麦兰忒材质会把一切乘成黑`);
    assert.ok(lights.sun.intensity >= 0.85, `${slot} 平行光 ${lights.sun.intensity} 太弱，盒子没有明暗面`);
    assert.ok(lightness(ground.alt) > lightness(ground.base), `${slot} 棋盘亮格应当确实更亮`);
  }
  // 夜还是要读得出是夜：总光强不许反超白天
  const sum = (slot) => LIGHTS[slot].hemi.intensity + LIGHTS[slot].sun.intensity;
  assert.ok(sum("night") < sum("day"), `夜间总光强 ${sum("night")} 追平/超过白天 ${sum("day")}，时段就没意义了`);
  assert.ok(LIGHTS.night.hemi.sky < LIGHTS.day.hemi.sky, "夜天的半球光应当更暗（色相偏冷由 sky 色本身负责）");
});

test("活体配色与场景错开：敌人三态对每类本体 ΔE ≥ 22", () => {
  for (const key of Object.keys(FIGURE_TONE)) {
    for (const spec of Object.values(BLOCKS)) {
      const d = dE(FIGURE_TONE[key].body, spec.color);
      assert.ok(d >= 22, `${key} 敌人与 ${spec.kind} 只差 ${d.toFixed(1)}，会把人看成箱子`);
    }
  }
  // 三态之间也要分得开：红/橙/紫是"要不要立刻反应"的语言
  const tones = Object.values(FIGURE_TONE);
  for (let i = 0; i < tones.length; i += 1) {
    for (let j = i + 1; j < tones.length; j += 1) {
      assert.ok(dE(tones[i].body, tones[j].body) >= 25, "敌人状态色彼此太近");
    }
  }
});

test("形状提示层：矮容器给亮顶盖、墙给视线带，实例数与实体格一一对应", () => {
  for (const def of MAPS) {
    const map = compileMap(def);
    const spec = buildSceneSpec(map);
    const count = (ch) => map.grid.reduce((sum, row) => sum + [...row].filter((c) => c === ch).length, 0);
    const total = Object.keys(BLOCKS).reduce((sum, ch) => sum + count(ch), 0);
    assert.equal(spec.marks.reduce((sum, g) => sum + g.items.length, 0), total, `${map.id}：提示层实例数与实体格不一致`);
    // groups 的不变量不能被装饰层污染（那条"盒子数 == 实体格数"仍然只数 groups）
    const boxed = spec.groups.filter((g) => !g.kind.startsWith("exfil-")).reduce((sum, g) => sum + g.items.length, 0);
    assert.equal(boxed, total, `${map.id}：主体盒子数被装饰层带偏了`);
    for (const spec2 of Object.values(BLOCKS)) {
      const mark = spec.marks.find((g) => g.kind === spec2.kind);
      assert.ok(mark, `${spec2.kind} 没有形状提示层`);
      const body = spec.groups.find((g) => g.kind === spec2.kind);
      assert.equal(mark.color, spec2.cap, `${spec2.kind} 提示层没用最亮的顶盖色`);
      if (spec2.mark === "band") {
        assert.ok(mark.size[0] > 1 && mark.size[2] > 1, "墙体视线带没外扩，邻墙相接处会被 Z 缓冲吃掉");
        assert.ok(Math.abs(mark.items[0].y - BAND_M.y) < 1e-9, "视线带不在眼睛高度");
        assert.ok(mark.items.every((i) => i.y < spec2.size[1]), "视线带跑到墙顶之上");
      } else {
        assert.ok(mark.size[0] < body.size[0] && mark.size[2] < body.size[2], `${spec2.kind} 顶盖比盒子还宽，读不出顶面`);
        assert.ok(mark.items.every((i) => i.y > spec2.size[1] - spec2.size[1] / 2), `${spec2.kind} 顶盖没贴盒顶`);
        assert.ok(mark.items.every((i) => i.y <= spec2.size[1] + 0.02), `${spec2.kind} 顶盖浮起来了，会闪`);
      }
      assert.deepEqual(JSON.stringify(spec.marks), JSON.stringify(buildSceneSpec(map).marks), `${map.id}：提示层两次构建不一致（不许随机数）`);
    }
  }
});

test("抗晕参数：起雾点推远、步态起伏与侧倾都有上限", () => {
  const map = compileMap(MAPS[0]);
  const spec = buildSceneSpec(map);
  assert.equal(spec.fog.near, FOG_FAR_M * FOG_NEAR_RATIO);
  assert.ok(spec.fog.near >= 12, `起雾点 ${spec.fog.near} m 太近，中景就发灰`);
  assert.ok(spec.fog.far > spec.fog.near, "雾的近远界反了");

  const idle = eyePose({ angle: 0.4, magnitude: 0, phase: 12.3 });
  assert.equal(idle.eyeY, EYE_M, "站着不动眼睛在飘");
  assert.equal(idle.bob, 0);
  assert.equal(idle.roll, 0);
  for (const phase of [0, 1.7, 3.5, 8.2, 21.9]) {
    const walk = eyePose({ angle: 0.4, magnitude: 1, phase });
    assert.ok(Math.abs(walk.roll) <= BOB_M.roll + 1e-12, `侧倾 ${walk.roll} 超过上限，屏幕在滚`);
    assert.ok(Math.abs(walk.bob) <= BOB_M.bob + 1e-12, "垂直起伏超过上限");
    assert.ok(Math.abs(walk.eyeY - EYE_M) <= BOB_M.eyeY + 1e-12, "眼高波动超过上限");
  }
  // 满速摇杆也不许超过上限
  const fast = eyePose({ angle: 0, magnitude: 9, phase: 4.4 });
  assert.ok(Math.abs(fast.roll) <= BOB_M.roll + 1e-12, "摇杆溢出没夹住，晃动会超幅");
});
