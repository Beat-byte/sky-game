import test from "node:test";
import assert from "node:assert/strict";
import { Game } from "../src/games/breakout/game.js";
import { FIELD, LEVELS, brickWidth, buildBricks } from "../src/games/breakout/levels.js";
import { rollDrop } from "../src/games/breakout/powerups.js";

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function newGame(seed = 1) {
  const game = new Game({ rng: makeRng(seed) });
  game.start();
  return game;
}

/** 把小球摆在砖块正下方并让它向上撞击 */
function aimBallAtBrick(game, brick) {
  const ball = game.balls[0];
  ball.stuck = false;
  ball.x = brick.x + brick.w / 2 - ball.w / 2;
  ball.y = brick.y + brick.h - ball.h / 2;
  ball.vx = 0;
  ball.vy = -game.currentSpeed();
  return ball;
}

test("关卡网格规格一致，砖块全部落在场内", () => {
  for (const level of LEVELS) {
    assert.equal(level.grid.length, 8);
    for (const row of level.grid) assert.equal(row.length, 12);
    assert.ok(level.speed > 0);
    const hits = buildBricks(level)
      .filter((b) => !b.steel)
      .reduce((sum, b) => sum + b.maxHp, 0);
    assert.equal(hits, level.budget, `${level.name} 实际命中数 ${hits} 与设计预算不符`);
    assert.ok(hits >= 30 && hits <= 60, `${level.name} 节奏应在 30-60 次命中`);
  }
  for (const brick of buildBricks(LEVELS[LEVELS.length - 1])) {
    assert.ok(brick.x >= 0 && brick.x + brick.w <= FIELD.width);
    assert.ok(brick.y > FIELD.hud, "砖块不能压住 HUD");
  }
  assert.ok(brickWidth() > 0);
});

test("钢块视为不可摧毁，不计入过关条件", () => {
  const game = newGame();
  const level = LEVELS[1];
  game.loadLevel(1);
  const steel = game.bricks.filter((b) => b.steel);
  assert.ok(steel.length > 0, `${level.name} 应包含钢块`);
  game.bricks = game.bricks.filter((b) => b.steel);
  game.balls[0].stuck = false;
  game.update(1 / 60);
  assert.equal(game.status, "cleared");
});

test("小球击中砖块会扣耐久并计分", () => {
  const game = newGame(7);
  const brick = game.targets.find((b) => !b.steel);
  const before = game.score;
  aimBallAtBrick(game, brick);
  game.update(1 / 60);
  assert.ok(brick.hp < brick.maxHp || brick.hp <= 0, "耐久应下降");
  assert.ok(game.score > before, "得分应增加");
  assert.ok(game.balls[0].vy > 0, "小球应被弹回下方");
});

test("小球每秒位移与速度一致（不是每帧位移全量）", () => {
  const game = newGame(3);
  const ball = game.balls[0];
  ball.stuck = false;
  ball.x = 400;
  ball.y = 300;
  ball.vx = 0;
  ball.vy = -300;
  game.update(1 / 60);
  assert.ok(Math.abs(ball.y - (300 - 5)) < 0.5, `实际 y=${ball.y}`);
});

test("长时间模拟后小球仍在场内且不逃逸", () => {
  const game = newGame(11);
  game.launch();
  for (let i = 0; i < 60 * 20; i += 1) {
    game.movePaddleTo(game.paddle.x + game.paddle.w / 2 + Math.sin(i / 40) * 6);
    game.update(1 / 60);
    for (const ball of game.balls) {
      assert.ok(ball.x > -20 && ball.x < FIELD.width + 20);
      assert.ok(ball.y > -20 && ball.y < FIELD.height + 40);
    }
    if (game.status === "over" || game.status === "cleared") break;
  }
  assert.notEqual(game.status, "ready");
});

/** 让在飞的球掉出底部（吸附状态的球不会掉落） */
function dropBall(game) {
  const ball = game.balls[0];
  ball.stuck = false;
  ball.vy = 300;
  ball.y = FIELD.height + 10;
}

test("掉球扣生命，生命耗尽后结束", () => {
  const game = newGame(5);
  const lives = game.lives;
  dropBall(game);
  game.update(1 / 60);
  assert.equal(game.lives, lives - 1);
  assert.equal(game.balls.length, 1);
  assert.equal(game.balls[0].stuck, true);

  while (game.status === "playing") {
    dropBall(game);
    game.update(1 / 60);
  }
  assert.equal(game.status, "over");
  assert.equal(game.lives, 0);
});

test("护盾挡住一次掉球且不扣生命", () => {
  const game = newGame(9);
  game.effects.shield = true;
  const lives = game.lives;
  dropBall(game);
  game.update(1 / 60);
  assert.equal(game.lives, lives);
  assert.equal(game.effects.shield, undefined);
});

test("吸附中的球不会掉出底部", () => {
  const game = newGame(4);
  game.balls[0].y = FIELD.height + 10;
  game.update(1 / 60);
  assert.equal(game.lives, 3);
  assert.ok(game.balls[0].y < FIELD.height);
});

test("宽板与窄板道具改变挡板宽度", () => {
  const game = newGame(13);
  const base = game.paddleWidth();
  game.effects.wide = 10;
  game.update(1 / 60);
  assert.ok(game.paddle.w > base);
  game.effects = { narrow: 10 };
  game.update(1 / 60);
  assert.ok(game.paddle.w < base);
});

test("道具只会按概率掉落，类型合法", () => {
  assert.equal(rollDrop(() => 0.99), null);
  const type = rollDrop(() => 0.01);
  assert.ok(typeof type === "string" && type.length > 0);
});

test("通关最后一关进入胜利状态", () => {
  const game = newGame(21);
  game.loadLevel(LEVELS.length - 1);
  game.balls[0].stuck = false;
  game.bricks = game.bricks.filter((b) => b.steel);
  game.update(1 / 60);
  assert.equal(game.status, "won");
});

test("nextLevel 只在过关状态下推进", () => {
  const game = newGame(2);
  game.nextLevel();
  assert.equal(game.levelIndex, 0);
  game.bricks = game.bricks.filter((b) => b.steel);
  game.balls[0].stuck = false;
  game.update(1 / 60);
  assert.equal(game.status, "cleared");
  const scoreBefore = game.score;
  game.nextLevel();
  assert.equal(game.levelIndex, 1);
  assert.equal(game.status, "playing");
  assert.ok(scoreBefore >= 200);
});
