/**
 * 贪吃蛇状态机：纯格子坐标，不含任何 DOM / Canvas / 框架依赖。
 *
 * 渲染时才把格子换算成像素，所以旋转屏幕只需 resize() 做一次双射变换，
 * 逻辑长度、自身相交关系、速度档都不会变——这是"三端手感一致"的根据。
 */

import {
  DIRS,
  MAX_TIER,
  SPEEDS,
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
} from "./grid.js";

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const START_LENGTH = 3;

export class Snake {
  constructor({ rng = Math.random, onSound = () => {}, orientation = "portrait" } = {}) {
    this.rng = rng;
    this.onSound = onSound;
    const grid = gridFor(orientation);
    this.cols = grid.cols;
    this.rows = grid.rows;
    this.reset();
  }

  reset() {
    this.status = "ready";
    this.score = 0;
    this.foods = 0;
    this.tier = 0;
    this.elapsed = 0;
    this.acc = 0;
    this.dir = "right";
    this.death = null;
    this.queue = [];
    const y = Math.floor(this.rows / 2);
    const x = Math.floor(this.cols / 2);
    // 蛇身 index 0 是蛇头，向右排开，保证开局不会立刻咬到自己
    this.snake = Array.from({ length: START_LENGTH }, (_, i) => ({ x: x - i, y }));
    this.occupied = new Set(this.snake.map((c) => cellKey(c.x, c.y)));
    this.food = spawnFood(this.occupied, this.cols, this.rows, this.rng);
    return this;
  }

  start() {
    if (this.status === "ready") this.status = "playing";
    return this.status;
  }

  togglePause() {
    if (this.status === "playing") this.status = "paused";
    else if (this.status === "paused") this.status = "playing";
    return this.status;
  }

  /** 输入队列最多存两步，避免快速连按把蛇送进自己身体 */
  enqueue(dir) {
    if (!DIRS[dir] || (this.status !== "playing" && this.status !== "ready")) return false;
    const last = this.queue.length ? this.queue[this.queue.length - 1] : this.dir;
    if (dir === last || isOpposite(dir, last)) return false;
    if (this.queue.length >= 2) return false;
    this.queue.push(dir);
    return true;
  }

  update(deltaSeconds) {
    if (this.status !== "playing") return;
    const dt = Math.min(0.2, Math.max(0, deltaSeconds));
    this.elapsed += dt;
    this.acc += dt;
    while (this.acc >= intervalFor(this.tier)) {
      this.acc -= intervalFor(this.tier);
      this.step();
      if (this.status !== "playing") break;
    }
  }

  step() {
    if (this.queue.length) {
      const next = this.queue.shift();
      if (!isOpposite(next, this.dir)) this.dir = next;
    }
    const delta = DIRS[this.dir];
    const head = { x: this.snake[0].x + delta.x, y: this.snake[0].y + delta.y };

    if (head.x < 0 || head.y < 0 || head.x >= this.cols || head.y >= this.rows) {
      this.die("wall");
      return;
    }

    const eating = Boolean(this.food) && head.x === this.food.x && head.y === this.food.y;
    // 不吃食物时蛇尾会在这一步让位，所以尾巴那一格可以安全进入
    const body = eating ? this.snake : this.snake.slice(0, -1);
    if (body.some((c) => c.x === head.x && c.y === head.y)) {
      this.die("self");
      return;
    }

    this.snake.unshift(head);

    if (eating) {
      this.foods += 1;
      this.score += scoreFor(this.tier);
      const nextTier = tierFor(this.foods);
      if (nextTier > this.tier) {
        this.tier = nextTier;
        this.onSound("level");
      } else {
        this.onSound("eat");
      }
      // 升档后把已积累的时间按比例折算，避免提速瞬间连跳两格
      this.acc = Math.min(this.acc, intervalFor(this.tier));
    } else {
      this.snake.pop();
    }

    this.occupied = new Set(this.snake.map((c) => cellKey(c.x, c.y)));
    if (eating) {
      this.food = spawnFood(this.occupied, this.cols, this.rows, this.rng);
      if (!this.food) {
        this.status = "won";
        this.onSound("win");
      }
    }
  }

  die(reason) {
    this.status = "over";
    this.death = reason;
    this.onSound("over");
  }

  /** 竖屏 13×20 ↔ 横屏 20×13：整条蛇做 90° 旋转，蛇长与相交关系保持不变 */
  resize({ cols, rows }) {
    if (cols === this.cols && rows === this.rows) return this;
    const transposable = cols === this.rows && rows === this.cols;
    if (transposable) {
      const opts = { toLandscape: cols > rows, oldRows: this.rows, oldCols: this.cols };
      this.snake = transposeCells(this.snake, opts);
      this.dir = transposeDir(this.dir, opts);
      this.queue = this.queue.map((dir) => transposeDir(dir, opts));
      if (this.food) this.food = transposePoint(this.food.x, this.food.y, opts);
    }
    this.cols = cols;
    this.rows = rows;
    this.snake = this.snake.map((c) => ({ x: clamp(c.x, 0, cols - 1), y: clamp(c.y, 0, rows - 1) }));
    this.occupied = new Set(this.snake.map((c) => cellKey(c.x, c.y)));
    if (this.food && (this.food.x >= cols || this.food.y >= rows || this.occupied.has(cellKey(this.food.x, this.food.y)))) {
      this.food = spawnFood(this.occupied, cols, rows, this.rng);
    }
    return this;
  }

  hud() {
    return {
      score: this.score,
      length: this.snake.length,
      foods: this.foods,
      tier: this.tier,
      maxTier: MAX_TIER,
      speed: SPEEDS[this.tier],
      seconds: Math.floor(this.elapsed),
    };
  }
}
