/**
 * 贪吃蛇的网格常量与纯函数工具。
 *
 * 三端一致的口径：格子总数恒定 260（竖屏 13×20、横屏 20×13，互为转置），
 * 蛇速按"格/秒"计算，所以手机、平板、PC 上的面积、难度、手感完全相同，
 * 旋转屏幕只是把整条蛇做一次性双射变换，不会改变长度与自身相交关系。
 */

export const PORTRAIT_GRID = { cols: 13, rows: 20 };
export const LANDSCAPE_GRID = { cols: 20, rows: 13 };

/** 每档速度（格/秒），随速度档递增 */
export const SPEEDS = [4.2, 5.0, 6.0, 7.2, 8.6, 10.2, 12, 14];

/** 每吃这么多食物升一档 */
export const FOODS_PER_TIER = 4;

/** 每个食物的基础分与档位加成 */
export const SCORE_PER_FOOD = 10;
export const TIER_BONUS = 5;

/** 最高速度档（用于 HUD 显示"N 档"） */
export const MAX_TIER = SPEEDS.length - 1;

export const DIRS = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

export const TOTAL_CELLS = PORTRAIT_GRID.cols * PORTRAIT_GRID.rows;

export function gridFor(orientation) {
  return orientation === "landscape" ? { ...LANDSCAPE_GRID } : { ...PORTRAIT_GRID };
}

export function isOpposite(a, b) {
  if (!a || !b || a === b) return false;
  return DIRS[a].x + DIRS[b].x === 0 && DIRS[a].y + DIRS[b].y === 0;
}

export function cellKey(x, y) {
  return `${x},${y}`;
}

export function tierFor(foods) {
  return Math.min(MAX_TIER, Math.floor(foods / FOODS_PER_TIER));
}

export function intervalFor(tier) {
  return 1 / SPEEDS[Math.min(MAX_TIER, tier)];
}

export function scoreFor(tier) {
  return SCORE_PER_FOOD + tier * TIER_BONUS;
}

/** 在未被蛇占据的格子里随机放食物；没有空位时返回 null（视作棋盘填满） */
export function spawnFood(occupied, cols, rows, rng) {
  const free = [];
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      if (!occupied.has(cellKey(x, y))) free.push({ x, y });
    }
  }
  if (free.length === 0) return null;
  return free[Math.floor(rng() * free.length) % free.length];
}

/**
 * 竖屏 13×20 ↔ 横屏 20×13 的一次性双射（90° 旋转），蛇身连续性、自身相交、与墙的距离关系都保持不变。
 * 两个方向用互逆的映射，所以"转过去再转回来"能精确还原原位：
 *   转成横屏：(x, y) → (旧行数-1-y, x)，方向 (dx, dy) → (-dy, dx)
 *   转回竖屏：(x, y) → (y, 旧列数-1-x)，方向 (dx, dy) → (dy, -dx)
 */
export function transposePoint(x, y, { toLandscape, oldRows, oldCols }) {
  return toLandscape ? { x: oldRows - 1 - y, y: x } : { x: y, y: oldCols - 1 - x };
}

export function transposeCells(cells, opts) {
  return cells.map((cell) => transposePoint(cell.x, cell.y, opts));
}

export function transposeDir(dir, { toLandscape }) {
  if (!dir || !DIRS[dir]) return dir;
  const { x, y } = DIRS[dir];
  const next = toLandscape ? { x: -y, y: x } : { x: y, y: -x };
  for (const [name, delta] of Object.entries(DIRS)) {
    if (delta.x === next.x && delta.y === next.y) return name;
  }
  return dir;
}
