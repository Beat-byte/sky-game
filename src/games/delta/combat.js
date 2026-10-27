/**
 * 「危险行动」的射击与命中：子弹池、目标选择、线段-圆相交、伤害公式。
 *
 * 三条纪律：
 * 1. **不读 FIELD、不碰 DOM**。本文件只吃 map + 实体数组 + dt，弹道与命中全是纯计算，
 *    所以"子弹撞墙不穿墙杀人"能在 Node 里用一条钉死的坐标序列证明。
 * 2. **运行期零分配**。子弹池在 createBulletPool 里一次性建满（默认 64 条），
 *    发射只是把 alive 置真、就地改字段；命中判定用模块级暂存对象，不调 map/filter。
 * 3. **池满就丢弹**，不扩容、不淘汰旧弹。超出预算的火力本来就该被看见（手机上尤其明显）。
 *
 * 命中模型是"实体子弹 + 直线弹道"：子弹有速度、会撞墙停、比视线晚几帧命中，
 * 但伤害结算走 resolveDamage 这个纯函数，与"瞬间命中"的写法在数值上完全等价、更好单测。
 */

import { WORLD, marchSegment } from "./map.js";

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** 预分配：pool.items 的长度在整个运行期恒定不变，测试直接断言这个长度 */
export function createBulletPool(cap = WORLD.maxBullets) {
  const items = [];
  for (let i = 0; i < cap; i += 1) {
    items.push({
      alive: false,
      id: 0,
      x: 0,
      y: 0,
      px: 0,
      py: 0,
      vx: 0,
      vy: 0,
      life: 0,
      traveled: 0,
      damage: 0,
      owner: 0,
      tracer: 0,
    });
  }
  return { cap, items, nextId: 1 };
}

export function aliveCount(pool) {
  let n = 0;
  for (const bullet of pool.items) if (bullet.alive) n += 1;
  return n;
}

/** 发射：找一条空闲弹就地写满。找不到（池满）返回 null，调用方不该因此崩 */
export function fireBullet(pool, { x, y, angle, speedMps, damage, rangeM, owner }) {
  for (const bullet of pool.items) {
    if (bullet.alive) continue;
    bullet.alive = true;
    bullet.id = pool.nextId++;
    bullet.x = x;
    bullet.y = y;
    bullet.px = x;
    bullet.py = y;
    bullet.vx = Math.cos(angle) * speedMps;
    bullet.vy = Math.sin(angle) * speedMps;
    bullet.life = rangeM / Math.max(1e-3, speedMps);
    bullet.traveled = 0;
    bullet.damage = damage;
    bullet.owner = owner;
    bullet.tracer = 0;
    return bullet;
  }
  return null;
}

/**
 * 线段 AB 与圆 (cx,cy,r) 是否相交；相交时返回最近命中点在 AB 上的比例 t∈[0,1]，否则 -1。
 * 返回 t 而不是布尔，是为了在同一帧的多发弹里挑"先打到的那个"。
 */
export function segmentCircle(ax, ay, bx, by, cx, cy, r) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  const proj = lenSq > 0 ? clamp(((cx - ax) * dx + (cy - ay) * dy) / lenSq, 0, 1) : 0;
  const nearestX = ax + dx * proj;
  const nearestY = ay + dy * proj;
  const ddx = cx - nearestX;
  const ddy = cy - nearestY;
  if (ddx * ddx + ddy * ddy > r * r) return -1;
  return proj;
}

const wallProbe = {};

/**
 * 推进所有子弹。targets 是"能被打到的实体"数组（玩家与 AI 共用同一份判定，对称）。
 * hooks.onHit(target, bullet) / hooks.onWall(x, y, gx, gy) 由 game.js 传入 ——
 * 伤害结算与粒子生成都归它管，本文件不写任何实体的血量。
 * 一帧内先判墙再判人：墙比人近时子弹已经停了，不存在"穿墙杀人"。
 */
export function stepBullets(map, pool, targets, targetCount, dt, hooks) {
  const onHit = hooks?.onHit;
  const onWall = hooks?.onWall;
  for (const bullet of pool.items) {
    if (!bullet.alive) continue;
    bullet.px = bullet.x;
    bullet.py = bullet.y;
    bullet.x += bullet.vx * dt;
    bullet.y += bullet.vy * dt;
    bullet.life -= dt;
    // 飞了多远（米）：射程衰减按真实飞行距离算，而不是按"当前与目标的直线距离"
    bullet.traveled += Math.hypot(bullet.vx, bullet.vy) * dt;

    marchSegment(map, bullet, { x: bullet.x, y: bullet.y }, { maxSteps: 8, mode: "sight" }, wallProbe);
    if (wallProbe.blocked || wallProbe.truncated) {
      bullet.alive = false;
      if (onWall) onWall(wallProbe.x, wallProbe.y, wallProbe.gx, wallProbe.gy);
      continue;
    }

    let bestT = Infinity;
    let bestTarget = null;
    for (let i = 0; i < targetCount; i += 1) {
      const target = targets[i];
      if (!target || !target.alive || target.id === bullet.owner) continue;
      const t = segmentCircle(bullet.px, bullet.py, bullet.x, bullet.y, target.x, target.y, target.radius);
      if (t < 0 || t > bestT) continue;
      bestT = t;
      bestTarget = target;
    }
    if (bestTarget) {
      bullet.alive = false;
      if (onHit) onHit(bestTarget, bullet);
      continue;
    }

    if (bullet.life <= 0) bullet.alive = false;
  }
}

/**
 * 自动开火的目标选择：可见 + 在射程 + 在朝向扇形内，
 * 先比角偏移（谁更"在枪口正前方"）、再比距离。单趟扫描出结果，不排序、不分配。
 * visible 由 game.js 传入（它才知道烟幕），本文件只管几何与射程。
 */
export function selectTarget(shooter, targets, targetCount, { rangeM, coneRad = WORLD.fireConeRad, visible }) {
  let best = null;
  let bestAngle = Infinity;
  let bestDist = Infinity;
  for (let i = 0; i < targetCount; i += 1) {
    const target = targets[i];
    if (!target || !target.alive || target.id === shooter.id) continue;
    const dx = target.x - shooter.x;
    const dy = target.y - shooter.y;
    const dist = Math.hypot(dx, dy);
    if (dist > rangeM) continue;
    let diff = Math.atan2(dy, dx) - shooter.angle;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    if (Math.abs(diff) > coneRad) continue;
    if (visible && !visible(shooter, target)) continue;
    const absDiff = Math.abs(diff);
    if (absDiff < bestAngle - 1e-9 || (Math.abs(absDiff - bestAngle) < 1e-9 && dist < bestDist)) {
      bestAngle = absDiff;
      bestDist = dist;
      best = target;
    }
  }
  return best;
}

/**
 * 伤害结算：距离衰减（超过 60% 射程起衰，最深 35%）→ 护甲减伤（耐久归零即失效）→ 下界 1。
 * 返回 { damage, wear }：wear 是要从护甲耐久里扣掉的量，由调用方落账。
 * 衰减曲线是线性的，且只在"最远射程"处给到 0.65 倍 —— 与三款游戏的"距离无关恒定伤害"相比，
 * 这里唯一新增的自由度是射程，而射程以米写死在 weapons.js，三端一致。
 */
export function resolveDamage({
  base,
  distanceM,
  rangeM,
  armorAbsorb = 0,
  armorDur = 0,
  helmetAbsorb = 0,
  helmetDur = 0,
  critMul = 1,
}) {
  const raw = Math.max(0, Number(base) || 0) * (critMul > 0 ? critMul : 1);
  const knee = Math.max(0.001, rangeM) * 0.6;
  const span = Math.max(0.001, Math.max(0, distanceM - knee) / Math.max(0.001, rangeM - knee));
  const falloff = clamp(1 - span * 0.35, 0.65, 1);
  const dmg = raw * falloff;
  const body = armorDur > 0 ? armorAbsorb : 0;
  const head = helmetDur > 0 ? helmetAbsorb : 0;
  const absorb = clamp(Math.max(body, head), 0, 0.65);
  return {
    damage: Math.max(1, Math.round(dmg * (1 - absorb))),
    wear: Math.max(0, Math.round(dmg * 0.9)),
  };
}

/** 散布：武器基础散布 + 移动惩罚，返回一个 ± 内的随机角（rng 消耗点之一） */
export function spreadAngle({ spreadRad, moving = false, accuracy = 1, rng = Math.random }) {
  const scale = moving ? 1.6 : 1;
  return (rng() * 2 - 1) * spreadRad * scale / Math.max(0.05, accuracy);
}

export function clearBullets(pool) {
  for (const bullet of pool.items) bullet.alive = false;
}
