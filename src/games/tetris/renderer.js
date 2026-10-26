/**
 * Canvas 渲染层：只读游戏状态与逻辑场地，不改状态、不接 DOM 事件，保持框架无关。
 * 绘制统一用逻辑坐标（FIELD），由 setupCanvas 的一次 setTransform 映射到位图像素，
 * 因此格子边长随场地缩放，行列数恒定 10×20。
 */

import { COLS, FIELD, ROWS, metricsFor } from "./layout.js";
import { CLEAR_FLASH, LOCK_DELAY } from "./game.js";
import { PIECES, filledCells, pieceColor, trimMatrix } from "./pieces.js";

const BG = "#0a1120";
const BOARD_BG = "#0e1728";
const LINE = "rgba(147, 164, 189, 0.1)";
const FRAME = "rgba(74, 193, 255, 0.35)";
const TEXT = "#93a4bd";

/**
 * 画布尺寸随容器变化：CSS 尺寸等于画布盒子，位图尺寸再乘设备像素比。
 * 返回 2D 上下文，调用方每帧直接用它绘制逻辑坐标。
 */
export function setupCanvas(canvas, box) {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const cssWidth = Math.max(1, box.width);
  const cssHeight = Math.max(1, box.height);
  canvas.style.width = cssWidth + "px";
  canvas.style.height = cssHeight + "px";
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(canvas.width / FIELD.width, 0, 0, canvas.width / FIELD.width, 0, 0);
  return ctx;
}

export function draw(ctx, game, time = 0) {
  const m = game.metrics ?? metricsFor(FIELD, FIELD.device);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, FIELD.width, FIELD.height);

  drawBoardBg(ctx, m);
  if (m.showPanels) {
    const rightCenter = m.originX + m.boardWidth + m.panelWidth / 2;
    const leftCenter = Math.max(m.panelWidth / 2, m.originX - m.panelWidth / 2);
    drawPanel(ctx, m, "下一块", game.nextId, rightCenter, FIELD.height * 0.16, m.cell);
    drawPanel(ctx, m, "暂存", game.hold, leftCenter, FIELD.height * 0.16, m.cell, game.holdUsed);
  }

  drawStack(ctx, game, m);
  drawGhost(ctx, game, m);
  drawCurrent(ctx, game, m);
  drawFlash(ctx, game, m);
  drawDanger(ctx, game, m, time);
  drawFrame(ctx, m);
}

/** 棋盘底：细网格线帮助判断列位，横竖都按恒定行列数划分 */
function drawBoardBg(ctx, m) {
  ctx.fillStyle = BOARD_BG;
  ctx.fillRect(m.originX, m.originY, m.boardWidth, m.boardHeight);
  ctx.strokeStyle = LINE;
  ctx.lineWidth = Math.max(0.5, m.lineWidth * 0.5);
  for (let c = 1; c < COLS; c += 1) {
    const x = m.originX + c * m.cell;
    ctx.beginPath();
    ctx.moveTo(x, m.originY);
    ctx.lineTo(x, m.originY + m.boardHeight);
    ctx.stroke();
  }
  for (let r = 1; r < ROWS; r += 1) {
    const y = m.originY + r * m.cell;
    ctx.beginPath();
    ctx.moveTo(m.originX, y);
    ctx.lineTo(m.originX + m.boardWidth, y);
    ctx.stroke();
  }
}

function drawFrame(ctx, m) {
  ctx.strokeStyle = FRAME;
  ctx.lineWidth = m.lineWidth;
  ctx.strokeRect(m.originX, m.originY, m.boardWidth, m.boardHeight);
}

/** 已落定的格子 */
function drawStack(ctx, game, m) {
  for (let r = 0; r < ROWS; r += 1) {
    for (let c = 0; c < COLS; c += 1) {
      const id = game.grid[r][c];
      if (!id) continue;
      drawCell(ctx, m.originX + c * m.cell, m.originY + r * m.cell, m.cell, pieceColor(id));
    }
  }
}

/** 落点预览：只描边 + 半透明填充，不遮挡底下的堆叠 */
function drawGhost(ctx, game, m) {
  const p = game.current;
  if (!p) return;
  const gy = game.ghostY();
  if (gy === p.y) return;
  for (const cell of filledCells(p.matrix)) {
    const row = gy + cell.row;
    if (row < 0) continue;
    const x = m.originX + (p.x + cell.col) * m.cell;
    const y = m.originY + row * m.cell;
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = pieceColor(p.id);
    ctx.fillRect(x + m.gap, y + m.gap, m.cell - m.gap * 2, m.cell - m.gap * 2);
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = pieceColor(p.id);
    ctx.lineWidth = m.lineWidth;
    ctx.strokeRect(x + m.gap, y + m.gap, m.cell - m.gap * 2, m.cell - m.gap * 2);
    ctx.globalAlpha = 1;
  }
}

/** 当前块：锁定宽限期内逐渐变淡，把「马上要落地了」显式告诉玩家 */
function drawCurrent(ctx, game, m) {
  const p = game.current;
  if (!p) return;
  const fading = game.grounded() && game.lockTimer > 0;
  const alpha = fading ? 1 - 0.45 * Math.min(1, game.lockTimer / LOCK_DELAY) : 1;
  ctx.globalAlpha = alpha;
  for (const cell of filledCells(p.matrix)) {
    const row = p.y + cell.row;
    if (row < 0) continue;
    drawCell(ctx, m.originX + (p.x + cell.col) * m.cell, m.originY + row * m.cell, m.cell, pieceColor(p.id));
  }
  ctx.globalAlpha = 1;
}

/** 消行闪光：刚消掉的行铺一层白光，强度随倒计时衰减 */
function drawFlash(ctx, game, m) {
  if (game.clearFlash <= 0 || game.clearRows.length === 0) return;
  ctx.globalAlpha = Math.min(0.75, game.clearFlash / CLEAR_FLASH);
  ctx.fillStyle = "#ffffff";
  for (const row of game.clearRows) {
    ctx.fillRect(m.originX, m.originY + row * m.cell, m.boardWidth, m.cell);
  }
  ctx.globalAlpha = 1;
}

/** 堆得太高时在顶部画一条警告线，提醒还剩两行余地 */
function drawDanger(ctx, game, m, time) {
  const top = game.topRow();
  if (top > 4) return;
  const pulse = 0.45 + 0.35 * Math.sin(time * 6);
  ctx.globalAlpha = Math.max(0.2, pulse);
  ctx.strokeStyle = "#ff6b6b";
  ctx.lineWidth = m.lineWidth;
  ctx.setLineDash([m.cell * 0.5, m.cell * 0.3]);
  const y = m.originY + 4 * m.cell;
  ctx.beginPath();
  ctx.moveTo(m.originX, y);
  ctx.lineTo(m.originX + m.boardWidth, y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

/** 单格：主体 + 上高光 + 下阴影，做出像素块的立体感 */
function drawCell(ctx, x, y, size, color) {
  const inset = Math.min(2, size * 0.08);
  const w = size - inset * 2;
  ctx.fillStyle = color;
  ctx.fillRect(x + inset, y + inset, w, w);
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(x + inset, y + inset, w, Math.max(1, w * 0.16));
  ctx.globalAlpha = 0.28;
  ctx.fillStyle = "#000000";
  ctx.fillRect(x + inset, y + size - inset - Math.max(1, w * 0.16), w, Math.max(1, w * 0.16));
  ctx.globalAlpha = 1;
}

/**
 * 画布侧边预览面板（横屏/桌面才有空间）：居中的小方块 + 中文标签。
 * xCenter 传面板中心的横坐标；used 为真时在下方补一句「本块已用」，
 * 提示玩家暂存槽这局当前这块已经换过一次了。
 */
function drawPanel(ctx, m, label, pieceId, xCenter, yTop, cell, used = false) {
  const box = Math.min(m.panelWidth - cell * 0.5, cell * 3.4);
  const x = xCenter - box / 2;
  ctx.fillStyle = "rgba(19, 29, 46, 0.85)";
  ctx.fillRect(x, yTop, box, box);
  ctx.strokeStyle = used ? "rgba(251, 191, 36, 0.7)" : "rgba(39, 52, 74, 1)";
  ctx.lineWidth = m.lineWidth;
  ctx.strokeRect(x, yTop, box, box);

  ctx.fillStyle = TEXT;
  ctx.font = `${Math.round(m.fontSize)}px system-ui`;
  ctx.textAlign = "center";
  ctx.fillText(label, xCenter, yTop - m.fontSize * 0.5);

  if (pieceId && PIECES[pieceId]) {
    const shape = trimMatrix(PIECES[pieceId].shape);
    const unit = Math.min((box * 0.8) / shape[0].length, (box * 0.8) / shape.length);
    const startX = xCenter - (shape[0].length * unit) / 2;
    const startY = yTop + box / 2 - (shape.length * unit) / 2;
    for (const cellPos of filledCells(shape)) {
      drawCell(ctx, startX + cellPos.col * unit, startY + cellPos.row * unit, unit, pieceColor(pieceId));
    }
  }
  if (used) {
    ctx.fillStyle = "#fbbf24";
    ctx.font = `${Math.round(m.fontSize * 0.8)}px system-ui`;
    ctx.fillText("本块已用", xCenter, yTop + box + m.fontSize * 1.1);
  }
  ctx.textAlign = "left";
}
