/**
 * 七种标准方块：用方阵描述，旋转 = 方阵整体顺时针转 90°，因此每种方块天然有 4 个朝向。
 * 颜色取自项目色板（--accent / --accent-2 / --warn / --ok / --danger 一族），
 * 与首页卡片、像素弹球保持同一套观感，不另起色板。
 */

export const PIECE_KEYS = ["I", "O", "T", "S", "Z", "J", "L"];

export const PIECES = {
  I: {
    name: "长条",
    color: "#4ac1ff",
    shape: [
      [0, 0, 0, 0],
      [1, 1, 1, 1],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
  },
  O: {
    name: "方块",
    color: "#fbbf24",
    shape: [
      [1, 1],
      [1, 1],
    ],
  },
  T: {
    name: "凸块",
    color: "#a78bfa",
    shape: [
      [0, 1, 0],
      [1, 1, 1],
      [0, 0, 0],
    ],
  },
  S: {
    name: "蛇形",
    color: "#7ee787",
    shape: [
      [0, 1, 1],
      [1, 1, 0],
      [0, 0, 0],
    ],
  },
  Z: {
    name: "反蛇",
    color: "#ff6b6b",
    shape: [
      [1, 1, 0],
      [0, 1, 1],
      [0, 0, 0],
    ],
  },
  J: {
    name: "钩左",
    color: "#7c5cff",
    shape: [
      [1, 0, 0],
      [1, 1, 1],
      [0, 0, 0],
    ],
  },
  L: {
    name: "钩右",
    color: "#f0b072",
    shape: [
      [0, 0, 1],
      [1, 1, 1],
      [0, 0, 0],
    ],
  },
};

export function pieceColor(key) {
  return PIECES[key]?.color ?? "#93a4bd";
}

/** 顺时针旋转 times 次（times 为负表示逆时针），返回新矩阵，不改动入参 */
export function rotateMatrix(matrix, times = 1) {
  const turns = ((Math.round(times) % 4) + 4) % 4;
  let out = matrix.map((row) => [...row]);
  for (let t = 0; t < turns; t += 1) {
    const n = out.length;
    const next = Array.from({ length: n }, () => Array(n).fill(0));
    for (let r = 0; r < n; r += 1) {
      for (let c = 0; c < n; c += 1) {
        // 顺时针：原来的 (r, c) 落到 (c, n-1-r)
        next[c][n - 1 - r] = out[r][c];
      }
    }
    out = next;
  }
  return out;
}

/** 四种朝向的矩阵数组，供测试逐一比对 */
export function orientations(key) {
  const base = PIECES[key].shape;
  const list = [base.map((row) => [...row])];
  for (let turn = 1; turn < 4; turn += 1) list.push(rotateMatrix(base, turn));
  return list;
}

/** 已占用的格子（相对矩阵的行列下标） */
export function filledCells(matrix) {
  const cells = [];
  for (let r = 0; r < matrix.length; r += 1) {
    for (let c = 0; c < matrix[r].length; c += 1) {
      if (matrix[r][c]) cells.push({ row: r, col: c });
    }
  }
  return cells;
}

/** 裁掉四周空白，预览小格用它，避免 4×4 方阵只显示一条线 */
export function trimMatrix(matrix) {
  let top = matrix.length;
  let bottom = -1;
  let left = matrix.length;
  let right = -1;
  for (let r = 0; r < matrix.length; r += 1) {
    for (let c = 0; c < matrix[r].length; c += 1) {
      if (!matrix[r][c]) continue;
      top = Math.min(top, r);
      bottom = Math.max(bottom, r);
      left = Math.min(left, c);
      right = Math.max(right, c);
    }
  }
  if (bottom < 0) return [[]];
  const rows = [];
  for (let r = top; r <= bottom; r += 1) rows.push(matrix[r].slice(left, right + 1));
  return rows;
}

/** 方块最早出现的行：出生时把它对齐到第 0 行，长条因此不会悬在顶上 */
export function firstFilledRow(matrix) {
  const cells = filledCells(matrix);
  if (cells.length === 0) return 0;
  return Math.min(...cells.map((cell) => cell.row));
}

/**
 * 7 袋随机：把 7 种方块洗乱依次发出，发完再洗一袋。
 * 比纯随机更公平——不会出现「连续 5 个长条」或「死活等不到某块」的挫败手感。
 */
export function createBag(keys = PIECE_KEYS, rng = Math.random) {
  let bag = [];
  const refill = () => {
    bag = [...keys];
    for (let i = bag.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
  };
  return {
    next() {
      if (bag.length === 0) refill();
      return bag.pop();
    },
  };
}
