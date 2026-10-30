/**
 * 「飞机大战」的 Canvas 绘制：只读状态、绝不写状态，不参与任何判定。
 *
 * 三条铁律（改这里前先读）：
 * 1. **不许 Math.random**：星星位置、爆炸碎片角度、尾焰长度一律由整数序号 / 实体 id 经
 *    hashJitter 与传入的 time 派生，同一帧画两次结果一致，"渲染不改状态"的对拍才成立。
 * 2. **只用单位坐标 × layout.unit**：判定在单位里，画在像素里，中间只有这一个乘数。
 *    metricsFor 只提供线宽/字号这类装饰量。
 * 3. **不用渐变与滤镜**：只用 fill/stroke/arc/path/globalAlpha/shadowBlur，
 *    单测的记录型 ctx 桩才认得全（新增 canvas 手段要同步补桩）。
 */

import { ENEMIES, FIELD, ITEMS, SHIP, hashJitter } from "./field.js";
import { backingSize, metricsFor } from "./layout.js";

const BG = "#070d18";
const VEIL = "rgba(6, 12, 22, 0.66)";
const SHOT_TINT = "#c8f5ff";
const ENEMY_SHOT_TINT = "#ff8f6b";
const ITEM_TINT = { power: "#7dd3fc", repair: "#34d399", bomb: "#f0b072" };

/** 机身轮廓（单位，机头朝 -y）与敌机轮廓（机头朝 +y），顶点数刻意保持少，三端都画得干净 */
const SHIP_SHAPE = [
  [0, -0.95],
  [-0.22, -0.25],
  [-0.9, 0.35],
  [-0.32, 0.4],
  [-0.16, 0.85],
  [0.16, 0.85],
  [0.32, 0.4],
  [0.9, 0.35],
  [0.22, -0.25],
];
const ENEMY_SHAPE = {
  scout: [
    [0, 0.95],
    [-0.8, -0.5],
    [0, -0.15],
    [0.8, -0.5],
  ],
  dart: [
    [0, 1.05],
    [-0.5, -0.7],
    [0, -0.3],
    [0.5, -0.7],
  ],
  fighter: [
    [0, 0.95],
    [-1.0, 0.1],
    [-0.28, -0.05],
    [-0.35, -0.75],
    [0.35, -0.75],
    [0.28, -0.05],
    [1.0, 0.1],
  ],
  gunner: [
    [0, 1.0],
    [-0.85, 0.35],
    [-0.55, -0.7],
    [0.55, -0.7],
    [0.85, 0.35],
  ],
  bomber: [
    [0, 1.05],
    [-1.05, 0.45],
    [-0.4, -0.8],
    [0.4, -0.8],
    [1.05, 0.45],
  ],
  boss: [
    [0, 1.0],
    [-1.15, 0.5],
    [-0.55, -0.85],
    [0.55, -0.85],
    [1.15, 0.5],
  ],
};

const STAR_LAYERS = [
  { count: 26, speed: 2.2, alpha: 0.28, size: 0.9 },
  { count: 18, speed: 4.4, alpha: 0.5, size: 1.3 },
];

export function setupCanvas(canvas, css, device) {
  const { width, height, dpr } = backingSize(css);
  canvas.width = width;
  canvas.height = height;
  canvas.style.width = `${css.width}px`;
  canvas.style.height = `${css.height}px`;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.metrics = metricsFor({ unit: width / dpr / FIELD.w, device }, device);
  return ctx;
}

/** 单位多边形 → 画布路径；cx/cy 是中心（像素），scale 是每单位像素 */
function path(ctx, shape, cx, cy, scale) {
  ctx.beginPath();
  for (let i = 0; i < shape.length; i += 1) {
    const px = cx + shape[i][0] * scale;
    const py = cy + shape[i][1] * scale;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function u(layout, v) {
  return v * layout.unit;
}

function drawStars(ctx, game, layout, time) {
  const m = metricsFor(layout);
  for (const [layer, stars] of STAR_LAYERS.entries()) {
    const scroll = (game.timeSec * stars.speed + hashJitter(layer, 3) * FIELD.h) % FIELD.h;
    ctx.globalAlpha = stars.alpha;
    ctx.fillStyle = "#8fb7e8";
    for (let i = 0; i < stars.count; i += 1) {
      const x = hashJitter(i, layer * 7 + 1) * FIELD.w;
      const y = (hashJitter(i, layer * 7 + 2) * FIELD.h + scroll) % FIELD.h;
      const size = m.star * stars.size * (0.6 + hashJitter(i, layer * 7 + 4) * 0.8);
      const twinkle = 0.75 + 0.25 * Math.sin(time / 420 + hashJitter(i, 9) * Math.PI * 2);
      ctx.fillRect(u(layout, x), u(layout, y), size, size * twinkle);
    }
  }
  ctx.globalAlpha = 1;
}

function drawShip(ctx, game, layout, time) {
  const ship = game.ship;
  const cx = u(layout, ship.x);
  const cy = u(layout, ship.y);
  const s = u(layout, SHIP.r);
  const blink = ship.invuln > 0 && Math.floor(time / 90) % 2 === 0;
  // 尾焰：长度由时间正弦派生，同一帧画两次一致
  const trail = 0.55 + 0.25 * Math.sin(time / 90);
  ctx.fillStyle = "#4ac1ff";
  path(
    ctx,
    [
      [-0.3, 0.8],
      [0, 0.8 + trail],
      [0.3, 0.8],
    ],
    cx,
    cy,
    s
  );
  ctx.fill();
  if (blink) return;
  ctx.fillStyle = "#dff2ff";
  path(ctx, SHIP_SHAPE, cx, cy, s);
  ctx.fill();
  ctx.fillStyle = "#1d6f9e";
  ctx.beginPath();
  ctx.arc(cx, cy - s * 0.15, s * 0.26, 0, Math.PI * 2);
  ctx.fill();
  if (ship.invuln > 0) {
    ctx.strokeStyle = "#7dd3fc";
    ctx.lineWidth = metricsFor(layout).outline;
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    ctx.arc(cx, cy, u(layout, SHIP.r + 0.35), 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

function drawEnemies(ctx, game, layout) {
  for (const e of game.enemies) {
    const spec = ENEMIES[e.kind];
    const cx = u(layout, e.x);
    const cy = u(layout, e.y);
    const s = u(layout, e.r);
    ctx.fillStyle = spec.tint;
    path(ctx, ENEMY_SHAPE[e.kind] ?? ENEMY_SHAPE.scout, cx, cy, s);
    ctx.fill();
    if (e.kind === "boss") {
      // 核心 + 血条：boss 是唯一的"看得出血量"的敌机
      ctx.fillStyle = "#ffe08a";
      ctx.beginPath();
      ctx.arc(cx, cy - s * 0.1, s * 0.22, 0, Math.PI * 2);
      ctx.fill();
      const ratio = Math.max(0, e.hp / spec.hp);
      ctx.fillStyle = "#2b1220";
      ctx.fillRect(u(layout, 0.6), u(layout, 0.35), u(layout, FIELD.w - 1.2), u(layout, 0.22));
      ctx.fillStyle = "#e6483c";
      ctx.fillRect(u(layout, 0.6), u(layout, 0.35), u(layout, (FIELD.w - 1.2) * ratio), u(layout, 0.22));
    } else if (spec.hp > 2) {
      ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
      ctx.fillRect(cx - s * 0.6, cy - s * 1.4, s * 1.2 * Math.max(0, e.hp / spec.hp), u(layout, 0.08));
    }
  }
}

function drawShots(ctx, game, layout) {
  ctx.fillStyle = SHOT_TINT;
  for (const s of game.shots) {
    const x = u(layout, s.x);
    ctx.fillRect(x - u(layout, 0.07), u(layout, s.y), u(layout, 0.14), u(layout, 0.5));
  }
  ctx.fillStyle = ENEMY_SHOT_TINT;
  for (const s of game.eshots) {
    ctx.beginPath();
    ctx.arc(u(layout, s.x), u(layout, s.y), u(layout, 0.2), 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawItems(ctx, game, layout, time) {
  for (const item of game.items) {
    const spec = ITEMS[item.kind];
    const cx = u(layout, item.x);
    const cy = u(layout, item.y);
    const s = u(layout, item.r);
    const bob = Math.sin(time / 260 + item.id) * s * 0.12;
    ctx.save();
    ctx.shadowColor = spec.tint;
    ctx.shadowBlur = metricsFor(layout).glow;
    ctx.fillStyle = "#0d1626";
    ctx.beginPath();
    ctx.arc(cx, cy + bob, s, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = spec.tint;
    ctx.lineWidth = metricsFor(layout).outline * 1.4;
    ctx.stroke();
    ctx.fillStyle = spec.tint;
    if (item.kind === "power") {
      path(ctx, [[0, -0.55], [-0.5, 0.45], [0.5, 0.45]], cx, cy + bob, s);
      ctx.fill();
    } else if (item.kind === "repair") {
      ctx.fillRect(cx - s * 0.55, cy + bob - s * 0.16, s * 1.1, s * 0.32);
      ctx.fillRect(cx - s * 0.16, cy + bob - s * 0.55, s * 0.32, s * 1.1);
    } else {
      ctx.beginPath();
      ctx.arc(cx, cy + bob, s * 0.42, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

function drawFx(ctx, game, layout) {
  for (const f of game.fx) {
    const k = Math.max(0, Math.min(1, f.t / f.life));
    const cx = u(layout, f.x);
    const cy = u(layout, f.y);
    const base = u(layout, f.r ?? SHIP.r);
    ctx.globalAlpha = 1 - k;
    ctx.strokeStyle = f.kind === "spark" ? "#ffd166" : "#ffb26b";
    ctx.lineWidth = metricsFor(layout).outline;
    ctx.beginPath();
    ctx.arc(cx, cy, base * (0.4 + k * 1.8), 0, Math.PI * 2);
    ctx.stroke();
    const shards = f.kind === "spark" ? 4 : 8;
    ctx.fillStyle = f.kind === "spark" ? "#ffe9a8" : "#ff9d5c";
    for (let i = 0; i < shards; i += 1) {
      const angle = (i / shards) * Math.PI * 2 + hashJitter(f.seed, i + 1) * 0.6;
      const dist = base * (0.3 + k * 1.6) * (0.7 + hashJitter(f.seed, i + 11) * 0.6);
      const size = metricsFor(layout).star * (1 + k);
      ctx.fillRect(cx + Math.cos(angle) * dist, cy + Math.sin(angle) * dist, size, size);
    }
  }
  ctx.globalAlpha = 1;
}

export function draw(ctx, game, layout, time = 0) {
  const css = layout.css;
  ctx.clearRect(0, 0, css.width, css.height);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, css.width, css.height);

  drawStars(ctx, game, layout, time);
  drawItems(ctx, game, layout, time);
  drawEnemies(ctx, game, layout);
  drawShots(ctx, game, layout);
  if (game.status !== "over") drawShip(ctx, game, layout, time);
  drawFx(ctx, game, layout);

  if (game.flash > 0) {
    ctx.globalAlpha = Math.min(0.7, game.flash / 0.5);
    ctx.fillStyle = "#e8f6ff";
    ctx.fillRect(0, 0, css.width, css.height);
    ctx.globalAlpha = 1;
  }

  if (game.status === "paused" || game.status === "over" || game.status === "won" || game.status === "ready") {
    ctx.fillStyle = VEIL;
    ctx.fillRect(0, 0, css.width, css.height);
  }
}
