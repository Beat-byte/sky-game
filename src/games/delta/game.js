/**
 * 「危险行动」引擎总装：实体世界 + 固定步长主循环 + 搜刮/撤离/时限/技能 + 结算。
 *
 * 这个文件是 delta 里唯一"知道全局"的一层，但依然**不认识浏览器**：
 * 没有 import vue、没有 DOM、没有 localStorage；落盘由 DeltaView.vue 通过 store 完成。
 *
 * 三条硬约定，改动前务必读：
 * 1. **固定步长**：`FIXED_STEP = 1/60`，一帧最多补 `MAX_STEPS = 3` 步，外部传进来的 delta 先夹到
 *    `MAX_DELTA = 0.05`。于是"30 步 1/60"与"15 步 1/30"结果完全相同（帧率无关测试钉住），
 *    而"后台标签回来那一坨 2 秒"不会把任务时限直接吃掉。
 * 2. **时限用引擎累加时间**，不是 `Date.now()` ⇒ 暂停与后台标签不消耗时限。
 * 3. **随机数只有 5 个消耗点**（巡逻环方向、掉落件数与选品、AI 散布、搜索扫视、弹道散布），
 *    地图 id 由调用方指定、禁止 rng 选图 ⇒ 同一份 rng 整局可复现，回归测试靠它。
 *
 * 阶段顺序固定在 `ORDER` 里，`debug:true` 时逐阶段记录进 `this.trace`。
 * 顺序不是风格问题：感知若排在 AI 之后，AI 就"这一帧看见、下一帧才反应"，
 * 表现成"站在面前却延迟开枪"，而这种偏移没有任何单元测试能发现。
 */

import {
  WORLD,
  MAPS,
  compileMap,
  mapById,
  hasLineSight,
  moveWithCollision,
  CONTAINERS,
} from "./map.js";
import { WEAPONS, AMMO, ARMORS, HELMETS, MEDS, DEFAULTS, AI_LOADOUT, weaponOf, bagOf, armorOf } from "./weapons.js";
import { rollLoot, fits, totalValue, ITEMS } from "./loot.js";
import { createBulletPool, fireBullet, stepBullets, selectTarget, resolveDamage, clearBullets } from "./combat.js";
import { createAi, perceive, updateAi } from "./ai.js";

export const FIXED_STEP = 1 / 60;
export const MAX_STEPS = 3;
export const MAX_DELTA = 0.05;
export const QUEUE_LIMIT = 4;

export const ORDER = [
  "flushInput",
  "playerMove",
  "perceive",
  "ai",
  "autoFire",
  "bullets",
  "hits",
  "search",
  "exfil",
  "clock",
  "fx",
  "outcome",
];

export const ACTIONS = ["interact", "stop-search", "skill", "fire-toggle", "reload", "med", "aim"];

/** 四态结算：economy.js 的 settleRaid 只认这四个值 */
export const OUTCOMES = new Set(["escaped", "killed", "timeout", "aborted"]);

/** 技能二选一，每局两次、冷却 12 秒（耗尽后 HUD 灰掉，不再产生任何副作用） */
export const SKILL_RULES = {
  smoke: { uses: 2, cooldownSec: 12, label: "烟幕", desc: "在脚下投掷烟幕，8 秒内阻断视线" },
  pulse: { uses: 2, cooldownSec: 12, label: "脉冲", desc: "标记所有敌人位置 6 秒" },
};

export const SMOKE_SEC = 8;
export const SMOKE_RADIUS = 5;
export const SMOKE_MAX = 4;
export const PULSE_SEC = 6;
const TARGET_AIM_SPEED = 9;
/** 单步最多消化多少转向：一次甩屏可以很大，但不能把整帧的转向攒成"瞬间回头 180°" */
const MAX_LOOK_PER_STEP = 1.0;

/** 弧度折回 [-π, π]：第一人称的 yaw 会一直累加，折回后 HUD 与 3D 相机都能稳定读 */
function wrapAngle(rad) {
  const two = Math.PI * 2;
  return ((rad + Math.PI) % two + two) % two - Math.PI;
}

const DEFAULTS_BAG = { slots: DEFAULTS.bagSlots, massMax: DEFAULTS.bagMassMax, label: "战术携行具" };
const moveScratch = { x: 0, y: 0 };

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** 到 1×1 格子边的最短距离（格子坐标是格心）：贴边站立时为 0，隔一格为 1 */
function edgeDistance(cell, point) {
  const dx = Math.max(Math.abs(point.x - cell.x) - 0.5, 0);
  const dy = Math.max(Math.abs(point.y - cell.y) - 0.5, 0);
  return Math.hypot(dx, dy);
}

function spreadFor(weapon, moving, rng) {
  return (rng() * 2 - 1) * weapon.spreadRad * (moving ? 1.6 : 1);
}

function weaponForShooter(id, ais, fallback) {
  for (const ai of ais) if (ai.id === id) return ai.weapon;
  return fallback;
}

function armorForAi(ai) {
  const id = AI_LOADOUT[ai.tier]?.armor;
  return id ? ARMORS[id] : null;
}

function xpFor({ outcome, kills, searched, value }) {
  const base = kills * 80 + searched * 15 + Math.round(value * 0.02);
  if (outcome === "escaped") return base + 400;
  if (outcome === "killed" || outcome === "timeout") return Math.round(base * 0.35);
  return Math.round(base * 0.2);
}

function segmentHitsCircle(ax, ay, bx, by, cx, cy, r) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  const proj = lenSq > 0 ? clamp(((cx - ax) * dx + (cy - ay) * dy) / lenSq, 0, 1) : 0;
  const nx = ax + dx * proj - cx;
  const ny = ay + dy * proj - cy;
  return nx * nx + ny * ny <= r * r;
}

/** 粒子池：预分配 + alive 标志，渲染层只读不写 */
function createParticlePool(cap) {
  const items = [];
  for (let i = 0; i < cap; i += 1) items.push({ alive: false, x: 0, y: 0, vx: 0, vy: 0, ttl: 0, life: 0, kind: "spark" });
  let cursor = 0;
  const pick = () => {
    for (let i = 0; i < items.length; i += 1) {
      const index = (cursor + i) % items.length;
      if (!items[index].alive) {
        cursor = index;
        return items[index];
      }
    }
    cursor = (cursor + 1) % items.length;
    return items[cursor];
  };
  return {
    items,
    spark(x, y, vx, vy) {
      const found = pick();
      found.alive = true;
      found.x = x;
      found.y = y;
      found.vx = vx;
      found.vy = vy;
      found.life = 0.24;
      found.ttl = 0.24;
      found.kind = "spark";
    },
    step(dt) {
      for (const item of items) {
        if (!item.alive) continue;
        item.ttl -= dt;
        item.x += item.vx * dt;
        item.y += item.vy * dt;
        item.vx *= 0.86;
        item.vy *= 0.86;
        if (item.ttl <= 0) item.alive = false;
      }
    },
    count() {
      let n = 0;
      for (const item of items) if (item.alive) n += 1;
      return n;
    },
  };
}

/** 命中事件缓冲：一帧最多 cap 条，就地复用，热循环不新建对象 */
function createHitBuffer(cap) {
  const items = [];
  for (let i = 0; i < cap; i += 1) items.push({ target: null, owner: 0, damage: 0, x: 0, y: 0, traveled: 0, angle: 0 });
  return {
    items,
    count: 0,
    add(target, bullet) {
      if (this.count >= items.length) return;
      const entry = items[this.count++];
      entry.target = target;
      entry.owner = bullet.owner;
      entry.damage = bullet.damage;
      entry.x = bullet.x;
      entry.y = bullet.y;
      entry.traveled = bullet.traveled;
      entry.angle = Math.atan2(bullet.vy, bullet.vx);
    },
  };
}

export class Delta {
  constructor({ mapId = MAPS[0].id, loadout = {}, rng = Math.random, skill = null, debug = false } = {}) {
    const def = mapById(mapId) ?? mapById(MAPS[0].id);
    this.map = compileMap(def);
    this.rng = rng;
    this.debug = debug;
    this.trace = [];

    this.loadout = loadout && typeof loadout === "object" ? loadout : {};
    this.weapon = weaponOf(this.loadout.primary) ?? weaponOf(this.loadout.sidearm) ?? WEAPONS[DEFAULTS.sidearm];
    this.bagSpec = bagOf(this.loadout.bag) ?? DEFAULTS_BAG;
    this.armorSpec = armorOf(this.loadout.armor);
    this.helmetSpec = HELMETS[this.loadout.helmet] ?? null;

    this.player = {
      id: 0,
      isPlayer: true,
      x: this.map.spawn.x,
      y: this.map.spawn.y,
      radius: WORLD.playerRadius,
      hp: WORLD.playerHp,
      hpMax: WORLD.playerHp,
      alive: true,
      angle: 0,
      armorAbsorb: this.armorSpec?.absorb ?? DEFAULTS.armorAbsorb,
      armorDur: clamp(this.loadout.armorDur ?? this.armorSpec?.durMax ?? 0, 0, this.armorSpec?.durMax ?? 0),
      helmetAbsorb: this.helmetSpec?.absorb ?? DEFAULTS.helmetAbsorb,
      helmetDur: clamp(this.loadout.helmetDur ?? this.helmetSpec?.durMax ?? 0, 0, this.helmetSpec?.durMax ?? 0),
    };

    // 口径不对 ⇒ 弹匣空了就是彻底停火（与"备弹为零"同一结局，测试分别钉住）
    this.ammoKind = AMMO[this.loadout.ammo?.kind] ? this.loadout.ammo.kind : this.weapon.ammo;
    this.ammoMatched = this.ammoKind === this.weapon.ammo;
    this.ammoReserve = this.ammoMatched ? Math.max(0, Math.floor(this.loadout.ammo?.count ?? 0)) : 0;
    this.mag = this.ammoMatched ? this.weapon.mag : 0;
    this.meds = Math.max(0, Math.floor(this.loadout.meds ?? 0));

    this.bag = [];
    this.overload = [];
    this.exfilHoldSec = 0;
    this.timeSec = 0;
    this.status = "ready";
    this.endReason = null;
    this.settlement = null;

    this.fireEnabled = true;
    this.triggerHeld = false;
    this.reloading = 0;
    this.fireCooldown = 0;
    this.medCooldown = 0;
    this.searchTarget = null;
    this.searchProgress = 0;

    this.bullets = createBulletPool(WORLD.maxBullets);
    this.ais = [];
    this.targets = [this.player];
    this.groundBags = [];
    this.smokes = [];
    this.particles = createParticlePool(WORLD.maxParticles);
    this.pendingHits = createHitBuffer(WORLD.maxBullets);
    this.noise = { x: 0, y: 0, ttl: 0 };
    this.pulse = { ttl: 0 };
    this.skill = { name: SKILL_RULES[skill] ? skill : null, uses: SKILL_RULES[skill]?.uses ?? 0, cooldown: 0 };
    this.fx = { phase: 0, shake: 0, muzzle: null, hitMarker: null };
    this.stats = { kills: 0, searched: 0, shots: 0, damageDealt: 0 };

    this.stick = { x: 0, y: 0 };
    /** 视图模式与待消化转向：只改"摇杆向量怎么解释"，不改任何玩法量（见 setViewMode） */
    this.viewMode = "topdown";
    this.lookPending = 0;
    /** 本步是否真的消化过转向：俯视下用来让"走路自动回头"给手动转身让路（见 turnPlayer） */
    this.turnedThisStep = false;
    this.queue = [];
    this.acc = 0;
    this.sightFactor = this.map.sightFactor ?? 1;

    const spawnCount = Math.min(WORLD.maxAi, this.map.aiSpawns.length);
    for (let i = 0; i < spawnCount; i += 1) {
      const ai = createAi(i, this.map.aiSpawns[i], this.map, this.rng);
      const armor = armorForAi(ai);
      ai.armorHp = armor?.durMax ?? 0;
      this.ais.push(ai);
      this.targets.push(ai);
    }
  }

  /** 唯一摇杆入口：输入层负责死区与归一化，这里只再夹一次保险 */
  setStick(nx, ny) {
    this.stick.x = clamp(Number(nx) || 0, -1, 1);
    this.stick.y = clamp(Number(ny) || 0, -1, 1);
  }

  /**
   * 视图模式：topdown 推哪走哪（朝向=移动方向），fps 摇杆变相对朝向的"前后＋平移"，
   * 转身只走 setLook。切换只改向量的解释方式，速度/锥形/伤害一律不变，
   * 所以两种视图的玩法强度完全相同。
   */
  setViewMode(mode) {
    this.viewMode = mode === "fps" ? "fps" : "topdown";
    this.lookPending = 0;
    return this.viewMode;
  }

  /** 转向采样通道（与 setStick 同类）：事件回调只累加，真正改角度发生在 step 里 */
  setLook(radians) {
    const value = Number(radians);
    if (!Number.isFinite(value)) return;
    this.lookPending = clamp(this.lookPending + value, -MAX_LOOK_PER_STEP, MAX_LOOK_PER_STEP);
  }

  /**
   * 按住式扳机（吃鸡手游那套）：按住就沿当前枪口方向出枪，不需要视野里有敌人，
   * 松手立刻停 —— 事件回调只做这一件事，真正的开火节奏仍然发生在 autoFire 里。
   * 它与"自动开火"（fireEnabled，空格切换）是两条独立通道：扳机不改动 fireEnabled，
   * 所以玩家按住扳机不会把自动开火的状态搞乱。
   */
  setTrigger(pressed) {
    this.triggerHeld = Boolean(pressed);
    return this.triggerHeld;
  }

  /**
   * 每步先消化转向，再移动：这样"边转身边走"在一帧里顺序稳定、可复现。
   * 俯视也吃这一路 —— 底部双摇杆要"站着不动只转身"（推右摇杆、左摇杆归零），
   * 旧版把俯视的转向直接丢掉，等于右摇杆在默认视图里是摆设。
   * turnedThisStep 只在这一步真消化了非零转向时为真，movePlayer 据此决定要不要恢复"推哪走哪"。
   */
  turnPlayer() {
    if (this.lookPending === 0 || !this.player.alive) {
      this.lookPending = 0;
      this.turnedThisStep = false;
      return;
    }
    const turn = this.lookPending;
    this.lookPending = 0;
    this.player.angle = wrapAngle(this.player.angle + turn);
    this.turnedThisStep = this.viewMode !== "fps";
  }

  /** 动作排队（上限 4），全部在 flushInput 阶段消费，绝不在事件回调里直接改状态 */
  enqueue(action, payload = null) {
    if (!ACTIONS.includes(action)) return false;
    if (this.queue.length >= QUEUE_LIMIT) return false;
    this.queue.push({ action, payload });
    return true;
  }

  step(dt = FIXED_STEP) {
    const clamped = clamp(Number(dt) || 0, 0, MAX_DELTA);
    this.acc += clamped;
    let used = 0;
    while (this.acc >= FIXED_STEP && used < MAX_STEPS) {
      this.stepFixed(FIXED_STEP);
      this.acc -= FIXED_STEP;
      used += 1;
      if (this.status === "won" || this.status === "over") break;
    }
    // 补帧上限之后的积压直接丢弃：宁可掉渲染帧，也不让主循环追不上现实时间
    if (this.acc > FIXED_STEP * MAX_STEPS) this.acc = 0;
    return used;
  }

  stepFixed(dt = FIXED_STEP) {
    if (this.status === "won" || this.status === "over") return;
    if (this.status === "ready") this.status = "running";
    if (this.debug) this.trace.length = 0;
    const stage = (name) => {
      if (this.debug) this.trace.push(name);
    };

    stage("flushInput");
    this.flushInput();

    stage("playerTurn");
    this.turnPlayer();

    stage("playerMove");
    this.movePlayer(dt);

    stage("perceive");
    for (const ai of this.ais) {
      if (!ai.alive || ai.isGhost) continue;
      perceive(ai, this.player, this.map, dt, { smokeAt: (a, b) => this.smokeBlocks(a, b), sightFactor: this.sightFactor });
      if (this.noise.ttl > 0) {
        if (Math.hypot(ai.x - this.noise.x, ai.y - this.noise.y) <= WORLD.noiseRadiusM) ai.hears = true;
      }
    }

    stage("ai");
    for (const ai of this.ais) {
      if (!ai.alive || ai.isGhost) continue;
      updateAi(ai, { map: this.map, player: this.player, rng: this.rng }, dt);
      if (ai.intent.fire) this.fireAi(ai);
    }

    stage("autoFire");
    this.autoFire(dt);

    stage("bullets");
    this.pendingHits.count = 0;
    stepBullets(this.map, this.bullets, this.targets, this.targets.length, dt, {
      onHit: (target, bullet) => this.pendingHits.add(target, bullet),
      onWall: (x, y) => this.particles.spark(x, y, 0, 0),
    });

    stage("hits");
    this.applyHits();

    stage("search");
    this.updateSearch(dt);

    stage("exfil");
    this.updateExfil(dt);

    stage("clock");
    this.timeSec += dt;
    this.tickTimers(dt);

    stage("fx");
    this.fx.phase += dt;
    this.fx.shake = Math.max(0, this.fx.shake - dt * 3);
    this.particles.step(dt);

    stage("outcome");
    this.judgeOutcome();
  }

  flushInput() {
    for (const entry of this.queue) {
      switch (entry.action) {
        case "interact":
          this.beginSearch();
          break;
        case "stop-search":
          this.searchTarget = null;
          this.searchProgress = 0;
          break;
        case "skill":
          this.useSkill();
          break;
        case "fire-toggle":
          this.fireEnabled = !this.fireEnabled;
          break;
        case "reload":
          this.startReload();
          break;
        case "med":
          this.useMed();
          break;
        case "aim":
          if (entry.payload) this.player.angle = Math.atan2(entry.payload.y - this.player.y, entry.payload.x - this.player.x);
          break;
        default:
          break;
      }
    }
    this.queue.length = 0;
  }

  movePlayer(dt) {
    if (!this.player.alive) return;
    const magnitude = Math.hypot(this.stick.x, this.stick.y);
    if (magnitude < 1e-3) return;
    const scale = Math.min(1, magnitude);
    const stickX = (this.stick.x / magnitude) * scale;
    const stickY = (this.stick.y / magnitude) * scale;
    let dirX = stickX;
    let dirY = stickY;
    if (this.viewMode === "fps") {
      // 摇杆给的是屏幕方向：向上=面朝前方，左右=平移；世界方向要按当前朝向旋转
      const cos = Math.cos(this.player.angle);
      const sin = Math.sin(this.player.angle);
      dirX = -sin * stickX - cos * stickY;
      dirY = cos * stickX - sin * stickY;
    }
    const move = WORLD.playerSpeed * dt;
    moveWithCollision(this.map, this.player, dirX * move, dirY * move, this.player.radius, moveScratch);
    this.player.x = moveScratch.x;
    this.player.y = moveScratch.y;
    // 俯视沿用"推哪走哪"；第一人称的朝向归 setLook 管，走路不得偷偷回头。
    // 例外：这一步玩家正用右摇杆手动转身，走路不能再把身体拧回移动方向。
    if (this.viewMode !== "fps" && !this.turnedThisStep) this.player.angle = Math.atan2(dirY, dirX);
    // 一动就打断搜刮：否则可以"边走边翻箱子"绕过站桩风险
    if (this.searchTarget) {
      this.searchTarget = null;
      this.searchProgress = 0;
    }
  }

  smokeBlocks(a, b) {
    for (const smoke of this.smokes) {
      if (smoke.ttl <= 0) continue;
      if (segmentHitsCircle(a.x, a.y, b.x, b.y, smoke.x, smoke.y, smoke.r)) return true;
    }
    return false;
  }

  /** 玩家与 AI 共用同一次对称判定，避免"我能看见他、他看不见我"的单向穿墙 */
  visible(from, to) {
    if (!hasLineSight(this.map, from, to)) return false;
    return !this.smokeBlocks(from, to);
  }

  autoFire(dt) {
    if (!this.player.alive || this.reloading > 0) return;
    if (!this.fireEnabled && !this.triggerHeld) return;
    if (this.mag <= 0) {
      this.startReload();
      return;
    }
    const target = selectTarget(this.player, this.ais, this.ais.length, {
      rangeM: this.weapon.rangeM,
      coneRad: WORLD.fireConeRad,
      visible: (a, b) => this.visible(a, b),
    });
    // 扳机是"我就是要朝这个方向打"，视野里没人也得响；自动开火仍然只挑得到的人
    if (!target && !this.triggerHeld) return;
    const aim = target ? Math.atan2(target.y - this.player.y, target.x - this.player.x) : this.player.angle;
    // 追瞄只在玩家这一步没自己转身时归正枪口：右摇杆是"我要朝这儿打"，不能被归正拽回去
    if (target && this.viewMode !== "fps" && !this.turnedThisStep) {
      let diff = aim - this.player.angle;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      // 追瞄有角速度上限：否则枪口与摇杆方向彻底无关，玩家失去"朝向"这个概念
      const turn = TARGET_AIM_SPEED * dt;
      this.player.angle += Math.abs(diff) < turn ? diff : Math.sign(diff) * turn;
    }
    if (this.fireCooldown > 0) return;
    const moving = Math.hypot(this.stick.x, this.stick.y) > 0.15;
    this.fireShot(this.player, this.weapon, aim + spreadFor(this.weapon, moving, this.rng));
    this.fireCooldown = 60 / Math.max(1, this.weapon.rpm);
    this.mag -= 1;
  }

  fireAi(ai) {
    ai.intent.fire = false;
    if (ai.fireCooldown > 0) return;
    if (ai.burstLeft <= 0) {
      ai.burstLeft = ai.loadout.burst;
      ai.fireCooldown = ai.burstRestSec;
      return;
    }
    const angle = ai.intent.aimAngle + (this.rng() * 2 - 1) * ai.loadout.accuracyRad;
    this.fireShot(ai, ai.weapon, angle);
    ai.mag -= 1;
    ai.burstLeft -= 1;
    ai.fireCooldown = ai.shotGapSec;
  }

  fireShot(shooter, weapon, angle) {
    const spec = AMMO[weapon.ammo];
    const damage = Math.max(1, weapon.damage * (spec?.damageMul ?? 1));
    const bullet = fireBullet(this.bullets, {
      x: shooter.x + Math.cos(angle) * (shooter.radius + 0.12),
      y: shooter.y + Math.sin(angle) * (shooter.radius + 0.12),
      angle,
      speedMps: weapon.speedMps,
      damage,
      rangeM: weapon.rangeM,
      owner: shooter.id,
    });
    if (!bullet) return null;
    this.noise.x = shooter.x;
    this.noise.y = shooter.y;
    this.noise.ttl = 0.35;
    this.fx.muzzle = { x: bullet.px, y: bullet.py, angle, ttl: 0.06, owner: shooter.id };
    if (shooter.isPlayer) this.stats.shots += 1;
    return bullet;
  }

  applyHits() {
    const buffer = this.pendingHits;
    for (let i = 0; i < buffer.count; i += 1) {
      const entry = buffer.items[i];
      const target = entry.target;
      if (!target || !target.alive) continue;
      const shooterIsPlayer = entry.owner === 0;
      const weapon = shooterIsPlayer ? this.weapon : weaponForShooter(entry.owner, this.ais, this.weapon);
      const armorSpec = target.isPlayer ? this.armorSpec : armorForAi(target);
      const { damage, wear } = resolveDamage({
        base: entry.damage,
        distanceM: entry.traveled,
        rangeM: weapon?.rangeM ?? 24,
        armorAbsorb: armorSpec?.absorb ?? 0,
        armorDur: target.isPlayer ? target.armorDur : target.armorHp ?? 0,
        helmetAbsorb: target.isPlayer ? target.helmetAbsorb : 0,
        helmetDur: target.isPlayer ? target.helmetDur : 0,
      });
      target.hp -= damage;
      if (target.isPlayer) {
        if (target.armorDur > 0) target.armorDur = Math.max(0, target.armorDur - wear);
        else if (target.helmetDur > 0) target.helmetDur = Math.max(0, target.helmetDur - wear);
        this.fx.shake = Math.min(1, this.fx.shake + damage / 60);
      } else if (shooterIsPlayer) {
        this.stats.damageDealt += damage;
        target.armorHp = Math.max(0, (target.armorHp ?? 0) - wear);
      }
      this.particles.spark(entry.x, entry.y, Math.cos(entry.angle) * 2, Math.sin(entry.angle) * 2);
      if (shooterIsPlayer) this.fx.hitMarker = { ttl: 0.25, x: target.x, y: target.y };
      if (target.hp <= 0) {
        target.hp = 0;
        target.alive = false;
        if (target.isPlayer) this.endReason = this.endReason ?? "killed";
        else {
          this.stats.kills += 1;
          this.dropBag(target);
        }
      }
    }
    buffer.count = 0;
  }

  dropBag(ai) {
    if (this.groundBags.length >= WORLD.maxGroundBags) return;
    const items = [{ key: ai.loadout.weapon, qty: 1 }];
    const extra = rollLoot("crate", { mapTier: this.map.lootTier, night: this.map.timeSlot === "night", rng: this.rng });
    for (const entry of extra.items) items.push(entry);
    this.groundBags.push({
      x: ai.x,
      y: ai.y,
      gx: Math.floor(ai.x),
      gy: Math.floor(ai.y),
      kind: "bag",
      label: "阵亡者背包",
      searchSec: CONTAINERS.cover.searchSec,
      items,
    });
  }

  beginSearch() {
    if (this.searchTarget || !this.player.alive) return;
    const found = this.nearestSearchable();
    if (!found) return;
    this.searchTarget = found;
    this.searchProgress = 0;
  }

  /**
   * 返回一个全新的快照对象：调用方会把目标存进 searchTarget，复用缓冲区会让两处指向同一份数据。
   * 距离按"到格子边的距离"量（不是格子中心）——玩家圆被实体格挡住时，中心距永远差 0.2 m，
   * 表现为"贴着箱子却按不出搜刮"，而这是全局最容易让玩家判定游戏坏掉的 bug。
   */
  nearestSearchable() {
    let best = null;
    let bestDist = WORLD.interactRange;
    const consider = (entry, label, asCell) => {
      const dist = asCell ? edgeDistance(entry, this.player) : Math.hypot(entry.x - this.player.x, entry.y - this.player.y);
      if (dist > bestDist) return;
      bestDist = dist;
      best = {
        x: entry.x,
        y: entry.y,
        gx: entry.gx,
        gy: entry.gy,
        kind: entry.kind,
        label,
        searchSec: entry.searchSec,
        items: entry.items ?? null,
        asCell,
      };
    };
    for (const box of this.map.containers) consider(box, CONTAINERS[box.kind].label, true);
    for (const bag of this.groundBags) consider(bag, bag.label, false);
    return best;
  }

  updateSearch(dt) {
    if (!this.searchTarget || !this.player.alive) return;
    const target = this.searchTarget;
    const dist = target.asCell
      ? edgeDistance(target, this.player)
      : Math.hypot(target.x - this.player.x, target.y - this.player.y);
    if (dist > WORLD.interactRange + 0.4) {
      this.searchTarget = null;
      this.searchProgress = 0;
      return;
    }
    this.searchProgress += dt;
    if (this.searchProgress < this.searchTarget.searchSec) return;
    this.collect(this.searchTarget);
    this.searchTarget = null;
    this.searchProgress = 0;
  }

  /**
   * 出货并塞包。规则一次说清：
   * 同 key 叠加不占新格、不同 key 占一格；格数或载重任一超限就拒收，
   * 被拒的件进 `overload`，结算面板必须明列——"静默吞货"是最容易被玩家骂的设计错误。
   */
  collect(target) {
    const produced = target.items
      ? target.items.map((entry) => ({ key: entry.key, qty: entry.qty }))
      : rollLoot(target.kind, { mapTier: this.map.lootTier, night: this.map.timeSlot === "night", rng: this.rng }).items;

    for (const entry of produced) {
      const spec = ITEMS[entry.key];
      if (!spec) continue;
      const merged = this.bag.find((item) => item.key === entry.key);
      const rest = merged ? this.bag.filter((item) => item.key !== entry.key) : this.bag;
      const wanted = (merged?.qty ?? 0) + entry.qty;
      const verdict = fits({ slots: this.bagSpec.slots, massMax: this.bagSpec.massMax }, rest, { key: entry.key, qty: wanted });
      const qty = Math.min(wanted, STACK_INT_CAP);
      if (!verdict.ok || qty <= 0) {
        this.overload.push({ key: entry.key, qty: entry.qty, label: spec.label, reason: verdict.reason });
        continue;
      }
      if (merged) {
        merged.qty = qty;
        if (wanted > qty) this.overload.push({ key: entry.key, qty: wanted - qty, label: spec.label, reason: "stack" });
      } else {
        this.bag.push({ key: entry.key, qty });
      }
    }

    if (target.items) {
      for (let i = 0; i < this.groundBags.length; i += 1) {
        if (this.groundBags[i].gx === target.gx && this.groundBags[i].gy === target.gy) {
          this.groundBags.splice(i, 1);
          break;
        }
      }
    }
    this.stats.searched += 1;
  }

  updateExfil(dt) {
    if (!this.player.alive) return;
    let inside = false;
    for (const point of this.map.exfils) {
      if (Math.hypot(point.x - this.player.x, point.y - this.player.y) <= WORLD.exfilRadius) {
        inside = true;
        break;
      }
    }
    // 离开范围直接清零（不衰减）：撤离是"站住守住 5 秒"，不许反复试探
    this.exfilHoldSec = inside ? this.exfilHoldSec + dt : 0;
    if (inside && this.exfilHoldSec >= WORLD.exfilHoldSec) {
      this.status = "won";
      this.endReason = "escaped";
    }
  }

  tickTimers(dt) {
    this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    this.medCooldown = Math.max(0, this.medCooldown - dt);
    this.noise.ttl = Math.max(0, this.noise.ttl - dt);
    this.pulse.ttl = Math.max(0, this.pulse.ttl - dt);
    this.skill.cooldown = Math.max(0, this.skill.cooldown - dt);
    if (this.fx.muzzle) {
      this.fx.muzzle.ttl -= dt;
      if (this.fx.muzzle.ttl <= 0) this.fx.muzzle = null;
    }
    if (this.fx.hitMarker) {
      this.fx.hitMarker.ttl -= dt;
      if (this.fx.hitMarker.ttl <= 0) this.fx.hitMarker = null;
    }
    for (let i = this.smokes.length - 1; i >= 0; i -= 1) {
      this.smokes[i].ttl = Math.max(0, this.smokes[i].ttl - dt);
      if (this.smokes[i].ttl <= 0) this.smokes.splice(i, 1);
    }
    for (const ai of this.ais) ai.fireCooldown = Math.max(0, ai.fireCooldown - dt);
    if (this.reloading > 0) {
      this.reloading -= dt;
      if (this.reloading <= 0) this.finishReload();
    }
  }

  startReload() {
    if (this.reloading > 0 || !this.player.alive) return false;
    if (this.mag >= this.weapon.mag) return false;
    if (!this.ammoMatched || this.ammoReserve <= 0) return false;
    this.reloading = this.weapon.reloadSec;
    return true;
  }

  finishReload() {
    this.reloading = 0;
    const taken = Math.min(this.weapon.mag - this.mag, this.ammoReserve);
    this.mag += taken;
    this.ammoReserve -= taken;
  }

  useMed() {
    if (this.medCooldown > 0 || this.meds <= 0 || !this.player.alive) return false;
    if (this.player.hp >= this.player.hpMax) return false;
    this.meds -= 1;
    this.player.hp = Math.min(this.player.hpMax, this.player.hp + MEDS.md_medkit.heal);
    this.medCooldown = 1;
    return true;
  }

  useSkill() {
    if (!this.skill.name || this.skill.uses <= 0 || this.skill.cooldown > 0 || !this.player.alive) return false;
    const rule = SKILL_RULES[this.skill.name];
    this.skill.uses -= 1;
    this.skill.cooldown = rule.cooldownSec;
    if (this.skill.name === "smoke") {
      if (this.smokes.length >= SMOKE_MAX) this.smokes.shift();
      this.smokes.push({ x: this.player.x, y: this.player.y, r: SMOKE_RADIUS, ttl: SMOKE_SEC });
    } else {
      this.pulse.ttl = PULSE_SEC;
    }
    return true;
  }

  judgeOutcome() {
    if (this.status === "won" || this.status === "over") return;
    if (!this.player.alive) {
      this.status = "over";
      this.endReason = "killed";
      return;
    }
    if (this.timeSec >= this.map.timeLimitSec) {
      this.status = "over";
      this.endReason = "timeout";
    }
  }

  countAliveAi() {
    let n = 0;
    for (const ai of this.ais) if (ai.alive && !ai.isGhost) n += 1;
    return n;
  }

  /** HUD 只吃引擎状态，不含任何设备量；视图直接渲染这个对象 */
  hud() {
    let mass = 0;
    for (const entry of this.bag) mass += (ITEMS[entry.key]?.mass ?? 0) * entry.qty;
    return {
      status: this.status,
      endReason: this.endReason,
      mapName: this.map.name,
      mapTier: this.map.tier,
      timeSlot: this.map.timeSlot,
      hp: Math.max(0, Math.round(this.player.hp)),
      hpMax: this.player.hpMax,
      armorDur: Math.round(this.player.armorDur),
      armorMax: this.armorSpec?.durMax ?? 0,
      helmetDur: Math.round(this.player.helmetDur),
      weapon: this.weapon.label,
      mag: this.mag,
      magSize: this.weapon.mag,
      ammoKind: AMMO[this.ammoKind]?.label ?? "无弹药",
      ammoReserve: this.ammoReserve,
      ammoMatched: this.ammoMatched,
      reloading: this.reloading > 0,
      fireEnabled: this.fireEnabled,
      triggerHeld: this.triggerHeld,
      meds: this.meds,
      bagUsed: this.bag.length,
      bagSlots: this.bagSpec.slots,
      bagMass: Math.round(mass * 100) / 100,
      bagMassMax: this.bagSpec.massMax,
      lootValue: totalValue(this.bag),
      timeLeft: this.timeLeftSec(),
      exfilNear: this.exfilHoldSec > 0,
      exfilProgress: Math.min(WORLD.exfilHoldSec, this.exfilHoldSec),
      exfilNeeded: WORLD.exfilHoldSec,
      search: this.searchTarget
        ? { label: this.searchTarget.label, progress: this.searchProgress, needed: this.searchTarget.searchSec }
        : null,
      skill: this.skill.name
        ? { name: this.skill.name, label: SKILL_RULES[this.skill.name].label, usesLeft: this.skill.uses, cooldown: Math.round(this.skill.cooldown) }
        : null,
      kills: this.stats.kills,
      searched: this.stats.searched,
      aiAlive: this.countAliveAi(),
      pulse: this.pulse.ttl > 0,
    };
  }

  timeLeftSec() {
    return Math.max(0, Math.ceil(this.map.timeLimitSec - this.timeSec));
  }

  /** 结算数据：只描述这一局发生了什么；怎么落盘由 economy.settleRaid 与 View 决定 */
  /**
   * 结算一次即定稿。
   * 引擎已经判出胜负（阵亡/超时/撤离成功）时，调用方传来的 reason 不得改判——
   * 否则视图卸载时补一次 "aborted" 就能把阵亡改成正常结算，把该作废的资产带进仓库。
   */
  settle(reason = null) {
    if (this.settlement) return this.settlement;
    const decided = this.status === "won" ? "escaped" : this.endReason;
    const outcome = decided ?? (OUTCOMES.has(reason) ? reason : "aborted");
    const value = totalValue(this.bag);
    this.settlement = {
      outcome,
      escaped: outcome === "escaped",
      mapId: this.map.id,
      mapTier: this.map.tier,
      loot: this.bag.map((entry) => ({ key: entry.key, qty: entry.qty })),
      dropped: this.overload.map((entry) => ({ key: entry.key, qty: entry.qty })),
      loadout: this.loadout,
      kills: this.stats.kills,
      searched: this.stats.searched,
      value,
      timeSec: Math.round(this.timeSec * 10) / 10,
      xp: xpFor({ outcome, kills: this.stats.kills, searched: this.stats.searched, value }),
      hpLeft: Math.max(0, Math.round(this.player.hp)),
      // 这一局消耗掉的装备状态：撤离/退出要按这个数回写仓库，阵亡则整份作废
      left: {
        armorDur: Math.max(0, Math.round(this.player.armorDur)),
        helmetDur: Math.max(0, Math.round(this.player.helmetDur)),
        ammoReserve: this.ammoReserve + this.mag,
        meds: this.meds,
      },
    };
    return this.settlement;
  }

  /** 中途退出：与返回按钮、浏览器返回等价，不能惩罚玩家资产 */
  abort() {
    if (this.status === "won" || this.status === "over") return this.settle();
    this.status = "over";
    this.endReason = "aborted";
    return this.settle("aborted");
  }

  placePlayer(x, y) {
    this.player.x = x;
    this.player.y = y;
    return this.player;
  }

  placeAi(index, x, y, { sees = true, angle = null } = {}) {
    const ai = this.ais[index];
    if (!ai) return null;
    ai.x = x;
    ai.y = y;
    ai.sees = sees;
    if (angle !== null) ai.angle = angle;
    return ai;
  }

  /** 假想敌：只给选目标与伤害公式的纯函数测试用，主循环的 AI 阶段会跳过它 */
  ghostAt(x, y, { alive = true, hp = 100, id = 900 } = {}) {
    const ghost = { id, x, y, radius: WORLD.aiRadius, alive, hp, hpMax: hp, tier: 1, isGhost: true, armorHp: 0 };
    this.ais.push(ghost);
    this.targets.push(ghost);
    return ghost;
  }

  clearGhosts() {
    this.ais = this.ais.filter((ai) => !ai.isGhost);
    this.targets = [this.player, ...this.ais];
  }

  destroy() {
    clearBullets(this.bullets);
    this.queue.length = 0;
    this.smokes.length = 0;
    this.groundBags.length = 0;
  }
}

const STACK_INT_CAP = 99;

export const DELTA_MAPS = MAPS.map((item) => ({
  id: item.id,
  name: item.name,
  tier: item.tier,
  desc: item.desc,
  timeLimitSec: item.timeLimitSec,
  timeSlot: item.timeSlot,
}));
