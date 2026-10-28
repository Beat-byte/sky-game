/**
 * 二维刚体求解器：圆 + 轴对齐矩形，固定步长、顺序冲量 + 位置修正，完全确定性。
 *
 * 三个刻意的设计约束（决定后面所有手感，改动前先读）：
 *
 * 1. **不引入旋转**。方块永远轴对齐，碰撞是 AABB/圆-矩形解析解，不需要 OBB 与力矩，
 *    堆叠不会因为数值漂移抖出不可复现的结果。代价是"柱子被撞后不会倾斜倒下"，
 *    替代表现是：支撑被抽走的方块直接垂直砸落，加上 TNT 的径向冲量把结构推散。
 * 2. **不许 Math.random**。碎屑角度、花纹相位一律由整数 id / phase 派生（见 renderer.js），
 *    同一初条件跑两次必须逐位相等 —— test/birds.test.js 的"物理确定性"一例钉住它。
 * 3. **一切按米与秒**。重力、尺寸、速度都是物理量，与像素和设备档位无关；
 *    渲染层怎么缩放都不参与判定（难度铁律，见 docs/rules/game-module.md）。
 *
 * 伤害模型：只有"新接触"（上一帧没有、这一帧出现）沿法线的接近速度会换算成冲量
 * j = (1+e)·vₙ / (1/m₁ + 1/m₂)，超过材质 toughness 才掉血 —— 所以静止堆叠不会慢慢磨血，
 * 只有真撞才掉。量纲 N·s：1.2 kg 的鸟以 18 m/s 撞 8 kg 石块约 24。
 *
 * 睡眠：睡着的实体在本步里按"不可推动"处理（invMass 视为 0），既不积分也不修正位置，
 * 所以堆好的塔永远纹丝不动；被撞、或下方支撑消失时由 vnWake / wakeAround 叫醒。
 */

export const GRAVITY = 22; // 米/秒²，比地球重力略大，抛物线更紧凑、一屏装得下
export const FIXED_DT = 1 / 120;
export const SOLVER_ITERATIONS = 6;
export const POSITION_SLOP = 0.002; // 允许残留的穿透余量，避免位置修正来回抖
export const POSITION_PERCENT = 0.6;
export const BOUNCE_SPEED = 1.2; // 米/秒，低于它的接触不反弹，否则静物会一直颤

export const SLEEP_SPEED = 0.16; // 米/秒，慢过它才开始累计入睡时间
export const SLEEP_TIME = 0.3; // 秒，连续慢这么久才真睡，防止抛体在最高点误睡
export const WAKE_SPEED = 0.45; // 米/秒，对方够快才叫得醒睡着的实体

/** 材质：密度决定质量（方块质量 = 密度 × 面积），toughness 是掉血门槛，hp 是耐久 */
export const MATERIALS = {
  wood: { density: 0.55, hp: 18, toughness: 8, score: 500, color: "#c9915a", edge: "#7c5027", mark: "#5e3c1d" },
  stone: { density: 1.7, hp: 44, toughness: 18, score: 800, color: "#9aa6b8", edge: "#5c6675", mark: "#3d4653" },
  glass: { density: 0.85, hp: 9, toughness: 4, score: 400, color: "#8fd8f2", edge: "#4a9ab5", mark: "#e6f8fe" },
  tnt: { density: 0.5, hp: 3, toughness: 2, score: 700, color: "#e2604f", edge: "#8f2f22", mark: "#ffd9a0" },
};

export const PIG = { density: 0.7, hp: 12, toughness: 6, score: 1000, r: 0.46 };

let nextId = 1;

/** 单测之间要能重置 id 序列，否则断言里的 id 会随用例顺序漂移 */
export function resetIds(value = 1) {
  nextId = value;
}

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

export function makeBox({ x, y, w, h, material = "wood", restitution = 0.12 }) {
  const spec = MATERIALS[material];
  const mass = spec.density * w * h;
  return {
    id: nextId++,
    kind: spec === MATERIALS.tnt ? "tnt" : "block",
    material,
    shape: "box",
    x,
    y,
    hw: w / 2,
    hh: h / 2,
    vx: 0,
    vy: 0,
    mass,
    invMass: 1 / mass,
    restitution,
    friction: 0.6,
    hp: spec.hp,
    maxHp: spec.hp,
    toughness: spec.toughness,
    asleep: false,
    sleepTimer: 0,
    alive: true,
  };
}

export function makeCircle({ x, y, r, kind = "bird", material = null, mass = 1.2, restitution = 0.32, hp = null, toughness = 8, friction = 0.5 }) {
  return {
    id: nextId++,
    kind,
    material,
    shape: "circle",
    x,
    y,
    r,
    vx: 0,
    vy: 0,
    mass,
    invMass: 1 / mass,
    restitution,
    friction,
    hp: hp ?? PIG.hp,
    maxHp: hp ?? PIG.hp,
    toughness,
    asleep: false,
    sleepTimer: 0,
    alive: true,
  };
}

export function makePig(x, y, r = PIG.r) {
  return makeCircle({
    x,
    y,
    r,
    kind: "pig",
    mass: PIG.density * Math.PI * r * r,
    restitution: 0.2,
    friction: 0.55,
    hp: PIG.hp,
    toughness: PIG.toughness,
  });
}

function span(b) {
  return { minX: b.x - b.hw, maxX: b.x + b.hw, minY: b.y - b.hh, maxY: b.y + b.hh };
}

/**
 * 法线一律从 a 指向 b（solve 里 a 受 -n 冲量、b 受 +n 冲量，位置修正同向）。
 * 三个函数当初各写各的方向，结果地面把方块"吸"了下去 —— 改任何一个都要守住这条约定。
 */

/** 圆 vs 轴对齐矩形：最近点法；圆心落在矩形内时退化到"沿最浅的边把圆推出去" */
function circleVsBox(a, b) {
  const s = span(b);
  const cx = clamp(a.x, s.minX, s.maxX);
  const cy = clamp(a.y, s.minY, s.maxY);
  const dx = a.x - cx;
  const dy = a.y - cy;
  const d2 = dx * dx + dy * dy;
  if (d2 > a.r * a.r) return null;
  if (d2 > 1e-9) {
    const d = Math.sqrt(d2);
    // 分离方向是 box→circle，即 b→a，取负换成约定的 a→b
    return { nx: -dx / d, ny: -dy / d, pen: a.r - d };
  }
  const left = a.x - s.minX + a.r;
  const right = s.maxX - a.x + a.r;
  const down = a.y - s.minY + a.r;
  const up = s.maxY - a.y + a.r;
  const min = Math.min(left, right, down, up);
  if (min === left) return { nx: 1, ny: 0, pen: left };
  if (min === right) return { nx: -1, ny: 0, pen: right };
  if (min === down) return { nx: 0, ny: 1, pen: down };
  return { nx: 0, ny: -1, pen: up };
}

function boxVsBox(a, b) {
  const sa = span(a);
  const sb = span(b);
  const ox = Math.min(sa.maxX, sb.maxX) - Math.max(sa.minX, sb.minX);
  const oy = Math.min(sa.maxY, sb.maxY) - Math.max(sa.minY, sb.minY);
  if (ox <= 0 || oy <= 0) return null;
  if (ox < oy) return { nx: a.x < b.x ? 1 : -1, ny: 0, pen: ox };
  return { nx: 0, ny: a.y < b.y ? 1 : -1, pen: oy };
}

function circleVsCircle(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const rs = a.r + b.r;
  const d2 = dx * dx + dy * dy;
  if (d2 >= rs * rs) return null;
  const d = Math.sqrt(d2) || 1e-4;
  return { nx: dx / d, ny: dy / d, pen: rs - d };
}

function manifold(a, b) {
  if (a.shape === "circle" && b.shape === "circle") return circleVsCircle(a, b);
  if (a.shape === "circle") return circleVsBox(a, b);
  if (b.shape === "circle") {
    const m = circleVsBox(b, a);
    return m ? { nx: -m.nx, ny: -m.ny, pen: m.pen } : null;
  }
  return boxVsBox(a, b);
}

const speed = (b) => Math.hypot(b.vx, b.vy);

/** 睡着的实体本步按不可推动处理；地面本来 invMass 就是 0 */
const movable = (b) => (b.asleep ? 0 : b.invMass);

export class World {
  /** @param width 关卡世界宽度（米），飞出这个范围就判定出界 @param groundY 地面高度（米） */
  constructor({ width = 40, groundY = 0 } = {}) {
    this.width = width;
    this.groundY = groundY;
    this.bodies = [];
    this.events = [];
    this.contacts = new Set();
    this.groundBody = {
      id: 0,
      kind: "ground",
      material: null,
      shape: "box",
      x: width / 2,
      y: groundY - 40,
      hw: width,
      hh: 40,
      vx: 0,
      vy: 0,
      mass: Infinity,
      invMass: 0,
      restitution: 0.16,
      friction: 0.85,
      hp: Infinity,
      maxHp: Infinity,
      toughness: Infinity,
      asleep: true,
      sleepTimer: 0,
      alive: true,
    };
  }

  add(body) {
    this.bodies.push(body);
    return body;
  }

  count(kind) {
    return this.bodies.filter((b) => b.kind === kind).length;
  }

  find(id) {
    return this.bodies.find((b) => b.id === id) ?? null;
  }

  /** 抽掉支撑后要叫醒压在它上方的方块，否则睡着的会浮空 */
  wakeAbove(body, reach = 1.2) {
    const s = span(body);
    for (const b of this.bodies) {
      if (b === body || !b.alive || !b.asleep) continue;
      const t = span(b);
      const overlapX = Math.min(s.maxX, t.maxX) - Math.max(s.minX, t.minX);
      if (overlapX > -0.25 && b.y >= s.minY - 0.05 && b.y - s.maxY < reach) {
        b.asleep = false;
        b.sleepTimer = 0;
      }
    }
  }

  kill(body) {
    if (!body.alive) return;
    body.alive = false;
    body.vx = 0;
    body.vy = 0;
    this.wakeAbove(body);
  }

  /** 一个固定步长：入睡判定 → 重力 → 找接触 → 解速度 → 修位置 → 积分 → 结算伤害 → 清出界 */
  step(dt = FIXED_DT) {
    this.events.length = 0;
    const live = this.bodies.filter((b) => b.alive);
    const all = [this.groundBody, ...live];

    for (const b of live) {
      if (b.asleep) continue;
      if (speed(b) < SLEEP_SPEED) {
        b.sleepTimer += dt;
        if (b.sleepTimer > SLEEP_TIME) {
          b.asleep = true;
          b.vx = 0;
          b.vy = 0;
        }
      } else {
        b.sleepTimer = 0;
      }
    }

    for (const b of live) {
      if (!b.asleep) b.vy -= GRAVITY * dt;
    }

    const seen = new Set();
    const pairs = [];
    const impacts = [];
    for (let i = 0; i < all.length; i += 1) {
      for (let j = i + 1; j < all.length; j += 1) {
        const a = all[i];
        const b = all[j];
        if (movable(a) === 0 && movable(b) === 0) continue;
        const m = manifold(a, b);
        if (!m) continue;
        const key = `${a.id}:${b.id}`;
        seen.add(key);
        const rvn = (b.vx - a.vx) * m.nx + (b.vy - a.vy) * m.ny;
        m.a = a;
        m.b = b;
        pairs.push(m);
        // 伤害按"叫醒之前"的质量结算：睡着的结构被撞时当作不可移动，
        // 于是整个冲量都落进它自己手里（这才是一撞就断的来由）。若在同一帧内就叫醒，
        // 轻方块会像海绵一样把冲量吸收掉，鸟撞上去只剩"贴住不动"。
        if (!this.contacts.has(key) && rvn < -0.4) {
          impacts.push({ a, b, nx: m.nx, ny: m.ny, vn: -rvn, ia: movable(a), ib: movable(b) });
        }
        if (a.asleep && shouldWake(a, b, m)) {
          a.asleep = false;
          a.sleepTimer = 0;
        }
        if (b.asleep && shouldWake(b, a, m)) {
          b.asleep = false;
          b.sleepTimer = 0;
        }
      }
    }

    this.solve(pairs);
    for (const m of pairs) this.correct(m);

    for (const b of live) {
      if (b.asleep) continue;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
    }

    this.contacts = seen;
    this.settle(impacts);
    this.cull();
    return this.events;
  }

  /** 顺序冲量：法线（含恢复系数）+ 切线库仑摩擦 */
  solve(pairs) {
    for (let it = 0; it < SOLVER_ITERATIONS; it += 1) {
      for (const m of pairs) {
        const { a, b, nx, ny } = m;
        const inv = movable(a) + movable(b);
        if (inv === 0) continue;
        const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (vn < 0) {
          const e = -vn > BOUNCE_SPEED ? Math.min(a.restitution, b.restitution) : 0;
          const j = (-(1 + e) * vn) / inv;
          a.vx -= j * nx * movable(a);
          a.vy -= j * ny * movable(a);
          b.vx += j * nx * movable(b);
          b.vy += j * ny * movable(b);
          if (it === 0) m.j = j;
        }
        if (!m.j || a.friction + b.friction === 0) continue;
        const tx = (b.vx - a.vx) - ((b.vx - a.vx) * nx + (b.vy - a.vy) * ny) * nx;
        const ty = (b.vy - a.vy) - ((b.vx - a.vx) * nx + (b.vy - a.vy) * ny) * ny;
        const tl = Math.hypot(tx, ty);
        if (tl < 1e-6) continue;
        const ux = tx / tl;
        const uy = ty / tl;
        const vt = (b.vx - a.vx) * ux + (b.vy - a.vy) * uy;
        const mu = Math.sqrt(a.friction * b.friction);
        const jt = clamp(-vt / inv, -m.j * mu, m.j * mu);
        a.vx -= jt * ux * movable(a);
        a.vy -= jt * uy * movable(a);
        b.vx += jt * ux * movable(b);
        b.vy += jt * uy * movable(b);
      }
    }
  }

  correct(m) {
    const { a, b, nx, ny, pen } = m;
    const ia = movable(a);
    const ib = movable(b);
    const inv = ia + ib;
    if (inv === 0) return;
    const depth = Math.max(pen - POSITION_SLOP, 0) * POSITION_PERCENT;
    a.x -= nx * depth * (ia / inv);
    a.y -= ny * depth * (ia / inv);
    b.x += nx * depth * (ib / inv);
    b.y += ny * depth * (ib / inv);
  }

  /** 新接触结算：鸟只报落地，TNT 只报引线，其余按材质门槛掉血或碎裂 */
  settle(impacts) {
    for (const h of impacts) {
      const inv = h.ia + h.ib;
      if (inv === 0) continue;
      const e = Math.min(h.a.restitution, h.b.restitution);
      // 牛顿第三定律：同一对接触上的冲量大小相等，所以两侧各自吃 j，不做"分摊"
      const j = ((1 + e) * h.vn) / inv;
      for (const body of [h.a, h.b]) {
        if (body.kind === "bird") {
          if (h.a.kind === "ground" || h.b.kind === "ground") {
            this.events.push({ type: "land", body, power: h.vn });
          }
          continue;
        }
        if (body.invMass === 0 || !body.alive) continue;
        if (body.material === "tnt") {
          if (j > body.toughness) this.events.push({ type: "fuse", body, power: j });
          continue;
        }
        if (j > body.toughness) {
          body.hp -= j - body.toughness * 0.4;
          if (body.hp <= 0) {
            this.kill(body);
            this.events.push({ type: body.kind === "pig" ? "pig" : "break", body, power: j });
          } else {
            this.events.push({ type: "crack", body, power: j });
          }
        }
      }
    }
  }

  /** 出界清理：飞出关卡右端、弹回左端外、或掉进坑里的实体直接移除 */
  cull() {
    for (const b of this.bodies) {
      if (!b.alive) continue;
      if (b.x < -3 || b.x > this.width + 3 || b.y < -4) {
        b.alive = false;
        this.events.push({ type: "gone", body: b });
      }
    }
    this.bodies = this.bodies.filter((b) => b.alive);
  }

  /**
   * 引爆：径向冲量 + 距离衰减伤害，范围内的 TNT 直接连锁。
   * 受害者按距离升序处理，事件顺序固定，测试才钉得住爆炸结果。
   * 返回的是**本次爆炸新产生的事件数组**（不复用 step 的 this.events），
   * 否则调用方再消费一遍就会把上一帧的引线事件重新引爆，形成无限递归。
   */
  explode(x, y, radius = 4, power = 30) {
    const out = [{ type: "boom", x, y, radius }];
    const victims = this.bodies
      .filter((b) => b.alive)
      .map((b) => ({ b, d: Math.hypot(b.x - x, b.y - y) }))
      .filter(({ b, d }) => d <= radius + (b.hw ?? b.r ?? 0))
      .sort((p, q) => p.d - q.d);
    for (const { b, d } of victims) {
      if (b.invMass === 0) continue;
      const fall = 1 - clamp(d / radius, 0, 1);
      const push = power * fall;
      const nx = d < 1e-3 ? 0 : (b.x - x) / d;
      const ny = d < 1e-3 ? 1 : (b.y - y) / d;
      b.asleep = false;
      b.sleepTimer = 0;
      b.vx += nx * push * b.invMass;
      b.vy += ny * push * b.invMass * 0.8 + push * 0.25;
      const dealt = push * 1.6;
      if (b.material === "tnt") {
        this.kill(b);
        out.push({ type: "break", body: b, power: dealt });
        out.push(...this.explode(b.x, b.y, radius * 0.85, power * 0.85));
        continue;
      }
      if (b.kind === "bird") continue;
      if (dealt > b.toughness) {
        b.hp -= dealt - b.toughness * 0.4;
        if (b.hp <= 0) {
          this.kill(b);
          out.push({ type: b.kind === "pig" ? "pig" : "break", body: b, power: dealt });
        } else {
          out.push({ type: "crack", body: b, power: dealt });
        }
      }
    }
    return out;
  }

  /** 世界是否安静下来：所有实体都睡着或慢到可以忽略，这一发才算落定 */
  isQuiet() {
    return this.bodies.every((b) => b.asleep || speed(b) < SLEEP_SPEED);
  }

  /** 总动能，用来判断"撞完了" */
  kinetic() {
    let sum = 0;
    for (const b of this.bodies) {
      if (b.invMass > 0 && !b.asleep) sum += 0.5 * b.mass * (b.vx * b.vx + b.vy * b.vy);
    }
    return sum;
  }

  snapshot() {
    return this.bodies.map((b) => ({
      id: b.id,
      x: +b.x.toFixed(9),
      y: +b.y.toFixed(9),
      vx: +b.vx.toFixed(9),
      vy: +b.vy.toFixed(9),
      hp: +b.hp.toFixed(9),
    }));
  }
}

/** 睡着的一方该不该被叫醒：对方得真的在动，而且是往里撞而不是擦过 */
function shouldWake(sleeper, other, m) {
  if (!other.asleep && other.invMass > 0 && speed(other) > WAKE_SPEED) {
    const along = (other.vx - sleeper.vx) * m.nx + (other.vy - sleeper.vy) * m.ny;
    return along < -0.25;
  }
  return false;
}
