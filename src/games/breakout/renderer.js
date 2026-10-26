import { FIELD, metricsFor } from "./layout.js";
import { brickColor } from "./levels.js";

const EFFECT_LABEL = {
  wide: "宽板",
  narrow: "窄板",
  slow: "缓速",
  shield: "护盾",
};

/**
 * 画布尺寸随容器变化：CSS 尺寸等于舞台盒子，位图尺寸再乘设备像素比，
 * 绘制统一使用逻辑坐标（FIELD），由 scale 一次性映射过去。
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
  const scale = canvas.width / FIELD.width;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  return ctx;
}

export function draw(ctx, game, time = 0) {
  const m = game.metrics ?? metricsFor(FIELD);
  ctx.save();
  if (game.shake > 0) {
    ctx.translate((Math.random() - 0.5) * game.shake * 6, (Math.random() - 0.5) * game.shake * 6);
  }

  drawBackground(ctx, time);
  drawBricks(ctx, game, m);
  drawParticles(ctx, game);
  drawPowerups(ctx, game, m);
  drawPaddle(ctx, game);
  drawBalls(ctx, game);
  if (game.effects.shield) drawShield(ctx, game);
  drawHud(ctx, game, m);

  ctx.restore();
}

function drawBackground(ctx, time) {
  ctx.fillStyle = "#0b1220";
  ctx.fillRect(0, 0, FIELD.width, FIELD.height);
  ctx.strokeStyle = "rgba(74, 193, 255, 0.07)";
  ctx.lineWidth = 1;
  const step = FIELD.width / 20;
  const offset = ((time * 12) % (step * 2)) - step;
  for (let x = offset; x < FIELD.width + step; x += step * 2) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + FIELD.height * 0.1, FIELD.height);
    ctx.stroke();
  }
}

function drawBricks(ctx, game, m) {
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `bold ${m.fontSize}px system-ui`;
  for (const brick of game.targets) {
    ctx.globalAlpha = brick.steel ? 1 : 0.45 + 0.55 * (brick.hp / brick.maxHp);
    ctx.fillStyle = brickColor(brick);
    roundRect(ctx, brick.x, brick.y, brick.w, brick.h, Math.min(5, brick.h * 0.2));
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.35)";
    ctx.stroke();
    if (brick.hp > 1 && !brick.steel) {
      ctx.fillStyle = "#0b1220";
      ctx.fillText(String(brick.hp), brick.x + brick.w / 2, brick.y + brick.h / 2);
    }
  }
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

function drawPaddle(ctx, game) {
  const p = game.paddle;
  const gradient = ctx.createLinearGradient(p.x, p.y, p.x + p.w, p.y);
  gradient.addColorStop(0, "#4ac1ff");
  gradient.addColorStop(1, "#7ee787");
  ctx.fillStyle = gradient;
  roundRect(ctx, p.x, p.y, p.w, p.h, p.h / 2);
  ctx.fill();
}

function drawBalls(ctx, game) {
  for (const ball of game.balls) {
    ctx.fillStyle = "#e6edf3";
    ctx.beginPath();
    ctx.arc(ball.x + ball.w / 2, ball.y + ball.h / 2, ball.w / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(74, 193, 255, 0.7)";
    ctx.stroke();
  }
}

function drawPowerups(ctx, game, m) {
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `bold ${Math.round(m.fontSize * 0.9)}px system-ui`;
  for (const item of game.powerups) {
    ctx.fillStyle = item.color;
    roundRect(ctx, item.x, item.y, item.w, item.h, item.h * 0.3);
    ctx.fill();
    ctx.fillStyle = "#0b1220";
    ctx.fillText(item.label, item.x + item.w / 2, item.y + item.h / 2);
  }
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

function drawShield(ctx) {
  ctx.strokeStyle = "#f0b072";
  ctx.lineWidth = 4;
  ctx.globalAlpha = 0.6 + 0.4 * Math.sin(Date.now() / 150);
  ctx.beginPath();
  ctx.moveTo(0, FIELD.height - 8);
  ctx.lineTo(FIELD.width, FIELD.height - 8);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1;
}

function drawParticles(ctx, game) {
  for (const p of game.particles) {
    ctx.globalAlpha = Math.max(0, Math.min(1, p.life / 24));
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x, p.y, 3, 3);
  }
  ctx.globalAlpha = 1;
}

function drawHud(ctx, game, m) {
  const hud = game.hud();
  ctx.fillStyle = "rgba(11, 18, 32, 0.92)";
  ctx.fillRect(0, 0, FIELD.width, FIELD.hud);

  const big = Math.round(m.fontSize * 1.05);
  const small = Math.round(m.fontSize * 0.85);
  ctx.font = `bold ${big}px system-ui`;
  ctx.fillStyle = "#e6edf3";
  ctx.fillText(`得分 ${hud.score}`, m.brickMarginX, FIELD.hud / 2 - m.fontSize * 0.35);
  ctx.font = `${small}px system-ui`;
  ctx.fillStyle = "#9198a1";
  ctx.fillText(`第 ${hud.level} 关 · ${hud.levelName}`, m.brickMarginX, FIELD.hud / 2 + m.fontSize * 0.6);

  ctx.textAlign = "center";
  ctx.font = `bold ${big}px system-ui`;
  ctx.fillStyle = hud.combo > 1 ? "#f778ba" : "#e6edf3";
  ctx.fillText(
    hud.combo > 1 ? `连击 ×${comboText(hud.combo)}` : `剩余 ${hud.bricksLeft}`,
    FIELD.width / 2,
    FIELD.hud / 2 + m.fontSize * 0.1,
  );

  ctx.textAlign = "right";
  ctx.font = `bold ${big}px system-ui`;
  ctx.fillStyle = "#e6edf3";
  ctx.fillText("♥".repeat(Math.max(0, hud.lives)), FIELD.width - m.brickMarginX, FIELD.hud / 2 - m.fontSize * 0.35);
  ctx.font = `${small}px system-ui`;
  ctx.fillStyle = "#9198a1";
  const effects = hud.effects.map((k) => EFFECT_LABEL[k] ?? k).join(" · ");
  ctx.fillText(effects || "无道具", FIELD.width - m.brickMarginX, FIELD.hud / 2 + m.fontSize * 0.6);
  ctx.textAlign = "left";
}

function comboText(combo) {
  return combo < 2 ? "1.0" : Math.min(4, 1 + (combo - 1) * 0.25).toFixed(2);
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}
