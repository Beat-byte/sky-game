/**
 * 弹弓小鸟的局内状态机：鸟队列、拉弓发射、空中技能、落定判定、计分与星数。
 *
 * 分工（docs/rules/game-module.md）：这里只管状态与规则，像素级的一切在 renderer.js，
 * 事件翻译在 input.js，几何与"米↔像素"的换算在 layout.js。整个文件不 import Vue，
 * 也不碰 localStorage，所以能在 Node 里直接跑单测。
 *
 * 确定性：物理用固定步长累加器（FIXED_DT）推进，帧间 dt 只决定跑几个子步；
 * 碎屑角度由实体 id + 序号经 spin() 派生，全程没有 Math.random。
 */

import {
  FIXED_DT,
  GRAVITY,
  MATERIALS,
  PIG,
  World,
  makeBox,
  makeCircle,
  makePig,
} from "./physics.js";
import {
  BIRDS,
  BOMB,
  DASH_MULTIPLIER,
  LEVEL_WIDTH,
  MAX_LAUNCH_SPEED,
  MIN_LAUNCH_ANGLE,
  MIN_LAUNCH_SPEED,
  SLING,
  clampIndex,
  levelAt,
  validateLevel,
} from "./levels.js";
import { LEVELS } from "./levels.js";
import { VIEW_WIDTH } from "./layout.js";

/** 弹臂长度（米）：小鸟被拖离锚点的最大距离，只影响画面表现，功率走屏幕归一 */
export const ARM = 1.15;
const SETTLE_TIMEOUT = 2.6; // 秒：一发打完最多等这么久，落不定的话也强制进下一发
const SPENT_SPEED = 0.55; // 米/秒：鸟慢到这个程度算"用完"
const SPENT_HOLD = 0.45; // 秒：慢速要持续这么久才收工，避免抛物线顶点误判
const CRACK_SCORE = 50;
const BOOM_SCORE = 120;
const LEFT_BIRD_SCORE = 5000;
const MAX_PUFFS = 220;
const TRAIL_EVERY = 0.055;
const TRAIL_MAX = 120;

/** 由整数派生 0..1 的稳定抖动，用来代替随机数（碎屑角度、引线火花） */
function spin(n) {
  const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
}

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

export class Birds {
  constructor({ onSound = () => {}, level = 0 } = {}) {
    this.onSound = onSound;
    this.acc = 0;
    this.loadLevel(level);
  }

  // ---------------------------------------------------------------- 关卡与生命周期

  loadLevel(index) {
    this.index = clampIndex(index);
    this.level = levelAt(this.index);
    this.problems = validateLevel(this.level);
    this.world = new World({ width: LEVEL_WIDTH });
    for (const block of this.level.blocks) this.world.add(makeBox({ ...block, material: block.material }));
    for (const p of this.level.pigs) this.world.add(makePig(p.x, p.y, p.r));
    this.queue = [...this.level.birds];
    this.shotIndex = 0;
    this.bird = null;
    this.aim = { power: 0, angle: Math.PI / 4 };
    this.score = 0;
    this.stars = 0;
    this.elapsed = 0;
    this.settleTimer = 0;
    this.spentTimer = 0;
    this.trail = [];
    this.puffs = [];
    this.trailTimer = 0;
    this.status = "ready";
    this.phase = "aim";
    this.abilityReady = false;
    this.message = "";
    // 预沉降：把结构按物理规则跑 3 秒再交给玩家，开局看到的就是一直站得住的样子
    for (let i = 0; i < 360; i += 1) this.consume(this.world.step());
    this.puffs.length = 0;
    this.consume([]);
    return this;
  }

  reset(index = this.index) {
    return this.loadLevel(index);
  }

  restartLevel() {
    this.loadLevel(this.index);
    this.start();
    return this;
  }

  nextLevel() {
    const last = this.index >= LEVELS.length - 1;
    this.loadLevel(last ? this.index : this.index + 1);
    this.start();
    return !last;
  }

  start() {
    if (this.status === "ready") this.status = "playing";
    return this;
  }

  togglePause() {
    if (this.status === "playing") this.status = "paused";
    else if (this.status === "paused") this.status = "playing";
    return this;
  }

  // ---------------------------------------------------------------- 发射

  /** 弹兜位置：锚点沿"发射方向的反方向"偏移 power × ARM */
  pouchWorld() {
    const a = this.aim.angle;
    const d = ARM * this.aim.power;
    return { x: SLING.x - Math.cos(a) * d, y: SLING.y - Math.sin(a) * d };
  }

  /** 功率 0..1 与仰角，由输入层给的屏幕拖拽量换算而来 */
  setAim(power, angle) {
    this.aim.power = clamp(power, 0, 1);
    this.aim.angle = clamp(angle, MIN_LAUNCH_ANGLE, 1.45);
  }

  /** 键盘微调：只改瞄准量，与触屏拖拽共用同一条 setAim 通道 */
  trim(dPower, dAngle) {
    if (this.status !== "playing" || this.phase !== "aim") return this;
    this.setAim(this.aim.power + dPower, this.aim.angle + dAngle);
    this.onSound("pull");
    return this;
  }

  launch() {
    if (this.status !== "playing" || this.phase !== "aim" || this.shotIndex >= this.queue.length) return false;
    const name = this.queue[this.shotIndex];
    const spec = BIRDS[name];
    const speed = MIN_LAUNCH_SPEED + (MAX_LAUNCH_SPEED - MIN_LAUNCH_SPEED) * this.aim.power;
    const pos = this.pouchWorld();
    const body = makeCircle({
      x: pos.x,
      y: pos.y,
      r: spec.r,
      kind: "bird",
      mass: spec.mass,
      restitution: 0.34,
      hp: Infinity,
    });
    body.birdName = name;
    body.vx = Math.cos(this.aim.angle) * speed;
    body.vy = Math.sin(this.aim.angle) * speed;
    this.world.add(body);
    this.bird = body;
    this.shotIndex += 1;
    this.phase = "flight";
    this.abilityReady = Boolean(spec.ability);
    this.trail = [{ x: body.x, y: body.y }];
    this.trailTimer = 0;
    this.spentTimer = 0;
    this.onSound("launch");
    return true;
  }

  /** 空中技能：黄鸟急冲、黑鸟原地引爆，每发只许一次 */
  ability() {
    if (!this.abilityReady || !this.bird || this.phase !== "flight") return false;
    const spec = BIRDS[this.queue[this.shotIndex - 1]];
    this.abilityReady = false;
    if (spec.ability === "dash") {
      const b = this.bird;
      b.vx *= DASH_MULTIPLIER;
      b.vy *= DASH_MULTIPLIER;
      b.asleep = false;
      b.sleepTimer = 0;
      this.spawnPuffs(b.x, b.y, b.id, 4, "#fff3bf");
      this.onSound("dash");
      this.message = `急冲：速度 ×${DASH_MULTIPLIER}`;
      return true;
    }
    if (spec.ability === "bomb") {
      const b = this.bird;
      this.detonate(b.x, b.y, BOMB.radius, BOMB.power);
      this.world.kill(b);
      this.bird = null;
      this.phase = "settle";
      this.settleTimer = 0;
      return true;
    }
    return false;
  }

  detonate(x, y, radius = 4, power = 30) {
    this.score += BOOM_SCORE;
    this.spawnPuffs(x, y, Math.round(x * 10), 10, "#ffd08a");
    this.consume(this.world.explode(x, y, radius, power));
    this.onSound("boom");
  }

  // ---------------------------------------------------------------- 主循环

  update(dt) {
    if (this.status !== "playing") {
      this.puffUpdate(Math.min(dt, 0.05));
      return;
    }
    this.elapsed += dt;
    this.acc += dt;
    let guard = 0;
    while (this.acc >= FIXED_DT && guard < 12) {
      this.acc -= FIXED_DT;
      guard += 1;
      this.step(FIXED_DT);
    }
    this.puffUpdate(dt);
    return this;
  }

  step(dt) {
    this.consume(this.world.step(dt));
    if (this.phase === "flight") this.flightTick(dt);
    else if (this.phase === "settle") this.settleTick(dt);
  }

  flightTick(dt) {
    const b = this.bird;
    if (!b || !b.alive) {
      this.endFlight();
      return;
    }
    this.trailTimer += dt;
    if (this.trailTimer >= TRAIL_EVERY) {
      this.trailTimer = 0;
      this.trail.push({ x: b.x, y: b.y });
      if (this.trail.length > TRAIL_MAX) this.trail.shift();
    }
    // 睡着或慢到睡着的程度就算这一发用完：鸟可能停在屋顶、梁上，不必非落回地面
    const slow = b.asleep || Math.hypot(b.vx, b.vy) < SPENT_SPEED;
    if (slow) {
      this.spentTimer += dt;
      if (this.spentTimer > SPENT_HOLD) this.endFlight();
    } else {
      this.spentTimer = 0;
    }
  }

  /** 一发落定：还有猪就有下一发，没猪就通关，鸟用光就失败 */
  endFlight() {
    if (this.bird && this.bird.alive) this.world.kill(this.bird);
    this.bird = null;
    this.phase = "settle";
    this.settleTimer = 0;
    this.abilityReady = false;
  }

  settleTick(dt) {
    this.settleTimer += dt;
    const quiet = this.world.isQuiet();
    if (!quiet && this.settleTimer < SETTLE_TIMEOUT) return;
    if (!quiet) this.forceSleep();
    this.finishShot();
  }

  forceSleep() {
    for (const b of this.world.bodies) {
      if (b.asleep) continue;
      b.asleep = true;
      b.vx = 0;
      b.vy = 0;
    }
  }

  finishShot() {
    const pigs = this.world.count("pig");
    if (pigs === 0) {
      const left = this.queue.length - this.shotIndex;
      this.score += left * LEFT_BIRD_SCORE;
      this.stars = starsFor(left);
      this.status = "won";
      this.phase = "done";
      this.message = left > 0 ? `省下一 ${left} 只鸟，${this.stars} 星` : "刚好清场，1 星";
      this.onSound("win");
      return;
    }
    if (this.shotIndex >= this.queue.length) {
      this.stars = 0;
      this.status = "over";
      this.phase = "done";
      this.message = `还剩 ${pigs} 头猪，鸟用完了`;
      this.onSound("fail");
      return;
    }
    this.phase = "aim";
    this.trail = [];
    this.message = "";
  }

  /** 把物理层事件换算成分数、碎屑与音效 */
  consume(events) {
    for (const e of events) {
      if (e.type === "break") {
        const spec = MATERIALS[e.body.material] ?? { score: 300 };
        this.score += spec.score;
        this.spawnPuffs(e.body.x, e.body.y, e.body.id, 6, spec.color);
        this.onSound(e.body.material === "glass" ? "glass" : "break");
      } else if (e.type === "pig") {
        this.score += PIG.score;
        this.spawnPuffs(e.body.x, e.body.y, e.body.id, 8, "#7fc86a");
        this.onSound("pig");
      } else if (e.type === "crack") {
        this.score += CRACK_SCORE;
        this.spawnPuffs(e.body.x, e.body.y, e.body.id, 2, MATERIALS[e.body.material]?.color ?? "#cbd5e1");
        this.onSound("crack");
      } else if (e.type === "boom") {
        this.spawnPuffs(e.x, e.y, Math.round(e.x * 7), 12, "#ffcf7a");
        this.onSound("boom");
      } else if (e.type === "fuse") {
        if (e.body.alive) {
          this.world.kill(e.body);
          this.score += MATERIALS.tnt.score;
          this.detonate(e.body.x, e.body.y, 4.1, 30);
        }
      } else if (e.type === "land") {
        if (e.power > 4) this.onSound("thud");
      }
    }
    return events;
  }

  spawnPuffs(x, y, id, count, color) {
    for (let i = 0; i < count; i += 1) {
      if (this.puffs.length >= MAX_PUFFS) this.puffs.shift();
      const a = (i / count) * Math.PI * 2 + spin(id + i) * 0.8;
      const v = 2.4 + spin(id * 3 + i) * 3.4;
      this.puffs.push({
        x,
        y,
        vx: Math.cos(a) * v,
        vy: Math.abs(Math.sin(a)) * v * 0.9 + 1.2,
        life: 0,
        ttl: 0.5 + spin(id + i * 7) * 0.5,
        size: 0.1 + spin(id * 5 + i) * 0.16,
        color,
      });
    }
  }

  puffUpdate(dt) {
    for (const p of this.puffs) {
      p.life += dt;
      p.vy -= GRAVITY * 0.35 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.y < 0.02) {
        p.y = 0.02;
        p.vy = Math.abs(p.vy) * 0.3;
        p.vx *= 0.6;
      }
    }
    this.puffs = this.puffs.filter((p) => p.life < p.ttl);
  }

  // ---------------------------------------------------------------- 供渲染与输入读取

  /** 轨迹预演：只积分重力，不预演碰撞，和原版一样用点串告诉玩家大概落在哪 */
  trajectory(seconds = 2.4) {
    const speed = MIN_LAUNCH_SPEED + (MAX_LAUNCH_SPEED - MIN_LAUNCH_SPEED) * this.aim.power;
    const start = this.pouchWorld();
    const vx = Math.cos(this.aim.angle) * speed;
    const vy = Math.sin(this.aim.angle) * speed;
    const points = [];
    const step = 0.075;
    for (let t = step; t < seconds; t += step) {
      const x = start.x + vx * t;
      const y = start.y + vy * t - 0.5 * GRAVITY * t * t;
      if (y < 0.05 || x > LEVEL_WIDTH) break;
      points.push({ x, y, t });
    }
    return points;
  }

  /** 相机焦点：瞄准时看弹弓，飞行时跟着鸟，落定时回到残骸中心 */
  focus() {
    if (this.phase === "flight" && this.bird) return { x: this.bird.x, y: this.bird.y };
    if (this.phase === "settle") return { x: clamp(structuresCenter(this.world), 0, LEVEL_WIDTH), y: 2.5 };
    return { x: SLING.x + VIEW_WIDTH * 0.34, y: 1.5 };
  }

  birdsLeft() {
    const flying = this.phase === "flight" || this.phase === "settle" ? 1 : 0;
    return Math.max(0, this.queue.length - this.shotIndex - flying);
  }

  pigsLeft() {
    return this.world.count("pig");
  }

  hud() {
    return {
      score: this.score,
      level: this.index + 1,
      levelTotal: LEVELS.length,
      levelName: this.level.name,
      birds: this.queue.map((name, i) => ({
        name: BIRDS[name].name,
        color: BIRDS[name].color,
        state: i < this.shotIndex ? "used" : i === this.shotIndex && this.phase === "aim" ? "next" : "wait",
        hint: BIRDS[name].hint,
      })),
      left: this.birdsLeft(),
      pigs: this.pigsLeft(),
      power: Math.round(this.aim.power * 100),
      angle: Math.round((this.aim.angle * 180) / Math.PI),
      stars: this.stars,
      seconds: Math.floor(this.elapsed),
      message: this.message,
      hint: this.level.hint,
    };
  }

  /** 单测与 DEV 钩子用：整局关键状态的可复现指纹 */
  fingerprint() {
    return JSON.stringify({
      world: this.world.snapshot(),
      score: this.score,
      status: this.status,
      phase: this.phase,
      shot: this.shotIndex,
      aim: [this.aim.power.toFixed(6), this.aim.angle.toFixed(6)],
    });
  }
}

export function starsFor(leftBirds) {
  if (leftBirds >= 2) return 3;
  if (leftBirds === 1) return 2;
  return 1;
}

function structuresCenter(world) {
  if (!world.bodies.length) return LEVEL_WIDTH * 0.6;
  let sum = 0;
  for (const b of world.bodies) sum += b.x;
  return clamp(sum / world.bodies.length, 4, LEVEL_WIDTH);
}

