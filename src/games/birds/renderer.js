/**
 * Canvas 绘制：只读 game 状态 + layout 几何 + 相机，绝不写回任何状态。
 * 所以同一帧画两次像素完全一致 —— test/birds.test.js 里"渲染不改状态"与"两次绘制指令相同"
 * 两例钉住这条，否则截图对拍与 DEV 钩子的复验都不成立。
 *
 * 不许 Math.random：云的位置、草皮花纹、裂纹角度一律由整数序号经 hashJitter 派生。
 * 渲染层能从 metrics 拿的只有线宽、字号这类装饰量；物理量（米）先经 ppm 换算再下笔。
 */

import { BIRDS, LEVEL_WIDTH, SLING } from "./levels.js";
import { MATERIALS } from "./physics.js";
import { backingSize } from "./layout.js";

const SKY_TOP = "#0a1120";
const SKY_MID = "#16233c";
const SKY_LOW = "#3a3350";
const GLOW = "#7c5a46";
const HILL_FAR = "#1a2740";
const HILL_NEAR = "#16203a";
const SOIL = "#221c2b";
const SOIL_DEEP = "#171320";
const GRASS = "#3d6b45";
const GRASS_EDGE = "#5d9a63";

function hashJitter(x, y, salt = 0) {
  const s = Math.sin(x * 127.1 + y * 311.7 + salt * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

export function setupCanvas(canvas, css) {
  const { width, height, dpr } = backingSize(css);
  canvas.width = width;
  canvas.height = height;
  canvas.style.width = `${css.width}px`;
  canvas.style.height = `${css.height}px`;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

/** 世界→屏幕的两个闭包，整个 draw 只用它们换算，避免中途忘了减相机 */
function projector(layout, cam) {
  const { ppm, css } = layout;
  return {
    x: (wx) => (wx - cam.x) * ppm,
    y: (wy) => css.height - (wy - cam.y) * ppm,
  };
}

function sky(ctx, layout) {
  const g = ctx.createLinearGradient(0, 0, 0, layout.css.height);
  g.addColorStop(0, SKY_TOP);
  g.addColorStop(0.52, SKY_MID);
  g.addColorStop(0.86, SKY_LOW);
  g.addColorStop(1, GLOW);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, layout.css.width, layout.css.height);
}

function stars(ctx, layout, cam, time) {
  const p = projector(layout, cam);
  const rows = 26;
  ctx.fillStyle = "rgba(230, 237, 243, 0.55)";
  for (let i = 0; i < rows; i += 1) {
    const wx = (i * 4.31) % (LEVEL_WIDTH + 6);
    const wy = 8.6 + hashJitter(i, 1, 3) * 7;
    const tw = 0.35 + 0.65 * Math.abs(Math.sin(time / 900 + i));
    const r = Math.max(0.6, layout.ppm * 0.028) * (0.7 + hashJitter(i, 2, 5) * 0.7);
    ctx.globalAlpha = 0.25 + tw * 0.4;
    ctx.beginPath();
    ctx.arc(p.x(wx), p.y(wy), r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function clouds(ctx, layout, cam, time) {
  const p = projector(layout, cam);
  const drift = (time / 1000) * 0.22;
  for (let i = 0; i < 5; i += 1) {
    const base = 1.5 + i * 6.4 + hashJitter(i, 4, 9) * 2.5;
    const wx = ((base + drift) % (LEVEL_WIDTH + 10)) - 5;
    const wy = 6.2 + hashJitter(i, 6, 2) * 5.4;
    const w = (1.9 + hashJitter(i, 8, 4) * 1.5) * layout.ppm;
    const h = w * 0.32;
    ctx.fillStyle = "rgba(148, 163, 184, 0.16)";
    for (let k = 0; k < 3; k += 1) {
      ctx.beginPath();
      ctx.ellipse(p.x(wx) + (k - 1) * w * 0.34, p.y(wy) + hashJitter(i, k, 11) * h * 0.4, w * (0.5 - k * 0.06), h * 0.62, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function hills(ctx, layout, cam) {
  const p = projector(layout, cam);
  const layers = [
    { color: HILL_FAR, height: 2.9, step: 2.6, seed: 1 },
    { color: HILL_NEAR, height: 1.7, step: 1.9, seed: 7 },
  ];
  for (const layer of layers) {
    ctx.fillStyle = layer.color;
    ctx.beginPath();
    ctx.moveTo(-40, p.y(0));
    for (let i = -1; i <= Math.ceil(LEVEL_WIDTH / layer.step) + 1; i += 1) {
      const wx = i * layer.step;
      const wy = layer.height * (0.45 + hashJitter(i, layer.seed, 3) * 0.75);
      ctx.lineTo(p.x(wx), p.y(wy));
      ctx.lineTo(p.x(wx + layer.step / 2), p.y(wy * 0.62));
    }
    ctx.lineTo(layout.css.width + 40, p.y(0));
    ctx.closePath();
    ctx.fill();
  }
}

function ground(ctx, layout, cam) {
  const p = projector(layout, cam);
  const top = p.y(0);
  ctx.fillStyle = SOIL;
  ctx.fillRect(0, top, layout.css.width, layout.css.height - top + 1);
  const band = Math.max(2, layout.ppm * 0.16);
  ctx.fillStyle = GRASS;
  ctx.fillRect(0, top, layout.css.width, band);
  ctx.fillStyle = GRASS_EDGE;
  ctx.fillRect(0, top, layout.css.width, Math.max(1, band * 0.28));
  // 草穗与土层纹路由整数米刻度派生，画两次完全一样
  ctx.fillStyle = "rgba(93, 154, 99, 0.5)";
  for (let m = 0; m < LEVEL_WIDTH + 2; m += 1) {
    const jitter = hashJitter(m, 13, 2);
    const x = p.x(m + jitter);
    if (x < -8 || x > layout.css.width + 8) continue;
    const h = band * (0.5 + jitter * 0.9);
    ctx.fillRect(x, top - h, Math.max(1, layout.ppm * 0.03), h);
  }
  ctx.fillStyle = SOIL_DEEP;
  for (let m = 0; m < LEVEL_WIDTH + 4; m += 2) {
    const x = p.x(m + hashJitter(m, 17, 5) * 1.4);
    ctx.fillRect(x, top + band * 1.6, Math.max(2, layout.ppm * 0.5), Math.max(1, band * 0.3));
  }
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function block(ctx, layout, cam, body) {
  const p = projector(layout, cam);
  const spec = MATERIALS[body.material] ?? MATERIALS.wood;
  const w = body.hw * 2 * layout.ppm;
  const h = body.hh * 2 * layout.ppm;
  const x = p.x(body.x) - w / 2;
  const y = p.y(body.y) - h / 2;
  if (x + w < -6 || x > layout.css.width + 6) return;

  ctx.fillStyle = spec.color;
  roundRect(ctx, x, y, w, h, Math.min(6, Math.max(1.5, layout.ppm * 0.08)));
  ctx.fill();
  // 顶盖亮边 + 底边暗边：方块在深色背景下靠这两条分清上下
  ctx.fillStyle = "rgba(255, 255, 255, 0.22)";
  ctx.fillRect(x + w * 0.06, y + h * 0.08, w * 0.88, Math.max(1.5, h * 0.12));
  ctx.fillStyle = "rgba(0, 0, 0, 0.26)";
  ctx.fillRect(x + w * 0.06, y + h * 0.82, w * 0.88, Math.max(1.5, h * 0.12));
  ctx.strokeStyle = spec.edge;
  ctx.lineWidth = Math.max(1, layout.ppm * 0.035);
  roundRect(ctx, x, y, w, h, Math.min(6, Math.max(1.5, layout.ppm * 0.08)));
  ctx.stroke();

  if (body.material === "tnt") {
    ctx.fillStyle = spec.mark;
    ctx.font = `700 ${Math.max(7, h * 0.42)}px ui-monospace, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("TNT", x + w / 2, y + h / 2);
    ctx.strokeStyle = "#ffd9a0";
    ctx.lineWidth = Math.max(1, layout.ppm * 0.03);
    ctx.beginPath();
    ctx.moveTo(x + w * 0.5, y);
    ctx.quadraticCurveTo(x + w * 0.78, y - h * 0.26, x + w * 0.62, y - h * 0.5);
    ctx.stroke();
  } else if (body.material === "wood") {
    ctx.strokeStyle = "rgba(94, 60, 29, 0.5)";
    ctx.lineWidth = Math.max(0.8, layout.ppm * 0.02);
    for (let i = 1; i < 3; i += 1) {
      const gy = y + (h * i) / 3;
      ctx.beginPath();
      ctx.moveTo(x + w * 0.08, gy);
      ctx.lineTo(x + w * 0.92, gy);
      ctx.stroke();
    }
  } else if (body.material === "glass") {
    ctx.strokeStyle = "rgba(230, 248, 254, 0.5)";
    ctx.lineWidth = Math.max(1, layout.ppm * 0.025);
    ctx.beginPath();
    ctx.moveTo(x + w * 0.18, y + h * 0.82);
    ctx.lineTo(x + w * 0.82, y + h * 0.18);
    ctx.stroke();
  }

  // 掉血后按剩余比例画裂纹，角度由 id 派生
  const ratio = body.hp / body.maxHp;
  if (ratio < 0.999 && Number.isFinite(ratio)) {
    const marks = 1 + Math.round((1 - ratio) * 3);
    ctx.strokeStyle = "rgba(12, 16, 24, 0.72)";
    ctx.lineWidth = Math.max(1, layout.ppm * 0.028);
    for (let i = 0; i < marks; i += 1) {
      const a = hashJitter(body.id, i, 21) * Math.PI;
      const cx = x + w * (0.25 + hashJitter(body.id, i, 22) * 0.5);
      const cy = y + h * (0.25 + hashJitter(body.id, i, 23) * 0.5);
      const len = Math.min(w, h) * 0.42;
      ctx.beginPath();
      ctx.moveTo(cx - Math.cos(a) * len, cy - Math.sin(a) * len);
      ctx.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len);
      ctx.stroke();
    }
  }
}

function pig(ctx, layout, cam, body) {
  const p = projector(layout, cam);
  const r = body.r * layout.ppm;
  const cx = p.x(body.x);
  const cy = p.y(body.y);
  if (cx + r < -6 || cx - r > layout.css.width + 6) return;
  const hurt = body.hp / body.maxHp < 0.6;
  ctx.fillStyle = hurt ? "#5f9b52" : "#7fc86a";
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#2f5d33";
  ctx.lineWidth = Math.max(1, r * 0.12);
  ctx.stroke();
  // 耳朵
  ctx.fillStyle = hurt ? "#6fae5f" : "#8fd877";
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(cx + side * r * 0.62, cy - r * 0.72, r * 0.24, r * 0.32, side * 0.5, 0, Math.PI * 2);
    ctx.fill();
  }
  // 鼻与眼
  ctx.fillStyle = "#c7edb6";
  ctx.beginPath();
  ctx.ellipse(cx, cy + r * 0.16, r * 0.42, r * 0.32, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#3d6b3a";
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(cx + side * r * 0.15, cy + r * 0.16, r * 0.08, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = "#12200f";
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(cx + side * r * 0.34, cy - r * 0.24, r * 0.13, 0, Math.PI * 2);
    ctx.fill();
  }
  if (hurt) {
    // 受伤时压低眉毛，玩家一眼看出谁快死了
    ctx.strokeStyle = "#1c2b18";
    ctx.lineWidth = Math.max(1, r * 0.1);
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(cx + side * r * 0.52, cy - r * 0.46);
      ctx.lineTo(cx + side * r * 0.16, cy - r * 0.3);
      ctx.stroke();
    }
  }
}

function bird(ctx, layout, cam, body, name) {
  const spec = BIRDS[name] ?? BIRDS.red;
  const p = projector(layout, cam);
  const r = (body.r ?? spec.r) * layout.ppm;
  const cx = p.x(body.x);
  const cy = p.y(body.y);
  const angle = Math.atan2(body.vy ?? 0, body.vx ?? 0);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-angle * 0.45);
  ctx.fillStyle = spec.color;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(8, 12, 20, 0.6)";
  ctx.lineWidth = Math.max(1, r * 0.12);
  ctx.stroke();
  ctx.fillStyle = spec.belly;
  ctx.beginPath();
  ctx.ellipse(-r * 0.1, r * 0.42, r * 0.62, r * 0.4, 0, 0, Math.PI * 2);
  ctx.fill();
  // 喙朝飞行方向
  ctx.fillStyle = "#f6a83c";
  ctx.beginPath();
  ctx.moveTo(r * 0.5, -r * 0.05);
  ctx.lineTo(r * 1.35, r * 0.16);
  ctx.lineTo(r * 0.5, r * 0.36);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#0d1522";
  ctx.beginPath();
  ctx.arc(r * 0.32, -r * 0.3, r * 0.16, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#f4f7fb";
  ctx.beginPath();
  ctx.arc(r * 0.36, -r * 0.34, r * 0.07, 0, Math.PI * 2);
  ctx.fill();
  // 尾羽
  ctx.strokeStyle = spec.color;
  ctx.lineWidth = Math.max(1, r * 0.18);
  for (let i = 0; i < 3; i += 1) {
    ctx.beginPath();
    ctx.moveTo(-r * 0.75, 0);
    ctx.lineTo(-r * 1.35, -r * 0.4 + i * r * 0.4);
    ctx.stroke();
  }
  ctx.restore();
}

function slingshot(ctx, layout, cam, game) {
  const p = projector(layout, cam);
  const wood = "#6b4a2f";
  const px = p.x(SLING.x);
  const baseY = p.y(0);
  ctx.strokeStyle = wood;
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(3, layout.ppm * 0.2);
  ctx.beginPath();
  ctx.moveTo(px, baseY);
  ctx.lineTo(px, p.y(SLING.leg));
  ctx.stroke();
  ctx.lineWidth = Math.max(2.5, layout.ppm * 0.16);
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(px, p.y(SLING.leg));
    ctx.lineTo(px + side * layout.ppm * 0.34, p.y(SLING.y));
    ctx.stroke();
  }

  const aiming = game.phase === "aim" && game.status === "playing";
  const pouch = game.pouchWorld();
  const pp = { x: p.x(pouch.x), y: p.y(pouch.y) };
  const bandY = p.y(SLING.y);
  // 皮筋：后叉先连，再画鸟，最后前叉压住鸟，层次才对
  ctx.strokeStyle = "#3d2a1c";
  ctx.lineWidth = Math.max(2, layout.ppm * 0.11);
  ctx.beginPath();
  ctx.moveTo(px - layout.ppm * 0.34, bandY);
  ctx.lineTo(pp.x, pp.y);
  ctx.stroke();

  if (aiming || game.status === "ready") {
    const spec = BIRDS[game.queue[game.shotIndex]] ?? BIRDS.red;
    bird(ctx, layout, cam, { x: pouch.x, y: pouch.y, r: spec.r, vx: 0, vy: 0 }, game.queue[game.shotIndex]);
  }
  ctx.beginPath();
  ctx.moveTo(px + layout.ppm * 0.34, bandY);
  ctx.lineTo(pp.x, pp.y);
  ctx.stroke();
}

function trajectory(ctx, layout, cam, game) {
  if (game.phase !== "aim" || game.status !== "playing") return;
  if (game.aim.power < 0.02) return;
  const p = projector(layout, cam);
  const points = game.trajectory();
  ctx.fillStyle = "rgba(244, 247, 251, 0.62)";
  for (let i = 0; i < points.length; i += 1) {
    const pt = points[i];
    const fade = 1 - i / points.length;
    ctx.globalAlpha = 0.2 + fade * 0.65;
    ctx.beginPath();
    ctx.arc(p.x(pt.x), p.y(pt.y), Math.max(1.4, layout.ppm * 0.055 * (0.6 + fade * 0.6)), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function trail(ctx, layout, cam, game) {
  if (game.trail.length < 2) return;
  const p = projector(layout, cam);
  ctx.strokeStyle = "rgba(246, 208, 138, 0.45)";
  ctx.lineWidth = Math.max(1, layout.ppm * 0.04);
  ctx.beginPath();
  ctx.moveTo(p.x(game.trail[0].x), p.y(game.trail[0].y));
  for (const pt of game.trail) ctx.lineTo(p.x(pt.x), p.y(pt.y));
  ctx.stroke();
}

function puffs(ctx, layout, cam, game) {
  const p = projector(layout, cam);
  for (const q of game.puffs) {
    const alpha = 1 - q.life / q.ttl;
    ctx.globalAlpha = Math.max(0, alpha) * 0.85;
    ctx.fillStyle = q.color;
    const r = q.size * layout.ppm * (0.6 + alpha * 0.8);
    ctx.fillRect(p.x(q.x) - r / 2, p.y(q.y) - r / 2, r, r);
  }
  ctx.globalAlpha = 1;
}

export function draw(ctx, game, layout, cam, time = 0) {
  const { css } = layout;
  ctx.clearRect(0, 0, css.width, css.height);
  sky(ctx, layout);
  stars(ctx, layout, cam, time);
  clouds(ctx, layout, cam, time);
  hills(ctx, layout, cam);
  ground(ctx, layout, cam);
  trajectory(ctx, layout, cam, game);
  slingshot(ctx, layout, cam, game);
  trail(ctx, layout, cam, game);

  const pigs = [];
  for (const body of game.world.bodies) {
    if (body.kind === "pig") {
      pigs.push(body);
      continue;
    }
    if (body.kind === "bird") {
      if (body.birdName) bird(ctx, layout, cam, body, body.birdName);
      continue;
    }
    block(ctx, layout, cam, body);
  }
  for (const body of pigs) pig(ctx, layout, cam, body);
  puffs(ctx, layout, cam, game);

  // 关卡边界的淡出带：让玩家知道相机到头了，而不是画面被切了一刀
  const p = projector(layout, cam);
  if (cam.x < 0.4) edgeFade(ctx, css, p.x(0), 1);
  if (cam.x + layout.view.width > LEVEL_WIDTH - 0.4) edgeFade(ctx, css, p.x(LEVEL_WIDTH), -1);
}

function edgeFade(ctx, css, at, dir) {
  const width = Math.max(10, css.width * 0.03);
  const g = ctx.createLinearGradient(at - dir * width, 0, at + dir * width, 0);
  g.addColorStop(0, "rgba(10, 17, 32, 0.55)");
  g.addColorStop(1, "rgba(10, 17, 32, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(Math.min(at, at - dir * width), 0, width * 2, css.height);
}
