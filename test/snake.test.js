import test from "node:test";
import assert from "node:assert/strict";
import { Snake } from "../src/games/snake/game.js";
import {
  DIRS,
  FOODS_PER_TIER,
  MAX_TIER,
  PORTRAIT_GRID,
  SPEEDS,
  TOTAL_CELLS,
  cellKey,
  gridFor,
  intervalFor,
  isOpposite,
  scoreFor,
  spawnFood,
  tierFor,
  transposeCells,
  transposeDir,
  transposePoint,
} from "../src/games/snake/grid.js";
import { backingSize, fitBoard, snakeLayout } from "../src/games/snake/layout.js";

/** rng 固定取 0，食物永远落在第一个空格，便于精确断言 */
const newGame = (orientation = "portrait") => new Snake({ rng: () => 0, orientation });

test("竖屏与横屏的格子总数相同，三端难度一致", () => {
  const portrait = gridFor("portrait");
  const landscape = gridFor("landscape");
  assert.deepEqual(portrait, { cols: 13, rows: 20 });
  assert.deepEqual(landscape, { cols: 20, rows: 13 });
  assert.equal(portrait.cols * portrait.rows, TOTAL_CELLS);
  assert.equal(landscape.cols * landscape.rows, TOTAL_CELLS);
  assert.equal(TOTAL_CELLS, 260);
});

test("速度表严格递增，档位按食物数提升且封顶", () => {
  for (let i = 1; i < SPEEDS.length; i += 1) {
    assert.ok(SPEEDS[i] > SPEEDS[i - 1], `第 ${i} 档应比上一档快`);
    assert.ok(intervalFor(i) < intervalFor(i - 1), "格子间隔应随档位缩短");
  }
  assert.equal(MAX_TIER, SPEEDS.length - 1);
  assert.equal(tierFor(0), 0);
  assert.equal(tierFor(FOODS_PER_TIER - 1), 0);
  assert.equal(tierFor(FOODS_PER_TIER), 1);
  assert.equal(tierFor(9999), MAX_TIER);
  assert.ok(scoreFor(1) > scoreFor(0), "高档位每个食物分值更高");
});

test("开局状态：长度 3、朝右、ready，食物落在空格", () => {
  const game = newGame();
  assert.equal(game.status, "ready");
  assert.equal(game.snake.length, 3);
  assert.deepEqual(game.snake[0], { x: 6, y: 10 });
  assert.equal(game.dir, "right");
  assert.deepEqual(game.food, { x: 0, y: 0 });
  assert.ok(!game.occupied.has(cellKey(game.food.x, game.food.y)), "食物不能出现在蛇身上");
  game.start();
  assert.equal(game.status, "playing");
});

test("撞墙判负并记录死因", () => {
  const game = newGame();
  game.start();
  let steps = 0;
  while (game.status === "playing" && steps < 20) {
    game.step();
    steps += 1;
  }
  assert.equal(game.status, "over");
  assert.equal(game.death, "wall");
  // 13 列、蛇头从 x=6 出发：到 x=12 后再走一步越界
  assert.equal(steps, 7);
});

test("追尾格合法（蛇尾让位），但咬到非尾格判负", () => {
  const shape = [
    { x: 5, y: 5 },
    { x: 4, y: 5 },
    { x: 4, y: 4 },
    { x: 5, y: 4 },
  ];
  const four = newGame();
  four.start();
  four.snake = shape.map((c) => ({ ...c }));
  four.occupied = new Set(four.snake.map((c) => cellKey(c.x, c.y)));
  four.dir = "up";
  four.food = { x: 0, y: 0 };
  four.step();
  assert.equal(four.status, "playing", "蛇尾即将让位，进入该格不算自撞");
  assert.deepEqual(four.snake[0], { x: 5, y: 4 });

  const five = newGame();
  five.start();
  five.snake = [...shape.map((c) => ({ ...c })), { x: 6, y: 4 }];
  five.occupied = new Set(five.snake.map((c) => cellKey(c.x, c.y)));
  five.dir = "up";
  five.food = { x: 0, y: 0 };
  five.step();
  assert.equal(five.status, "over");
  assert.equal(five.death, "self");
});

test("吃食物：变长、加分、提速档，食物重生成且不重叠", () => {
  const game = newGame();
  game.start();
  game.food = { x: 7, y: 10 };
  const before = game.snake.length;
  game.step();
  assert.equal(game.snake.length, before + 1);
  assert.equal(game.score, scoreFor(0));
  assert.equal(game.foods, 1);
  assert.ok(!game.snake.some((c) => c.x === game.food.x && c.y === game.food.y), "新食物不在蛇身上");

  game.foods = FOODS_PER_TIER - 1;
  game.food = { x: game.snake[0].x + 1, y: game.snake[0].y };
  const heard = [];
  game.onSound = (name) => heard.push(name);
  game.step();
  assert.equal(game.tier, 1, "吃满一档后提速");
  assert.deepEqual(heard, ["level"]);
});

test("输入队列：拒绝反向与重复，最多存两步，并按序生效", () => {
  const game = newGame();
  game.start();
  assert.equal(game.enqueue("left"), false, "正在向右时不允许直接掉头");
  assert.equal(game.enqueue("right"), false, "同向无需排队");
  assert.equal(game.enqueue("up"), true);
  assert.equal(game.enqueue("down"), false, "与队列末位反向");
  assert.equal(game.enqueue("up"), false, "重复");
  assert.deepEqual(game.queue, ["up"]);
  assert.equal(game.enqueue("left"), true, "相对队列末位的侧向可以入队");
  assert.equal(game.enqueue("down"), false, "队列已满两步");
  assert.deepEqual(game.queue, ["up", "left"]);

  game.food = null;
  game.step();
  assert.equal(game.dir, "up", "第一步先执行队列头部的 up");
  game.step();
  assert.equal(game.dir, "left", "第二步才轮到 left");
});

test("队列在暂停/结束时不接收输入", () => {
  const game = newGame();
  assert.equal(game.enqueue("up"), true, "ready 状态允许预备方向");
  game.reset();
  game.status = "paused";
  assert.equal(game.enqueue("up"), false);
  game.status = "over";
  assert.equal(game.enqueue("up"), false);
});

test("方向互为反向的判定", () => {
  assert.equal(isOpposite("left", "right"), true);
  assert.equal(isOpposite("up", "down"), true);
  assert.equal(isOpposite("up", "up"), false);
  assert.equal(isOpposite("up", "left"), false);
  assert.equal(isOpposite("up", undefined), false);
  assert.deepEqual(DIRS.down, { x: 0, y: 1 });
});

test("update 用时间累加器，推进次数与帧率无关", () => {
  const interval = intervalFor(0);
  // 单帧时长都压在 delta 上限之下，只比较"同样总时长按不同帧率切片"的结果
  const slowFrames = 26;
  const fastFrames = 4;
  const slow = newGame();
  slow.start();
  const fast = newGame();
  fast.start();
  for (let i = 0; i < slowFrames; i += 1) slow.update((interval * 2.6) / slowFrames);
  for (let i = 0; i < fastFrames; i += 1) fast.update((interval * 2.6) / fastFrames);
  assert.equal(slow.snake[0].x, 6 + 2, "2.6 个间隔只推进两步");
  assert.equal(fast.snake[0].x, 6 + 2, "低帧率与高帧率走到同一格");
  assert.equal(slow.status, "playing");
  assert.equal(fast.status, "playing");
  assert.ok(Math.abs(slow.elapsed - fast.elapsed) < 1e-9, "两个帧率的用时统计一致");

  const capped = newGame();
  capped.start();
  const x = capped.snake[0].x;
  capped.update(9999);
  assert.equal(capped.snake[0].x, x, "超长帧被 delta 上限截断，回后台再回来不会瞬移");
});

test("update 只在 playing 下推进，暂停与结束不动", () => {
  const game = newGame();
  game.update(1);
  assert.equal(game.snake[0].x, 6, "ready 时不动");
  game.start();
  game.step();
  game.togglePause();
  const paused = game.snake[0].x;
  const atPause = game.elapsed;
  game.update(0.1);
  assert.equal(game.snake[0].x, paused);
  assert.equal(game.elapsed, atPause, "暂停期间不计时");
  game.togglePause();
  game.update(intervalFor(0) * 0.6);
  assert.equal(game.snake[0].x, paused, "不足一步的时间不推进");
  game.update(intervalFor(0) * 0.6);
  assert.equal(game.snake[0].x, paused + 1, "恢复后继续走");
  game.die("wall");
  game.update(1);
  assert.equal(game.snake[0].x, paused + 1, "结束后彻底停下");
});

test("resize 做 90° 转置：蛇长、相交关系与方向映射都保持", () => {
  const shape = [
    { x: 5, y: 5 },
    { x: 4, y: 5 },
    { x: 4, y: 4 },
    { x: 5, y: 4 },
    { x: 6, y: 4 },
  ];
  const game = newGame("portrait");
  game.start();
  game.enqueue("up");
  game.snake = shape.map((c) => ({ ...c }));
  game.occupied = new Set(game.snake.map((c) => cellKey(c.x, c.y)));
  game.dir = "up";
  game.food = { x: 0, y: 0 };

  game.resize(gridFor("landscape"));
  assert.deepEqual({ cols: game.cols, rows: game.rows }, { cols: 20, rows: 13 });
  assert.equal(game.snake.length, 5, "转置不改变蛇长");
  assert.deepEqual(
    game.snake.map((c) => ({ ...c })),
    transposeCells(shape, { toLandscape: true, oldRows: 20, oldCols: 13 })
  );
  assert.equal(game.dir, "right", "向上转成横屏后变成向右");
  assert.deepEqual(game.queue, ["right"], "队列里的方向一起转置");
  assert.deepEqual(game.food, { x: 19, y: 0 });
  for (const cell of game.snake) {
    assert.ok(cell.x >= 0 && cell.x < game.cols && cell.y >= 0 && cell.y < game.rows, "全部格子在新网格内");
  }
  assert.equal(game.occupied.size, 5);

  game.resize(gridFor("portrait"));
  assert.deepEqual({ cols: game.cols, rows: game.rows }, { cols: 13, rows: 20 });
  assert.equal(game.dir, "up", "转回去方向也还原");
  assert.deepEqual(game.snake.map((c) => ({ ...c })), shape, "两次转置回到原位");
  assert.deepEqual(game.queue, ["up"]);
  assert.deepEqual(game.food, { x: 0, y: 0 });
});

test("转置工具：整条蛇一一映射、可逆且不产生重复格", () => {
  const cells = [
    { x: 0, y: 0 },
    { x: 12, y: 19 },
    { x: 6, y: 10 },
  ];
  const toLandscape = { toLandscape: true, oldRows: 20, oldCols: 13 };
  const toPortrait = { toLandscape: false, oldRows: 13, oldCols: 20 };
  const once = transposeCells(cells, toLandscape);
  assert.deepEqual(once, [
    { x: 19, y: 0 },
    { x: 0, y: 12 },
    { x: 9, y: 6 },
  ]);
  assert.deepEqual(transposeCells(once, toPortrait), cells, "逆映射还原原位");
  assert.equal(new Set(once.map((c) => cellKey(c.x, c.y))).size, 3);
  assert.equal(transposeDir("up", toLandscape), "right");
  assert.equal(transposeDir("right", toLandscape), "down");
  assert.equal(transposeDir("down", toLandscape), "left");
  assert.equal(transposeDir("left", toLandscape), "up");
  assert.equal(transposeDir("right", toPortrait), "up", "逆变换把方向也转回来");
  assert.equal(transposeDir("up", toPortrait), "left");
});

test("棋盘被占满时判为通关", () => {
  const game = newGame();
  game.cols = 2;
  game.rows = 2;
  game.snake = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
  ];
  game.occupied = new Set(game.snake.map((c) => cellKey(c.x, c.y)));
  game.food = { x: 0, y: 1 };
  game.dir = "down";
  game.step();
  assert.equal(game.status, "won");
  assert.equal(game.snake.length, 4);
});

test("hud 暴露分数、长度、档位与整秒用时", () => {
  const game = newGame();
  game.start();
  game.update(intervalFor(0) * 0.75);
  game.update(intervalFor(0) * 0.75);
  const hud = game.hud();
  assert.deepEqual(Object.keys(hud).sort(), ["foods", "length", "maxTier", "score", "seconds", "speed", "tier"].sort());
  assert.equal(game.snake[0].x, 7, "走了刚好一步");
  assert.equal(hud.length, 3);
  assert.equal(hud.tier, 0);
  assert.equal(hud.maxTier, MAX_TIER);
  assert.equal(hud.speed, SPEEDS[0]);
  assert.equal(hud.seconds, Math.floor(game.elapsed));
  assert.ok(game.elapsed > intervalFor(0), "用时随 update 累加");
});

test("spawnFood 只挑空格，无空格时返回 null", () => {
  const occupied = new Set([cellKey(0, 0), cellKey(1, 0)]);
  assert.deepEqual(spawnFood(occupied, 2, 2, () => 0), { x: 0, y: 1 });
  assert.equal(spawnFood(occupied, 2, 1, () => 0), null, "2×1 棋盘已被占满，没有空位");
  assert.equal(spawnFood(new Set([cellKey(0, 0), cellKey(1, 0), cellKey(0, 1), cellKey(1, 1)]), 2, 2, () => 0), null);
  // rng 给出接近 1 的值也不能越界
  const edge = spawnFood(new Set(), 3, 3, () => 0.999999);
  assert.ok(edge.x === 2 && edge.y === 2, "取到最后一个空格而不是越界");
});

test("画布几何：按网格长宽比内接，永不溢出容器", () => {
  const cases = [
    { width: 388, height: 598 },
    { width: 816, height: 818 },
    { width: 1102, height: 818 },
    { width: 260, height: 150 },
  ];
  for (const box of cases) {
    const grid = box.width > box.height ? gridFor("landscape") : gridFor("portrait");
    const css = fitBoard(box, grid.cols, grid.rows);
    assert.ok(css.width <= box.width && css.height <= box.height, `${box.width}×${box.height} 溢出`);
    assert.ok(css.width > 0 && css.height > 0);
    assert.ok(Math.abs(css.width / css.height - grid.cols / grid.rows) < 0.05, "长宽比失真");
    assert.ok(css.width * css.height > box.width * box.height * 0.6, "填充率过低");
  }
});

test("snakeLayout 与 backingSize：极端容器不产生 NaN", () => {
  const l = snakeLayout({ width: 390, height: 844 }, { width: 0, height: 0 });
  assert.ok(Number.isFinite(l.cell) && l.cell > 0);
  assert.equal(l.grid.cols, 13);
  assert.equal(l.device, "phone");
  assert.equal(l.orientation, "portrait");
  const wide = snakeLayout({ width: 1440, height: 900 }, { width: 900, height: 300 });
  assert.equal(wide.device, "desktop");
  assert.equal(wide.orientation, "landscape");
  assert.equal(wide.grid.cols, 20);
  assert.ok(wide.cell <= wide.css.width / 20 + 1e-9);
  assert.deepEqual(backingSize({ width: 100, height: 50 }), { width: 100, height: 50, dpr: 1 });
});

/**
 * 手机全屏层（src/styles/playfield.css）把统计条、方向盘、按钮排压成 235 px 的控制带，
 * 舞台因此从旧的约 388×470 长到 388×607；横屏控制带改到右侧，舞台是 672×388。
 * 这里钉住两件事：行列数恒定（难度不随之改变）与格子边长有地板（蛇身不许糊成一条线）。
 */
test("手机全屏：格子边长有地板，行列数不随舞台变高而改变", () => {
  const up = snakeLayout({ width: 390, height: 844 }, { width: 388, height: 607 });
  assert.equal(up.device, "phone");
  assert.deepEqual([up.grid.cols, up.grid.rows], [13, 20]);
  assert.ok(up.css.width <= 388 && up.css.height <= 607, "画布溢出舞台");
  assert.ok(up.css.height >= 585, `画布只占 ${up.css.height} px，舞台高度被浪费`);
  assert.ok(up.cell >= 28, `格子只有 ${up.cell.toFixed(1)} CSS px`);

  const side = snakeLayout({ width: 844, height: 390 }, { width: 672, height: 388 });
  assert.deepEqual([side.grid.cols, side.grid.rows], [20, 13], "横屏只互换长边，格子总数仍是 260");
  assert.ok(side.css.width <= 672 && side.css.height <= 388, "横屏画布溢出舞台");
  assert.ok(side.cell >= 28, `横屏格子只有 ${side.cell.toFixed(1)} CSS px`);
  assert.ok(Math.abs(side.cell - up.cell) < 1, "横竖屏格子边长应当接近");
});
