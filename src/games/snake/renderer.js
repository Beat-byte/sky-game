/**
 * 贪吃蛇的 Canvas 绘制。只吃"格子坐标 + 画布 CSS 尺寸"，不参与任何游戏判定，
 * 因此单元测试可以完全不碰这里。
 */

import { backingSize } from "./layout.js";

const BG = "#0e1726";
const EDGE = "rgba(148, 163, 184, 0.08)";
const HEAD = [110, 231, 183];
const TAIL = [6, 95, 70];
const FOOD = "#fbbf24";

export function setupCanvas(canvas, css) {
  const { width, height, dpr } = backingSize(css);
  canvas.width = width;
  canvas.height = height;
  canvas.style.width = `${css.width}px`;
  canvas.style.height = `${css.height}px`;
  const ctx = canvas.getContext("2d");
  // 之后所有绘制都按 CSS 像素下笔，高分屏由这层变换负责
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

function ramp(t) {
  const c = HEAD.map((start, i) => Math.round(start + (TAIL[i] - start) * t));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
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

export function draw(ctx, game, css, time = 0) {
  const { cols, rows } = game;
  const cell = css.width / cols;
  const pad = Math.max(1, cell * 0.08);

  ctx.clearRect(0, 0, css.width, css.height);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, css.width, css.height);

  if (cell >= 12) {
    ctx.strokeStyle = EDGE;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 1; x < cols; x += 1) {
      ctx.moveTo(Math.round(x * cell) + 0.5, 0);
      ctx.lineTo(Math.round(x * cell) + 0.5, rows * cell);
    }
    for (let y = 1; y < rows; y += 1) {
      ctx.moveTo(0, Math.round(y * cell) + 0.5);
      ctx.lineTo(cols * cell, Math.round(y * cell) + 0.5);
    }
    ctx.stroke();
  }

  if (game.food) {
    const pulse = 0.3 + 0.06 * Math.sin(time / 180);
    const cx = game.food.x * cell + cell / 2;
    const cy = game.food.y * cell + cell / 2;
    ctx.save();
    ctx.shadowColor = FOOD;
    ctx.shadowBlur = cell * 0.55;
    ctx.fillStyle = FOOD;
    ctx.beginPath();
    ctx.arc(cx, cy, cell * pulse, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  const last = Math.max(1, game.snake.length - 1);
  for (let i = last - 1; i >= 0; i -= 1) {
    const seg = game.snake[i];
    ctx.fillStyle = ramp(i / last);
    roundRect(ctx, seg.x * cell + pad, seg.y * cell + pad, cell - pad * 2, cell - pad * 2, cell * 0.28);
    ctx.fill();
  }

  const head = game.snake[0];
  const dir = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[game.dir] || [1, 0];
  ctx.fillStyle = "#04101c";
  const eye = Math.max(1.5, cell * 0.09);
  const hx = head.x * cell + cell / 2;
  const hy = head.y * cell + cell / 2;
  const offX = dir[1] === 0 ? dir[0] * cell * 0.16 : cell * 0.16;
  const offY = dir[0] === 0 ? dir[1] * cell * 0.16 : cell * 0.16;
  ctx.beginPath();
  ctx.arc(hx + offX - dir[0] * cell * 0.02, hy + offY - dir[1] * cell * 0.02, eye, 0, Math.PI * 2);
  ctx.arc(hx - offX - dir[0] * cell * 0.02, hy - offY - dir[1] * cell * 0.02, eye, 0, Math.PI * 2);
  ctx.fill();

  if (game.status === "paused" || game.status === "over" || game.status === "won") {
    ctx.fillStyle = "rgba(6, 12, 22, 0.62)";
    ctx.fillRect(0, 0, css.width, css.height);
  }
}
