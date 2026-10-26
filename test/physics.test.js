import test from "node:test";
import assert from "node:assert/strict";
import {
  bounceAgainstRect,
  bounceOffWalls,
  clamp,
  comboMultiplier,
  enforceMinVerticalAngle,
  normalizeSpeed,
  overlaps,
  paddleBounce,
  paddleOffsetRatio,
  penetration,
  stepScale,
} from "../src/games/breakout/physics.js";

const rect = { x: 100, y: 100, w: 60, h: 20 };

test("overlaps 正确判定相交与相离", () => {
  assert.equal(overlaps({ x: 120, y: 95, w: 10, h: 10 }, rect), true);
  assert.equal(overlaps({ x: 200, y: 95, w: 10, h: 10 }, rect), false);
  assert.equal(overlaps({ x: 100, y: 130, w: 10, h: 10 }, rect), false);
});

test("penetration 在未接触时返回 null", () => {
  assert.equal(penetration({ x: 0, y: 0, w: 10, h: 10 }, rect), null);
});

test("bounceAgainstRect 选择穿透更浅的轴反弹", () => {
  const fromBelow = { x: 120, y: 112, w: 10, h: 10, vx: 0, vy: -300 };
  assert.equal(bounceAgainstRect(fromBelow, rect).normal, "bottom");
  assert.equal(bounceAgainstRect(fromBelow, rect).vy, 300);

  const fromSide = { x: 94, y: 105, w: 10, h: 10, vx: 300, vy: -10 };
  const hit = bounceAgainstRect(fromSide, rect);
  assert.equal(hit.normal, "left");
  assert.equal(hit.vx, -300);
});

test("bounceOffWalls 只翻转指向墙外的分量", () => {
  const left = { x: -2, y: 200, w: 10, h: 10, vx: -200, vy: -100 };
  assert.equal(bounceOffWalls(left, 800, 600).vx, 200);
  const right = { x: 794, y: 200, w: 10, h: 10, vx: 200, vy: 100 };
  assert.equal(bounceOffWalls(right, 800, 600).vx, -200);
  const top = { x: 200, y: -2, w: 10, h: 10, vx: 50, vy: -200 };
  assert.equal(bounceOffWalls(top, 800, 600).vy, 200);
});

test("paddleBounce 始终向上、出射角落在 12°..62° 内且被 clamp", () => {
  const center = paddleBounce(0, 300);
  assert.ok(center.vy < 0);
  assert.ok(Math.abs(center.vx) > 0, "正中反弹也应带横向分量，避免纯竖直轨迹");
  assert.ok(Math.abs(Math.atan2(center.vx, -center.vy)) >= (11 * Math.PI) / 180);
  assert.ok(Math.abs(Math.atan2(center.vx, -center.vy)) <= (63 * Math.PI) / 180);

  const left = paddleBounce(-0.5, 300);
  const right = paddleBounce(0.5, 300);
  assert.ok(left.vx < 0 && right.vx > 0, "命中方向决定左右出射");
  const edge = paddleBounce(3, 300);
  const clamped = paddleBounce(1, 300);
  assert.ok(Math.abs(edge.vx - clamped.vx) < 1e-9);
  assert.ok(Math.abs(edge.vy - clamped.vy) < 1e-9);
});

test("paddleOffsetRatio 归一到 -1..1", () => {
  const paddle = { x: 100, y: 500, w: 100, h: 16 };
  assert.equal(paddleOffsetRatio({ x: 145, y: 480, w: 10, h: 10 }, paddle), 0);
  assert.equal(paddleOffsetRatio({ x: 500, y: 480, w: 10, h: 10 }, paddle), 1);
  assert.equal(paddleOffsetRatio({ x: -50, y: 480, w: 10, h: 10 }, paddle), -1);
});

test("normalizeSpeed 保持方向、锁定速率", () => {
  const v = normalizeSpeed({ vx: 3, vy: 4 }, 300);
  assert.ok(Math.abs(Math.hypot(v.vx, v.vy) - 300) < 1e-9);
});

test("enforceMinVerticalAngle 拒绝过于水平的轨迹", () => {
  const flat = enforceMinVerticalAngle({ vx: 300, vy: 1 }, 0.25);
  assert.ok(Math.abs(flat.vy) >= Math.hypot(flat.vx, flat.vy) * 0.25 - 1e-9);
  assert.ok(flat.vy > 0, "保持原有上下方向");
});

test("comboMultiplier 从 1 起步且封顶 4", () => {
  assert.equal(comboMultiplier(1), 1);
  assert.equal(comboMultiplier(5), 2);
  assert.equal(comboMultiplier(1000), 4);
});

test("stepScale 把秒换算成 60 帧步长并限制最大值", () => {
  assert.ok(Math.abs(stepScale(1 / 60) - 1) < 1e-9);
  assert.equal(stepScale(10), 3);
  assert.equal(clamp(5, 0, 3), 3);
});
