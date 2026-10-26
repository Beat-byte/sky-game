/**
 * 方块堆叠状态机（纯 ES Module，框架无关：不 import vue、不碰 DOM 与 localStorage）。
 *
 * 局面只有三样东西：恒定的 10×20 网格、当前块、待处理输入队列。
 * 时间推进全部走累加器（秒），与帧率无关；调用方给的 delta 会再夹一次上限，
 * 防止切后台回来一帧扣掉几秒直接把方块摔到底。
 */

import { COLS, FIELD, ROWS, metricsFor } from "./layout.js";
import { PIECES, PIECE_KEYS, createBag, firstFilledRow, filledCells, rotateMatrix } from "./pieces.js";

/** 一次消 1/2/3/4 行的基础分（乘以当前关卡） */
export const LINE_SCORES = [0, 100, 300, 500, 800];
/** 软降每格加分 / 硬降每格加分 */
export const SOFT_DROP_SCORE = 1;
export const HARD_DROP_SCORE = 2;
/** 每累计消这么多行升一关 */
export const LINES_PER_LEVEL = 10;
/** delta 上限（秒）：与装配层一致，避免后台卡顿后一次性跳很多格 */
export const MAX_DELTA = 0.05;
/** 落地后还能滑动/旋转的宽限时间（秒），超时才真正锁定 */
export const LOCK_DELAY = 0.5;
/** 宽限期内最多能重置几次锁定倒计时，防止无限拖延 */
export const MAX_LOCK_RESETS = 8;
/** 消行闪光动画时长（秒） */
export const CLEAR_FLASH = 0.28;
/** 一帧内最多处理的输入数：手感与性能折中，多余的直接丢弃 */
export const QUEUE_LIMIT = 6;

/** 每关的重力间隔（秒/格），严格单调递减；导出给单元测试校验节奏表 */
export const GRAVITY_TABLE = [
  0.9, 0.78, 0.66, 0.56, 0.48, 0.42, 0.36, 0.31, 0.27, 0.23, 0.2, 0.17, 0.15, 0.13, 0.11, 0.1,
];

/** 第 level 关（1 起）的下落间隔，超出表尾按最快档 */
export function gravityFor(level) {
  const index = Math.max(0, Math.floor(Number(level) || 1) - 1);
  return GRAVITY_TABLE[Math.min(index, GRAVITY_TABLE.length - 1)];
}

/** 旋转踢墙尝试顺序：原地 → 左 1 格 → 右 1 格 → 上移 1 格 */
export const KICKS = [
  [0, 0],
  [-1, 0],
  [1, 0],
  [0, -1],
];

export const ACTIONS = ["left", "right", "rotate", "rotateCCW", "soft", "hard", "hold"];

function createGrid() {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(null));
}

export class Game {
  constructor({ rng = Math.random, onSound = () => {} } = {}) {
    this.rng = rng;
    this.onSound = onSound;
    this.reset();
  }

  reset() {
    this.grid = createGrid();
    this.bag = createBag(PIECE_KEYS, this.rng);
    this.status = "ready";
    this.score = 0;
    this.best = 0;
    this.lines = 0;
    this.level = 1;
    this.current = null;
    this.nextId = this.bag.next();
    this.hold = null;
    this.holdUsed = false;
    this.queue = [];
    this.locking = false;
    this.fallTimer = 0;
    this.lockTimer = 0;
    this.lockResets = 0;
    this.clearFlash = 0;
    this.clearRows = [];
    this.elapsed = 0;
    this.stats = { pieces: 0, clears: [0, 0, 0, 0, 0] };
    this.metrics = metricsFor(FIELD, FIELD.device);
  }

  /** 场地/档位变化后只重算度量：行列数恒定，所以局面本身不需要搬运，兜住越界即可 */
  relayout() {
    this.metrics = metricsFor(FIELD, FIELD.device);
    const p = this.current;
    if (!p) return { clamped: 0 };
    let clamped = 0;
    const maxX = COLS - p.matrix.length;
    const nextX = Math.min(maxX, Math.max(0, p.x));
    if (nextX !== p.x) {
      clamped += 1;
      p.x = nextX;
    }
    // 极端情况（历史存档被改坏）下当前块压进了已落定格子，就往上抬到可见区顶部
    if (this.collides(p.matrix, p.x, p.y)) {
      clamped += 1;
      p.y = -firstFilledRow(p.matrix);
    }
    return { clamped };
  }

  start() {
    if (this.status === "over") this.reset();
    if (this.status === "playing") return;
    if (!this.current) this.spawn();
    this.status = "playing";
    this.fallTimer = 0;
  }

  togglePause() {
    if (this.status === "playing") this.status = "paused";
    else if (this.status === "paused") this.status = "playing";
  }

  /** 重力间隔（秒/格） */
  gravity() {
    return gravityFor(this.level);
  }

  /** 格子是否越界或与已落定方块重叠（第 0 行之上不算占用，便于出生对齐） */
  collides(matrix, x, y) {
    for (const cell of filledCells(matrix)) {
      const row = y + cell.row;
      const col = x + cell.col;
      if (col < 0 || col >= COLS || row >= ROWS) return true;
      if (row < 0) continue;
      if (this.grid[row][col]) return true;
    }
    return false;
  }

  /** 把 next 的方块投放到顶部；出生点被占即判负 */
  spawn() {
    const id = this.nextId ?? this.bag.next();
    this.nextId = this.bag.next();
    return this.setCurrent(id);
  }

  setCurrent(id) {
    const matrix = PIECES[id].shape.map((row) => [...row]);
    const x = Math.floor((COLS - matrix.length) / 2);
    const y = -firstFilledRow(matrix);
    this.current = { id, turn: 0, x, y, matrix };
    this.fallTimer = 0;
    this.lockTimer = 0;
    this.lockResets = 0;
    if (this.collides(matrix, x, y)) {
      this.status = "over";
      this.onSound("over");
      return false;
    }
    return true;
  }

  /* ---------------- 动作 ---------------- */

  /**
   * 输入先进队列，再由 update 按顺序消费：
   * 这样一帧里手滑点了两次左 + 一次旋转，落到网格上的顺序与玩家操作顺序一致，
   * 不会因为在事件回调里直接改局面而出现「同一帧被覆盖」的丢键。
   */
  enqueue(action) {
    if (!ACTIONS.includes(action)) return false;
    if (this.status !== "playing") return false;
    if (this.queue.length >= QUEUE_LIMIT) return false;
    this.queue.push(action);
    return true;
  }

  flushQueue() {
    let applied = 0;
    while (this.queue.length > 0) {
      const action = this.queue.shift();
      // 队列中途判负（硬降撞顶）就丢掉剩余输入，避免对着已结束的局面继续动
      if (this.status !== "playing") {
        this.queue.length = 0;
        break;
      }
      if (this.apply(action)) applied += 1;
    }
    return applied;
  }

  apply(action) {
    switch (action) {
      case "left":
        return this.move(-1);
      case "right":
        return this.move(1);
      default:
        return this.applySlow(action);
    }
  }

  applySlow(action) {
    if (action === "rotate") return this.rotate(1);
    if (action === "rotateCCW") return this.rotate(-1);
    if (action === "soft") return this.softDrop();
    if (action === "hard") return this.hardDrop();
    if (action === "hold") return this.holdPiece();
    return false;
  }

  move(dx) {
    const p = this.current;
    if (!p) return false;
    if (this.collides(p.matrix, p.x + dx, p.y)) return false;
    p.x += dx;
    this.nudgeLock();
    this.onSound("move");
    return true;
  }

  /** 简单踢墙：原地失败时依次试左右各 1 格、上移 1 格，全都不行则旋转不生效 */
  rotate(turn) {
    const p = this.current;
    if (!p) return false;
    const nextTurn = (((p.turn + turn) % 4) + 4) % 4;
    const matrix = rotateMatrix(PIECES[p.id].shape, nextTurn);
    for (const [dx, dy] of KICKS) {
      if (this.collides(matrix, p.x + dx, p.y + dy)) continue;
      p.matrix = matrix;
      p.turn = nextTurn;
      p.x += dx;
      p.y += dy;
      this.nudgeLock();
      this.onSound("rotate");
      return true;
    }
    return false;
  }

  /** 下移一格（不计分、不重置重力计时）；返回是否成功 */
  shiftDown() {
    const p = this.current;
    if (!p) return false;
    if (this.collides(p.matrix, p.x, p.y + 1)) return false;
    p.y += 1;
    return true;
  }

  softDrop() {
    const p = this.current;
    if (!p) return false;
    if (!this.shiftDown()) return false;
    this.score += SOFT_DROP_SCORE;
    this.fallTimer = 0;
    return true;
  }

  hardDrop() {
    const p = this.current;
    if (!p) return false;
    let cells = 0;
    while (this.shiftDown()) cells += 1;
    this.score += cells * HARD_DROP_SCORE;
    if (cells > 0) this.onSound("drop");
    // 硬降不受锁定宽限期影响，直接锁死
    this.lockTimer = LOCK_DELAY;
    this.lock();
    return true;
  }

  /** 暂存：每块只能用一次，锁定后才重置 */
  holdPiece() {
    const p = this.current;
    if (!p || this.holdUsed) return false;
    const pending = this.hold;
    this.hold = p.id;
    this.holdUsed = true;
    this.onSound("hold");
    if (pending) this.setCurrent(pending);
    else this.spawn();
    return true;
  }

  grounded() {
    const p = this.current;
    if (!p) return false;
    return this.collides(p.matrix, p.x, p.y + 1);
  }

  /** 已贴底时，滑动或旋转可以重置锁定倒计时，但有次数上限 */
  nudgeLock() {
    if (!this.grounded()) {
      this.lockTimer = 0;
      return;
    }
    if (this.lockResets < MAX_LOCK_RESETS) {
      this.lockTimer = 0;
      this.lockResets += 1;
    }
  }

  /** 幽灵落点（硬降会停在的行），渲染层用来画落点预览 */
  ghostY() {
    const p = this.current;
    if (!p) return 0;
    let y = p.y;
    while (!this.collides(p.matrix, p.x, y + 1)) y += 1;
    return y;
  }

  /** 锁定当前块：写入网格、消行计分、提速、投放下一块。重入或已结束都不会再锁 */
  lock() {
    if (this.locking || this.status !== "playing") return false;
    const p = this.current;
    if (!p) return false;
    this.locking = true;
    try {
      for (const cell of filledCells(p.matrix)) {
        const row = p.y + cell.row;
        const col = p.x + cell.col;
        if (row < 0 || row >= ROWS || col < 0 || col >= COLS) continue;
        this.grid[row][col] = p.id;
      }
      this.current = null;
      this.stats.pieces += 1;

      const cleared = this.clearLines();
      if (cleared > 0) {
        this.score += LINE_SCORES[cleared] * this.level;
        this.lines += cleared;
        this.stats.clears[cleared] += 1;
        const nextLevel = Math.floor(this.lines / LINES_PER_LEVEL) + 1;
        if (nextLevel > this.level) this.level = nextLevel;
        this.onSound(cleared >= 4 ? "perfect" : `clear${cleared}`);
      } else {
        this.onSound("lock");
      }

      this.best = Math.max(this.best, this.score);
      this.holdUsed = false;
      this.spawn();
      return true;
    } finally {
      this.locking = false;
    }
  }

  /** 消掉填满的行，上方整体下移；网格始终保持 20×10 */
  clearLines() {
    const full = [];
    for (let r = 0; r < ROWS; r += 1) {
      if (this.grid[r].every((cell) => cell !== null)) full.push(r);
    }
    this.clearRows = full;
    if (full.length === 0) {
      this.clearFlash = 0;
      return 0;
    }
    this.clearFlash = CLEAR_FLASH;
    // 从小到大逐行删除并在顶部补空行：下方行的下标不受影响，顺序安全
    for (const row of full) {
      this.grid.splice(row, 1);
      this.grid.unshift(Array(COLS).fill(null));
    }
    return full.length;
  }

  /** 最上面的已占用行（用来判断危险与画警告线）；空堆返回 ROWS */
  topRow() {
    for (let r = 0; r < ROWS; r += 1) {
      if (this.grid[r].some((cell) => cell !== null)) return r;
    }
    return ROWS;
  }

  /**
   * @param deltaSeconds 距上一帧的秒数
   * @returns 实际推进的秒数（被夹过的 delta）
   */
  update(deltaSeconds) {
    const dt = Math.min(MAX_DELTA, Math.max(0, Number(deltaSeconds) || 0));
    if (this.clearFlash > 0) this.clearFlash = Math.max(0, this.clearFlash - dt);
    if (this.status !== "playing") return dt;

    this.elapsed += dt;
    this.flushQueue();
    if (this.status !== "playing") return dt;
    if (!this.current) return dt;

    const interval = this.gravity();
    this.fallTimer += dt;
    let guard = 0;
    while (this.fallTimer >= interval && guard < ROWS) {
      guard += 1;
      if (!this.shiftDown()) {
        // 贴底后不再累积重力，倒计时完全交给锁定宽限处理
        this.fallTimer = 0;
        break;
      }
      this.fallTimer -= interval;
    }

    if (this.grounded()) {
      this.lockTimer += dt;
      if (this.lockTimer >= LOCK_DELAY) this.lock();
    } else {
      this.lockTimer = 0;
    }
    return dt;
  }

  hud() {
    return {
      score: this.score,
      best: Math.max(this.best, this.score),
      level: this.level,
      lines: this.lines,
      nextId: this.nextId,
      holdId: this.hold,
      holdUsed: this.holdUsed,
      pieces: this.stats.pieces,
      clears: this.stats.clears.slice(),
      gravity: this.gravity(),
      topRow: this.topRow(),
      danger: this.topRow() <= 3,
    };
  }
}
