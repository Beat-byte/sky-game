import test from "node:test";
import assert from "node:assert/strict";
import { Game } from "../src/games/tetris/game.js";
import {
  ACTIONS,
  GRAVITY_TABLE,
  HARD_DROP_SCORE,
  KICKS,
  LINES_PER_LEVEL,
  LINE_SCORES,
  LOCK_DELAY,
  MAX_DELTA,
  MAX_LOCK_RESETS,
  QUEUE_LIMIT,
  SOFT_DROP_SCORE,
  gravityFor,
} from "../src/games/tetris/game.js";
import {
  COLS,
  MAX_ASPECT,
  MIN_ASPECT,
  ROWS,
  applyField,
  canvasBox,
  cellSize,
  computeLayout,
  fieldSize,
  metricsFor,
} from "../src/games/tetris/layout.js";
import {
  PIECE_KEYS,
  PIECES,
  createBag,
  firstFilledRow,
  filledCells,
  orientations,
  pieceColor,
  rotateMatrix,
  trimMatrix,
} from "../src/games/tetris/pieces.js";

/** 固定序列的伪随机，保证出生顺序与消行断言可复现 */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 矩阵转成 "010" 这样的字符串数组，便于逐行断言形状 */
function rowsOf(matrix) {
  return matrix.map((row) => row.join(""));
}

function expectRows(matrix, expected, label) {
  assert.deepEqual(rowsOf(matrix), expected, label);
}

function newGame(seed = 1) {
  return new Game({ rng: makeRng(seed) });
}

function startedGame(seed = 1) {
  const game = newGame(seed);
  game.start();
  return game;
}

/** 直接把某个方块摆到指定行列（矩阵朝向同步），用于构造精确局面 */
function put(game, id, x, y, turn = 0) {
  const matrix = rotateMatrix(PIECES[id].shape, turn);
  game.current = { id, turn, x, y, matrix };
  game.fallTimer = 0;
  game.lockTimer = 0;
  game.lockResets = 0;
  return game.current;
}

/** 把某行填满，except 里的列留空 */
function fillRow(game, row, except = []) {
  for (let c = 0; c < COLS; c += 1) {
    game.grid[row][c] = except.includes(c) ? null : "Z";
  }
}

/**
 * 按固定小步长泵若干秒：单步必须小于 update 的 delta 上限，
 * 否则会被夹住、累计不出真实的宽限时间。
 */
function pump(game, seconds, step = 0.02) {
  const frames = Math.round(seconds / step);
  for (let i = 0; i < frames; i += 1) game.update(step);
  return frames;
}

test("七种方块齐备且颜色互不相同", () => {
  assert.deepEqual([...PIECE_KEYS].sort(), ["I", "J", "L", "O", "S", "T", "Z"]);
  const colors = PIECE_KEYS.map((key) => pieceColor(key));
  assert.equal(new Set(colors).size, 7, "七种方块必须各自可辨");
  for (const color of colors) assert.match(color, /^#[0-9a-f]{6}$/);
});

test("旋转矩阵：转四次回到原位，四个朝向格子数守恒", () => {
  for (const key of PIECE_KEYS) {
    const list = orientations(key);
    assert.equal(list.length, 4, `${key} 应有 4 个朝向`);
    const count = filledCells(PIECES[key].shape).length;
    for (const matrix of list) {
      assert.equal(filledCells(matrix).length, count, `${key} 旋转不增不减格子`);
      assert.equal(matrix.length, PIECES[key].shape.length, `${key} 方阵边长不变`);
    }
    expectRows(rotateMatrix(list[3], 1), rowsOf(list[0]), `${key} 再转一次回到朝向 0`);
    expectRows(
      rotateMatrix(PIECES[key].shape, -1),
      rowsOf(rotateMatrix(PIECES[key].shape, 3)),
      `${key} 逆时针一次等于顺时针三次`,
    );
  }
});

test("T 与 I 的四个朝向逐一符合预期形状", () => {
  const t = orientations("T");
  expectRows(t[0], ["010", "111", "000"], "T 朝上");
  expectRows(t[1], ["010", "011", "010"], "T 朝右");
  expectRows(t[2], ["000", "111", "010"], "T 朝下");
  expectRows(t[3], ["010", "110", "010"], "T 朝左");

  const i = orientations("I");
  expectRows(i[0], ["0000", "1111", "0000", "0000"], "I 水平（第 1 行）");
  expectRows(i[1], ["0010", "0010", "0010", "0010"], "I 垂直（第 2 列）");
  expectRows(i[2], ["0000", "0000", "1111", "0000"], "I 水平（第 2 行）");
  expectRows(i[3], ["0100", "0100", "0100", "0100"], "I 垂直（第 1 列）");

  // 预览要裁掉空白，否则 4×4 空框里长条只剩一条细线
  expectRows(trimMatrix(PIECES.I.shape), ["1111"], "I 裁剪后 1×4");
  expectRows(trimMatrix(PIECES.O.shape), ["11", "11"], "O 本来就填满方阵");
  expectRows(trimMatrix(PIECES.T.shape), ["010", "111"], "T 裁掉最后一行空白");
});

test("出生：水平居中且首个填充行贴着第 0 行", () => {
  for (const key of PIECE_KEYS) {
    const game = startedGame();
    game.nextId = key;
    assert.equal(game.spawn(), true, `${key} 空场出生应成功`);
    const p = game.current;
    assert.equal(p.id, key);
    assert.equal(p.turn, 0);
    assert.equal(p.x, Math.floor((COLS - p.matrix.length) / 2), `${key} 应水平居中`);
    const rows = filledCells(p.matrix).map((cell) => cell.row);
    assert.equal(p.y + Math.min(...rows), 0, `${key} 最高填充格应落在第 0 行`);
    assert.equal(p.y + Math.max(...rows), Math.max(...rows) - firstFilledRow(p.matrix), `${key} 纵向没有额外偏移`);
    assert.equal(game.collides(p.matrix, p.x, p.y), false);
  }
});

test("逻辑棋盘恒定 10×20：越界与占用检测", () => {
  assert.equal(COLS, 10, "列数恒定，三端难度必须一致");
  assert.equal(ROWS, 20);
  const game = startedGame();
  const square = PIECES.O.shape;

  assert.equal(game.collides(square, 4, 18), false, "贴底但未越界");
  assert.equal(game.collides(square, 4, 19), true, "压到第 20 行之外");
  assert.equal(game.collides(square, -1, 4), true, "左边界外");
  assert.equal(game.collides(square, 9, 4), true, "右边界外（第 10 列）");
  assert.equal(game.collides(square, 8, 4), false, "刚好贴着右边界");
  game.grid[18][4] = "I";
  assert.equal(game.collides(square, 4, 17), true, "与已落定格子重叠");
  assert.equal(game.collides(PIECES.I.shape, 3, -1), false, "I 的空白行悬在顶外不算碰撞");

  for (const field of [{ width: 600, height: 1200 }, { width: 600, height: 520 }]) {
    applyField(field, "phone");
    game.relayout();
    assert.equal(game.grid.length, ROWS, "重排不改变行数");
    assert.ok(game.grid.every((row) => row.length === COLS), "重排不改变列数");
  }
  applyField({ width: 600, height: 1000 }, "desktop");
});

test("踢墙：贴右墙的长条靠左移一格救回", () => {
  const game = startedGame();
  // 垂直 I 的填充在第 2 列，x=7 时占第 9 列——已经贴住右墙
  const piece = put(game, "I", 7, 5, 1);
  assert.equal(game.collides(piece.matrix, piece.x, piece.y), false, "起始位置合法");
  assert.equal(game.rotate(1), true, "旋转应成功");
  assert.equal(game.current.turn, 2, "转到了水平朝向");
  assert.equal(game.current.x, 6, "向左踢了一格");
  assert.equal(game.current.y, 5, "纵向没有动");
  assert.equal(game.collides(game.current.matrix, game.current.x, game.current.y), false);
});

test("踢墙：左右都被堵住时上移一格救回", () => {
  const game = startedGame();
  // 逆时针回到水平朝向时，第 6 行第 7 列挡住原地与左移；右移越界，只剩上移
  game.grid[6][7] = "Z";
  const piece = put(game, "L", 7, 5, 1);
  expectRows(piece.matrix, ["010", "010", "011"], "L 的顺时针一版朝向");
  assert.equal(game.collides(piece.matrix, piece.x, piece.y), false, "起始位置合法");
  assert.equal(game.rotate(-1), true, "应该靠上移踢墙成功");
  assert.equal(game.current.turn, 0);
  assert.equal(game.current.x, 7, "横向没有让位");
  assert.equal(game.current.y, 4, "整体上抬一格");
  expectRows(game.current.matrix, ["001", "111", "000"]);
});

test("踢墙失败：四个候选位都不合法时旋转不生效", () => {
  const game = startedGame();
  assert.equal(KICKS.length, 4, "候选位依次是原地、左 1、右 1、上 1");
  const piece = put(game, "I", 7, 5, 1);
  game.grid[7][6] = "Z"; // 左移位被堵；原地、右移、上移都会越过第 10 列
  const before = { turn: piece.turn, x: piece.x, y: piece.y };
  assert.equal(game.rotate(1), false);
  assert.equal(game.current.turn, before.turn, "失败不能留下半个朝向");
  assert.equal(game.current.x, before.x);
  assert.equal(game.current.y, before.y);
  assert.deepEqual(game.current.matrix, rotateMatrix(PIECES.I.shape, before.turn));
});

test("消行计分：1 行 100、4 行 800，且都乘以当前关卡", () => {
  assert.deepEqual(LINE_SCORES, [0, 100, 300, 500, 800]);

  const one = startedGame();
  fillRow(one, 19, [4, 5]);
  one.nextId = "O";
  put(one, "O", 4, 18);
  assert.equal(one.lock(), true);
  assert.equal(one.lines, 1);
  assert.equal(one.score, LINE_SCORES[1] * 1);

  const four = startedGame();
  four.level = 3;
  four.lines = 20;
  for (let row = 16; row <= 19; row += 1) fillRow(four, row, [2]);
  four.nextId = "I";
  put(four, "I", 0, 16, 1);
  assert.equal(four.lock(), true);
  assert.equal(four.lines, 24);
  assert.equal(four.score, LINE_SCORES[4] * 3, "四消应按当时的关卡倍率结算");
  assert.equal(four.level, 3, "24 行还在第 3 关");
  assert.equal(four.stats.clears[4], 1);
});

test("消行后上方整体下移，网格仍是 20 行 10 列", () => {
  const game = startedGame();
  fillRow(game, 19, [2]);
  game.grid[18][9] = "J";
  put(game, "I", 0, 16, 1);
  const scoreBefore = game.score;
  assert.equal(game.lock(), true);
  assert.equal(game.grid.length, ROWS);
  assert.ok(game.grid.every((row) => row.length === COLS));
  assert.equal(game.lines, 1);
  assert.equal(game.score, scoreBefore + LINE_SCORES[1]);
  assert.equal(game.grid[19][9], "J", "第 18 行的标记被带到第 19 行");
  assert.equal(game.grid[19][2], "I", "长条最下一格跟着下移");
  assert.ok(game.grid[16].every((cell) => cell === null), "顶部补出空行");
  assert.deepEqual(game.clearRows, [19]);
  assert.ok(game.clearFlash > 0, "消行应有闪光时长");
});

test("每累计 10 行升一关；速度表严格单调递减", () => {
  assert.ok(GRAVITY_TABLE.length >= 12, "至少给出 12 档速度");
  for (let i = 1; i < GRAVITY_TABLE.length; i += 1) {
    assert.ok(GRAVITY_TABLE[i] < GRAVITY_TABLE[i - 1], `第 ${i + 1} 档应比上一档更快`);
    assert.ok(GRAVITY_TABLE[i] > 0);
  }
  assert.equal(gravityFor(1), GRAVITY_TABLE[0]);
  assert.equal(gravityFor(GRAVITY_TABLE.length), GRAVITY_TABLE[GRAVITY_TABLE.length - 1]);
  assert.equal(gravityFor(999), GRAVITY_TABLE[GRAVITY_TABLE.length - 1], "超出表尾按最快档兜底");
  assert.equal(gravityFor(0), GRAVITY_TABLE[0], "非法关卡按第 1 关兜底");
  assert.equal(LINES_PER_LEVEL, 10);

  const game = startedGame();
  game.lines = LINES_PER_LEVEL - 1;
  assert.equal(game.level, 1);
  fillRow(game, 19, [4, 5]);
  put(game, "O", 4, 18);
  assert.equal(game.lock(), true);
  assert.equal(game.lines, LINES_PER_LEVEL);
  assert.equal(game.level, 2, "满 10 行应升一关");
  assert.ok(game.gravity() < GRAVITY_TABLE[0]);
  assert.equal(game.hud().gravity, game.gravity(), "HUD 里的间隔与状态机一致");
  assert.equal(game.score, LINE_SCORES[1] * 1, "本局分数用升关前的倍率");
});

test("软降每格 +1 分、硬降每格 +2 分", () => {
  assert.equal(SOFT_DROP_SCORE, 1);
  assert.equal(HARD_DROP_SCORE, 2);
  const game = startedGame();
  put(game, "O", 4, 0);
  assert.equal(game.softDrop(), true);
  assert.equal(game.current.y, 1);
  assert.equal(game.score, SOFT_DROP_SCORE);

  assert.equal(game.hardDrop(), true);
  // 从第 1 行落到第 18 行（占 18、19 行），共 17 格
  assert.equal(game.grid[18][4], "O");
  assert.equal(game.grid[19][5], "O");
  assert.equal(game.score, SOFT_DROP_SCORE + 17 * HARD_DROP_SCORE);

  const flat = startedGame();
  put(flat, "O", 4, 18);
  flat.score = 0;
  assert.equal(flat.hardDrop(), true);
  assert.equal(flat.score, 0, "没有位移就不该白送分");
  assert.equal(flat.grid[19][4], "O");
});

test("暂存：每块只能用一次，锁定后重置", () => {
  const game = startedGame();
  put(game, "T", 4, 0);
  const nextId = game.nextId;
  assert.equal(game.holdPiece(), true);
  assert.equal(game.hold, "T");
  assert.equal(game.holdUsed, true);
  assert.equal(game.current.id, nextId, "暂存槽本来是空的，于是直接换取下一块");
  assert.equal(game.holdPiece(), false, "同一块不允许第二次暂存");

  put(game, "S", 4, 18);
  assert.equal(game.lock(), true);
  assert.equal(game.holdUsed, false, "锁定后重置");
  const justSpawned = game.current.id;
  assert.equal(game.holdPiece(), true);
  assert.equal(game.current.id, "T", "再按一次把暂存的块换回来");
  assert.equal(game.hold, justSpawned, "刚出生的那块被推进了暂存槽");
});

test("出生点被占才判负，堆到第 3 行不算输", () => {
  const game = startedGame();
  game.grid[0][4] = "Z";
  game.nextId = "O";
  assert.equal(game.spawn(), false);
  assert.equal(game.status, "over", "新块无处可放就是终局");
  assert.equal(game.lock(), false, "终局后不再落子");
  assert.equal(game.stats.pieces, 0);

  const high = startedGame();
  for (let row = 3; row < ROWS; row += 1) {
    for (let col = 4; col < COLS; col += 1) high.grid[row][col] = "Z";
  }
  high.nextId = "I";
  assert.equal(high.spawn(), true, "只要顶部还空着就还能继续");
  assert.equal(high.status, "playing");
  assert.equal(high.hud().topRow, 3);
  assert.equal(high.hud().danger, true, "该给出危险提示");
});

test("输入队列：按顺序消费、超出上限丢弃、非游戏中拒收", () => {
  assert.ok(ACTIONS.includes("hard") && ACTIONS.includes("hold"));
  const game = startedGame();
  put(game, "O", 5, 8);
  assert.equal(game.enqueue("dance"), false, "未知动作拒收");
  for (let i = 0; i < QUEUE_LIMIT; i += 1) {
    assert.equal(game.enqueue(i % 2 === 0 ? "left" : "right"), true);
  }
  assert.equal(game.enqueue("left"), false, `队列上限 ${QUEUE_LIMIT} 格`);
  assert.equal(game.queue.length, QUEUE_LIMIT);
  assert.equal(game.flushQueue(), QUEUE_LIMIT);
  assert.equal(game.queue.length, 0);
  assert.equal(game.current.x, 5, "左右各三次应回到原位");

  game.status = "paused";
  assert.equal(game.enqueue("left"), false, "暂停时不吃输入");
  game.status = "playing";
  game.enqueue("left");
  game.enqueue("right");
  game.status = "over";
  assert.equal(game.flushQueue(), 0, "中途判负要丢掉剩余输入");
  assert.equal(game.queue.length, 0);
  assert.equal(game.current.x, 5, "终局后的动作一个都不应用");

  // update 里会自动消费队列，输入不需要装配层手动泵
  const live = startedGame();
  put(live, "O", 5, 8);
  live.enqueue("left");
  live.update(0.01);
  assert.equal(live.current.x, 4);
});

test("锁定保护：重入与终局后都不会二次落子", () => {
  const inner = [];
  const game = new Game({
    rng: makeRng(3),
    onSound: () => {
      // 模拟音效回调里误触发的重复锁定
      if (game.stats.pieces === 1) inner.push(game.lock());
    },
  });
  game.start();
  fillRow(game, 19, [4, 5]);
  put(game, "O", 4, 18);
  game.nextId = "T";
  assert.equal(game.lock(), true);
  assert.deepEqual(inner, [false], "同一轮锁定流程里重入应被拒绝");
  assert.equal(game.stats.pieces, 1);
  assert.equal(game.lines, 1);
  assert.equal(game.score, LINE_SCORES[1]);
  assert.equal(game.current.id, "T", "锁定后投放的是队列里预告的下一块");

  game.status = "over";
  assert.equal(game.lock(), false);
  assert.equal(game.stats.pieces, 1);
});

test("时间推进与帧率无关，且 delta 有上限保护", () => {
  function descend(step) {
    const game = startedGame(5);
    const firstId = game.current.id;
    const y0 = game.current.y;
    const frames = Math.round(1.35 / step);
    for (let i = 0; i < frames; i += 1) game.update(step);
    assert.equal(game.current.id, firstId, "1.35 秒内不该锁上第二块");
    return { moved: game.current.y - y0, elapsed: game.elapsed };
  }
  const smooth = descend(1 / 60);
  const chunky = descend(MAX_DELTA);
  assert.equal(smooth.moved, 1, "第 1 关 0.9 秒一格，1.35 秒应下 1 格");
  assert.equal(chunky.moved, smooth.moved, "同样秒数下 60fps 与 20fps 位移必须一致");

  const game = startedGame(7);
  assert.equal(game.update(10), MAX_DELTA, "切后台回来的一坨时间要夹住");
  assert.equal(game.elapsed, MAX_DELTA);
  assert.equal(game.current.y, -firstFilledRow(game.current.matrix), "夹住后不该直接摔到底");
  assert.equal(game.update(-1), 0, "非法 delta 不产生倒退");
});

test("锁定宽限期：贴底后可滑动重置，但次数有上限", () => {
  assert.equal(LOCK_DELAY, 0.5);
  const game = startedGame();
  put(game, "O", 4, 18);
  assert.equal(game.grounded(), true);
  pump(game, 0.4);
  assert.equal(game.current.id, "O", "宽限期内还没锁");
  assert.ok(Math.abs(game.lockTimer - 0.4) < 1e-9, `累计的宽限时间应为 0.4，实际 ${game.lockTimer}`);

  assert.equal(game.move(-1), true);
  assert.equal(game.lockTimer, 0, "滑动重置了倒计时");
  for (let i = 0; i < MAX_LOCK_RESETS; i += 1) game.move(i % 2 === 0 ? 1 : -1);
  assert.equal(game.lockResets, MAX_LOCK_RESETS, `最多重置 ${MAX_LOCK_RESETS} 次`);

  pump(game, 0.4);
  assert.ok(Math.abs(game.lockTimer - 0.4) < 1e-9, "次数用完后滑动不再清零");
  assert.equal(game.move(1), true);
  assert.ok(Math.abs(game.lockTimer - 0.4) < 1e-9, "宽限次数耗尽后的移动也救不回来了");
  pump(game, 0.1);
  assert.equal(game.stats.pieces, 1, "超出宽限就真正落地");
  assert.equal(game.grid[19][4], "O", "落在最后一次移动后的列位");
});

test("状态机：ready / playing / paused / over 与 HUD 字段", () => {
  const game = newGame();
  assert.equal(game.status, "ready");
  assert.equal(game.current, null);
  assert.ok(game.update(0.1) >= 0, "准备状态下 update 不推进局面");
  game.togglePause();
  assert.equal(game.status, "ready", "准备状态点暂停不该变成游戏中");

  game.start();
  assert.equal(game.status, "playing");
  assert.ok(game.current, "开局应立即投放第一块");
  game.togglePause();
  assert.equal(game.status, "paused");
  const y = game.current.y;
  game.update(0.05);
  assert.equal(game.current.y, y, "暂停时方块不下落");
  game.togglePause();
  assert.equal(game.status, "playing");

  game.status = "over";
  game.enqueue("hard");
  assert.equal(game.flushQueue(), 0);
  const hud = game.hud();
  for (const key of ["score", "best", "level", "lines", "nextId", "holdId", "holdUsed", "gravity"]) {
    assert.ok(key in hud, `HUD 缺少 ${key}`);
  }
  assert.equal(hud.best, Math.max(game.best, game.score));

  game.start();
  assert.equal(game.status, "playing", "终局后按开始等于重开");
  assert.equal(game.score, 0);
  assert.equal(game.lines, 0);
  assert.equal(game.level, 1);
  assert.equal(game.grid.length, ROWS);
  assert.ok(game.grid.every((row) => row.every((cell) => cell === null)), "重开清空网格");
});

test("7 袋随机：一袋内不重复且覆盖七种", () => {
  const bag = createBag(PIECE_KEYS, makeRng(11));
  const first = Array.from({ length: 7 }, () => bag.next());
  assert.equal(new Set(first).size, 7, "同一袋里七种各出现一次");
  const second = Array.from({ length: 7 }, () => bag.next());
  assert.equal(new Set(second).size, 7, "下一袋重新洗牌");

  const game = new Game({ rng: makeRng(13) });
  game.start();
  const seen = new Set([game.current.id, game.nextId]);
  for (let i = 0; i < 20; i += 1) {
    game.hardDrop();
    if (game.status !== "playing") break;
    seen.add(game.current.id);
    seen.add(game.nextId);
  }
  assert.ok(seen.size >= 4, "长时间模拟后应见到多种方块");
});

test("三端度量：行列恒定 10×20，只有格子边长随场地缩放", () => {
  const profiles = [
    { name: "手机竖屏", viewport: { width: 390, height: 844 }, box: { width: 388, height: 598 }, device: "phone" },
    { name: "手机横屏", viewport: { width: 844, height: 390 }, box: { width: 842, height: 250 }, device: "phone" },
    { name: "平板竖屏", viewport: { width: 820, height: 1180 }, box: { width: 816, height: 818 }, device: "tablet" },
    { name: "桌面", viewport: { width: 1440, height: 900 }, box: { width: 1102, height: 818 }, device: "desktop" },
  ];

  for (const p of profiles) {
    const l = computeLayout(p.viewport, p.box);
    const m = metricsFor(l.field, l.device);
    assert.equal(l.device, p.device, p.name);
    assert.equal(Math.round(m.boardWidth / m.cell), COLS, `${p.name} 可见列数必须是 10`);
    assert.equal(Math.round(m.boardHeight / m.cell), ROWS, `${p.name} 可见行数必须是 20`);
    assert.ok(Math.abs(m.cell - Math.min(l.field.width / COLS, l.field.height / ROWS)) < 1e-9, `${p.name} cell 公式`);
    assert.ok(Math.abs(m.cell - cellSize(l.field)) < 1e-9, `${p.name} cellSize 与度量一致`);
    assert.ok(m.originX >= 0 && m.originY >= 0, `${p.name} 棋盘不能画到场地外`);
    assert.ok(m.boardWidth <= l.field.width + 1e-6 && m.boardHeight <= l.field.height + 1e-6);

    const css = canvasBox(l, p.box);
    assert.ok(css.width <= p.box.width + 1, `${p.name} 画布宽度溢出舞台`);
    assert.ok(css.height <= p.box.height + 1, `${p.name} 画布高度溢出舞台`);
    assert.ok(css.width >= 1 && css.height >= 1);
    assert.ok(Math.abs(css.width / css.height - l.aspect) < 0.02, `${p.name} 画布比例失真`);
    // 屏高永远优先给画布：棋盘边长由高度决定，横向余量交给预览面板或留白
    assert.ok(Math.abs(css.height - p.box.height) <= 1, `${p.name} 画布没吃满舞台高度`);
    assert.ok(Math.max(css.width / p.box.width, css.height / p.box.height) > 0.98, `${p.name} 画布没贴满舞台`);
  }

  const phone = computeLayout(profiles[0].viewport, profiles[0].box);
  const phoneWide = computeLayout(profiles[1].viewport, profiles[1].box);
  const desktop = computeLayout(profiles[3].viewport, profiles[3].box);
  assert.ok(phone.metrics.cell > phoneWide.metrics.cell, "手机竖屏格子更大（横屏屏高被挤）");
  assert.equal(desktop.metrics.showPanels, true, "桌面横向余量够，画布上直接给预览面板");
  assert.equal(phone.metrics.showPanels, false, "手机竖屏把预览交给 DOM 侧栏");

  for (const box of [{ width: 320, height: 2000 }, { width: 4000, height: 300 }, { width: 0, height: 0 }]) {
    const f = fieldSize(box);
    assert.ok(Number.isFinite(f.width) && Number.isFinite(f.height));
    const m = metricsFor(f, "phone");
    assert.ok(m.cell > 0 && Number.isFinite(m.cell));
    assert.equal(Math.round(m.boardWidth / m.cell), COLS);
    assert.equal(Math.round(m.boardHeight / m.cell), ROWS);
    // 场地高度取整会让比例有零点几的偏差，这里只校验没有被夹出安全区
    assert.ok(f.width / f.height >= MIN_ASPECT - 0.01 && f.width / f.height <= MAX_ASPECT + 0.01);
  }

  // 重排后当前块不越界
  const game = startedGame();
  put(game, "I", 0, 5, 1);
  applyField({ width: 600, height: 1200 }, "phone");
  game.relayout();
  assert.equal(game.current.x, 0);
  assert.equal(game.collides(game.current.matrix, game.current.x, game.current.y), false);
  applyField({ width: 600, height: 1000 }, "desktop");
});

/**
 * 手机全屏层（src/styles/playfield.css）把控制带压到 169 px，竖屏舞台约 388×675，
 * 横屏控制带换到右侧、舞台约 672×388。钉住：棋盘恒 10×20、画布吃满舞台高度、
 * 竖屏格子边长有地板，且竖屏必须把预览交给 DOM 侧栏（场地留白不够在画布里画面板）。
 */
test("手机全屏：棋盘行列恒定，画布吃满舞台且格子够大", () => {
  const box = { width: 388, height: 675 };
  const up = computeLayout({ width: 390, height: 844 }, box);
  assert.equal(up.device, "phone");
  assert.equal(Math.round(up.metrics.boardWidth / up.metrics.cell), COLS);
  assert.equal(Math.round(up.metrics.boardHeight / up.metrics.cell), ROWS);
  assert.equal(up.metrics.showPanels, false, "竖屏留白不够，预览必须交给 DOM 侧栏");

  const css = canvasBox(up, box);
  assert.ok(css.width <= box.width + 1 && css.height <= box.height + 1, "画布溢出舞台");
  assert.ok(css.height >= box.height - 2, `画布只占 ${css.height} px 高`);
  const cellCss = (css.width * (up.metrics.boardWidth / up.field.width)) / COLS;
  assert.ok(cellCss >= 30, `棋盘格子只有 ${cellCss.toFixed(1)} CSS px`);

  const wide = computeLayout({ width: 844, height: 390 }, { width: 672, height: 388 });
  assert.equal(Math.round(wide.metrics.boardWidth / wide.metrics.cell), COLS, "横屏可见列数也得是 10");
  const wideCss = canvasBox(wide, { width: 672, height: 388 });
  assert.ok(wideCss.width <= 673 && wideCss.height <= 389, "横屏画布溢出舞台");
});
