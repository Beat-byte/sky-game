/**
 * 贪吃蛇的画布几何：逻辑网格恒定（竖屏 13×20 / 横屏 20×13），
 * 只把网格按容器长宽比内接成 CSS 尺寸，再用 devicePixelRatio 放大成背衬像素。
 * 因为网格数固定，三端差异只影响格子多大，不影响难度与手感。
 */

import { deviceClass, orientation } from "../../utils/device.js";
import { gridFor } from "./grid.js";

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/** 把 cols×rows 的网格内接进容器盒子，保证不溢出且尽量铺满 */
export function fitBoard(box, cols, rows) {
  const safe = box.width > 0 && box.height > 0 ? box : { width: 4, height: 3 };
  const ratio = cols / rows;
  let width = safe.width;
  let height = width / ratio;
  if (height > safe.height) {
    height = safe.height;
    width = height * ratio;
  }
  // 至少留出可见边距，别让蛇身贴住舞台边缘
  const scale = Math.min(1, (safe.width - 2) / width, (safe.height - 2) / height);
  return {
    width: Math.max(1, Math.floor(width * clamp(scale, 0, 1))),
    height: Math.max(1, Math.floor(height * clamp(scale, 0, 1))),
  };
}

/** 由视口与舞台盒子算出整套几何：档位、朝向、网格、CSS 尺寸与格子边长 */
export function snakeLayout(viewport, box) {
  const device = deviceClass(viewport.width, viewport.height);
  const dir = orientation(viewport.width, viewport.height);
  const grid = gridFor(dir);
  const css = fitBoard(box, grid.cols, grid.rows);
  return {
    device,
    orientation: dir,
    grid,
    css,
    cell: css.width / grid.cols,
  };
}

/** 背衬像素 = CSS 像素 × DPR（上限 3，避免高分屏内存浪费） */
export function backingSize(css) {
  const dpr = clamp(typeof window === "undefined" ? 1 : window.devicePixelRatio || 1, 1, 3);
  return { width: Math.round(css.width * dpr), height: Math.round(css.height * dpr), dpr };
}
