/**
 * 「危险行动」的 AI：六态状态机 + 视线感知节流 + 巡逻/搜索/找掩体。
 *
 * 边界（写在最前面，因为这是本文件最容易被人改坏的地方）：
 * - **只改自己**。AI 不直接扣玩家血量、不生成子弹，只把意图写进 `ai.intent`，由 game.js 消费。
 *   否则"掩体后不开枪""停火不产生噪音"这类判定会在两处各写一半，测试就钉不住了。
 * - **感知必须节流**。视线判定是 DDA，8 个 AI 每帧各算一次就是 8 次跨格遍历；
 *   这里缓存 0.15 s，并按 `id × 0.017` 错相，最坏情况才是"每帧约 8 次 DDA"而不是 8×60。
 * - 移动一律走 `moveWithCollision`（按轴分离）+ 卡死检测（0.4 s 位移 < 0.05 m 就换航点），
 *   这两条是"AI 卡进墙"的唯二解药，缺一个就会出现巡逻线上永远走不到头的机器人。
 */

import { WORLD, hasLineSight, moveWithCollision, nearestCover, circleFree } from "./map.js";
import { AI_LOADOUT, WEAPONS } from "./weapons.js";

export const AI_STATES = ["patrol", "alert", "chase", "engage", "search", "retreat"];

/** 视线缓存时长（秒） */
export const SIGHT_CACHE_SEC = 0.15;
/** 卡死判定：这段时间内位移不足这个米数就算卡住 */
export const STUCK_SEC = 0.4;
export const STUCK_DIST_M = 0.05;
/** 各状态的兜底超时：搜索 3 s 回巡逻，警戒 6 s 转搜索 */
export const SEARCH_SEC = 3;
export const ALERT_SEC = 6;
export const RETREAT_SEC = 5;
/** 血量比例低于这个值考虑后撤找掩体 */
export const LOW_HP_RATIO = 0.25;
export const COVER_RATION = 0.4;

const DIRS = 8;

/** 巡逻环：以出生点为中心向外试探 8 个方向，取放得下圆的格子作为航点 */
function buildRoute(map, spawn, rng) {
  const route = [{ x: spawn.x, y: spawn.y }];
  const radius = 5;
  const order = [];
  for (let i = 0; i < DIRS; i += 1) order.push(i);
  // rng 只用来打乱方向（AI 出生时一次，不在热循环里消耗随机数）
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const swap = order[i];
    order[i] = order[j];
    order[j] = swap;
  }
  for (const step of order) {
    if (route.length >= 4) break;
    const angle = (step / DIRS) * Math.PI * 2;
    const x = spawn.x + Math.cos(angle) * radius;
    const y = spawn.y + Math.sin(angle) * radius;
    if (x < 1 || y < 1 || x > map.width - 1 || y > map.height - 1) continue;
    if (!circleFree(map, x, y, WORLD.aiRadius + 0.06)) continue;
    route.push({ x, y });
  }
  return route;
}

export function createAi(index, spawn, map, rng = Math.random) {
  const tier = spawn.tier ?? 1;
  const load = AI_LOADOUT[tier] ?? AI_LOADOUT[1];
  const weapon = WEAPONS[load.weapon];
  const route = buildRoute(map, spawn, rng);
  return {
    id: index + 1,
    x: spawn.x,
    y: spawn.y,
    radius: WORLD.aiRadius,
    alive: true,
    tier,
    loadout: load,
    weapon,
    hp: load.hp,
    hpMax: load.hp,
    armorId: load.armor,
    speed: load.speed,
    sightRangeM: load.sightM,
    engagementRangeM: weapon.rangeM * 0.75,
    angle: 0,
    state: "patrol",
    stateTime: 0,
    route,
    waypoint: 0,
    targetX: spawn.x,
    targetY: spawn.y,
    lastSeenX: spawn.x,
    lastSeenY: spawn.y,
    sees: false,
    hears: false,
    lostSightSec: 0,
    sightTimer: (index * 0.017) % SIGHT_CACHE_SEC,
    coverTimer: 0,
    cover: null,
    reachedCover: false,
    fireCooldown: load.fireDelaySec,
    /**
     * 点射纪律（AI 与玩家 DPS 差距的唯一实现处）：
     * 一发之间的间隔刻意取玩家射速的两倍，打完 burst 发再整段停火 fireDelaySec×2。
     * 若按 60/rpm 连开，一把 tier1 手枪就是 97 伤害/秒，玩家 185 有效血量两秒蒸发，
     * "搜打撤"会变成"出门即死"。
     */
    shotGapSec: (60 / Math.max(1, weapon.rpm)) * 2,
    burstRestSec: load.fireDelaySec * 2,
    burstLeft: load.burst,
    mag: weapon.mag,
    reloadTimer: 0,
    stuckTimer: 0,
    prevX: spawn.x,
    prevY: spawn.y,
    sweepTimer: 0,
    sweepAngle: 0,
    intent: { moveX: 0, moveY: 0, fire: false, aimAngle: 0 },
  };
}

export function hpRatio(ai) {
  return ai.hpMax > 0 ? Math.max(0, ai.hp) / ai.hpMax : 0;
}

/**
 * 纯函数状态转移：只读当前状态与感知结果，不写任何字段。
 * 单独抽出来是因为"巡逻→警戒→追击→交火"这条链是本游戏可玩性的骨架，必须能脱离移动逻辑被证明。
 */
export function nextAiState(ai, ctx) {
  const low = ctx.hpRatio < LOW_HP_RATIO;
  const wantRetreat = low && ctx.cover !== null;
  switch (ai.state) {
    case "patrol":
      if (ctx.sees) return wantRetreat ? "retreat" : "chase";
      if (ctx.hears) return "alert";
      return "patrol";
    case "alert":
      if (ctx.sees) return wantRetreat ? "retreat" : "chase";
      if (ai.stateTime > ALERT_SEC) return "search";
      return "alert";
    case "chase":
      if (wantRetreat) return "retreat";
      if (!ctx.sees && ai.stateTime > 2.5) return "search";
      if (ctx.sees && ctx.dist <= ai.engagementRangeM) return "engage";
      return "chase";
    case "engage":
      if (wantRetreat) return "retreat";
      if (!ctx.sees) return "search";
      if (ctx.dist > ai.engagementRangeM * 1.3) return "chase";
      return "engage";
    case "search":
      if (ctx.sees) return wantRetreat ? "retreat" : "chase";
      if (ai.stateTime > SEARCH_SEC) return "patrol";
      return "search";
    case "retreat":
      if (ctx.hpRatio > COVER_RATION && ctx.sees) return "engage";
      if (ai.stateTime > RETREAT_SEC) return "alert";
      if (ctx.reachedCover) return ctx.sees ? "engage" : "alert";
      return "retreat";
    default:
      return "patrol";
  }
}

/**
 * 感知：带缓存的玩家可见性。
 * smokeAt(a, b) 由 game.js 提供（烟幕归它管，map 与 ai 都不知道有烟这东西）。
 * 返回本轮是否看见玩家，同时刷新 lastSeen 与 lostSightSec。
 */
export function perceive(ai, player, map, dt, { smokeAt = null, sightFactor = 1 } = {}) {
  ai.sightTimer -= dt;
  if (ai.sightTimer > 0) return ai.sees;
  ai.sightTimer = SIGHT_CACHE_SEC;

  const dx = player.x - ai.x;
  const dy = player.y - ai.y;
  const dist = Math.hypot(dx, dy);
  const range = ai.sightRangeM * sightFactor;
  let sees = false;
  if (player.alive && dist <= range) {
    sees = hasLineSight(map, ai, player);
    if (sees && smokeAt) sees = !smokeAt(ai, player);
  }
  if (sees) {
    ai.lastSeenX = player.x;
    ai.lastSeenY = player.y;
    ai.lostSightSec = 0;
  } else {
    ai.lostSightSec += SIGHT_CACHE_SEC;
  }
  ai.sees = sees;
  return sees;
}

const moveOut = { x: 0, y: 0 };
const coverProbe = { x: 0, y: 0, gx: 0, gy: 0 };

function setGoal(ai, x, y) {
  ai.targetX = x;
  ai.targetY = y;
}

function advanceWaypoint(ai) {
  ai.waypoint = (ai.waypoint + 1) % ai.route.length;
  const node = ai.route[ai.waypoint];
  setGoal(ai, node.x, node.y);
}

/**
 * 单帧推进一个 AI：算状态 → 定目标点 → 移动（带碰撞与卡死检测）→ 写意图。
 * 血量、子弹、噪音一律由 game.js 在消费 intent 时结算。
 */
export function updateAi(ai, world, dt) {
  const { map, player, rng = Math.random } = world;
  ai.stateTime += dt;

  const dx = player.x - ai.x;
  const dy = player.y - ai.y;
  const dist = Math.hypot(dx, dy);

  ai.coverTimer -= dt;
  if (ai.coverTimer <= 0) {
    ai.coverTimer = 0.5;
    ai.cover = hpRatio(ai) < LOW_HP_RATIO || ai.state === "retreat"
      ? nearestCover(map, ai, { x: player.x, y: player.y }, { radius: WORLD.aiRadius, maxDist: 9 }, coverProbe)
      : null;
  }

  const before = nextAiState(ai, {
    sees: ai.sees,
    hears: ai.hears,
    dist,
    hpRatio: hpRatio(ai),
    cover: ai.cover,
    reachedCover: ai.reachedCover,
  });
  if (before !== ai.state) {
    ai.state = before;
    ai.stateTime = 0;
    ai.reachedCover = false;
    if (before === "search") {
      // 搜索扫视方向是 rng 消耗点之一
      ai.sweepAngle = rng() * Math.PI * 2;
    }
  }

  switch (ai.state) {
    case "patrol": {
      const node = ai.route[ai.waypoint];
      setGoal(ai, node.x, node.y);
      break;
    }
    case "alert":
      setGoal(ai, ai.lastSeenX, ai.lastSeenY);
      break;
    case "chase":
      setGoal(ai, ai.sees ? player.x : ai.lastSeenX, ai.sees ? player.y : ai.lastSeenY);
      break;
    case "engage": {
      // 太近就拉开，其余情况站定开火（顶不住才跑，见 retreat 分支）
      const ideal = ai.engagementRangeM * 0.55;
      if (dist < ideal) setGoal(ai, ai.x - dx, ai.y - dy);
      else {
        ai.targetX = ai.x;
        ai.targetY = ai.y;
      }
      break;
    }
    case "search": {
      ai.sweepTimer -= dt;
      if (ai.sweepTimer <= 0) {
        ai.sweepTimer = 1.1;
        ai.sweepAngle = rng() * Math.PI * 2;
      }
      const radius = Math.min(4, 1.2 + ai.stateTime * 0.9);
      setGoal(ai, ai.lastSeenX + Math.cos(ai.sweepAngle) * radius, ai.lastSeenY + Math.sin(ai.sweepAngle) * radius);
      break;
    }
    case "retreat": {
      if (ai.cover) {
        setGoal(ai, ai.cover.x, ai.cover.y);
        ai.reachedCover = Math.hypot(ai.cover.x - ai.x, ai.cover.y - ai.y) < 0.4;
      } else {
        setGoal(ai, ai.lastSeenX, ai.lastSeenY);
      }
      break;
    }
    default:
      break;
  }

  const step = ai.state === "patrol" ? ai.speed * 0.55 : ai.speed;
  const toX = ai.targetX - ai.x;
  const toY = ai.targetY - ai.y;
  const gap = Math.hypot(toX, toY);
  ai.intent.moveX = 0;
  ai.intent.moveY = 0;
  if (gap > 0.18) {
    const move = Math.min(step * dt, gap);
    moveWithCollision(map, ai, (toX / gap) * move, (toY / gap) * move, ai.radius, moveOut);
    ai.x = moveOut.x;
    ai.y = moveOut.y;
    ai.intent.moveX = toX / gap;
    ai.intent.moveY = toY / gap;
  }

  // 卡死：连续 STUCK_SEC 位移不足 STUCK_DIST_M 就换下一个航点
  ai.stuckTimer += dt;
  if (ai.stuckTimer >= STUCK_SEC) {
    const moved = Math.hypot(ai.x - ai.prevX, ai.y - ai.prevY);
    ai.stuckTimer = 0;
    ai.prevX = ai.x;
    ai.prevY = ai.y;
    if (moved < STUCK_DIST_M) {
      if (ai.state === "patrol") advanceWaypoint(ai);
      else {
        advanceWaypoint(ai);
        ai.state = ai.state === "patrol" ? "patrol" : "alert";
        ai.stateTime = 0;
      }
    }
  }

  // 到点：巡逻环换航点
  if (ai.state === "patrol" && gap < 0.35) advanceWaypoint(ai);

  // 瞄准意图：看得见就打玩家，否则打去过的地方
  ai.intent.aimAngle = ai.sees ? Math.atan2(dy, dx) : Math.atan2(ai.lastSeenY - ai.y, ai.lastSeenX - ai.x);
  let diff = ai.intent.aimAngle - ai.angle;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  const turnRate = 6 * dt;
  ai.angle += Math.abs(diff) < turnRate ? diff : Math.sign(diff) * turnRate;

  if (ai.reloadTimer > 0) {
    ai.reloadTimer -= dt;
    if (ai.reloadTimer <= 0) ai.mag = ai.weapon.mag;
  } else if (ai.mag <= 0) {
    ai.reloadTimer = ai.weapon.reloadSec;
  }
  ai.intent.fire = ai.state === "engage" && ai.sees && ai.mag > 0 && ai.reloadTimer <= 0;

  ai.hears = false;
}
