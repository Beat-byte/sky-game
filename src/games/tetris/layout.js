/**
 * 三端适配的唯一真实来源：把视口与舞台容器尺寸换算成设备档位、逻辑场地与格子度量。
 *
 * 核心约定（本项目适配原则）：**逻辑棋盘恒定 10 列 × 20 行**，只有格子边长随场地缩放
 * （cell = min(场地宽 / 10, 场地高 / 20)）。这样手机、平板、PC 上的可见行列数完全一致，
 * 难度和手感不会因为屏幕大小而改变。
 *
 * 场地长宽比随容器换算（0.5 = 纯棋盘比例，1.35 = 足够宽到能在两侧画预览面板），
 * 因此画布几乎铺满舞台；竖屏拿到瘦高场地，横屏场地变宽、多出的横向空间用来显示下一块与暂存。
 * 注意格子边长始终由「较短的那条边」决定，所以棋盘在横屏上不会因为场地变宽而变小。
 */

import { BREAKPOINTS, deviceClass, orientation } from "../../utils/device.js";

export { BREAKPOINTS, deviceClass, orientation };

export const COLS = 10;
export const ROWS = 20;

/** 逻辑场地基准宽：场地宽恒为它，高度随容器长宽比换算，格子边长因此只由高度决定 */
export const BASE_WIDTH = 600;
export const MIN_ASPECT = 0.5;
/** 场地最宽档：再宽就只是让预览面板越来越空，棋盘边长始终由高度决定 */
export const MAX_ASPECT = 1.35;
export const MIN_HEIGHT = 420;
export const MAX_HEIGHT = 1200;

/** 当前生效的逻辑场地（就地更新，渲染与输入都读同一份） */
export const FIELD = { width: BASE_WIDTH, height: 1000, device: "desktop" };

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/** 格子边长：恒定 10×20 的换算入口，横屏受高度限制、极窄竖屏受宽度限制 */
export function cellSize(field = FIELD) {
  return Math.min(field.width / COLS, field.height / ROWS);
}

/**
 * 逻辑场地：先把容器长宽比夹在 [MIN_ASPECT, MAX_ASPECT]，再由基准宽反推高度。
 * 容器被折叠成 0（首帧、display:none）时按棋盘比例兜底，避免除零产生 NaN。
 */
export function fieldSize(box) {
  const safe = box.width > 0 && box.height > 0 ? box : { width: 1, height: 2 };
  const a = clamp(safe.width / safe.height, MIN_ASPECT, MAX_ASPECT);
  const height = clamp(Math.round(BASE_WIDTH / a), MIN_HEIGHT, MAX_HEIGHT);
  const width = Math.round(clamp(a * height, BASE_WIDTH, BASE_WIDTH));
  return { width, height };
}

/** 度量全部由逻辑场地推出，随档位微调线宽与字号（行列数不随之改变） */
export function metricsFor(field = FIELD, device = FIELD.device) {
  const cell = cellSize(field);
  const boardW = cell * COLS;
  const panel = (field.width - boardW) / 2;
  return {
    device,
    field,
    cell,
    boardWidth: boardW,
    boardHeight: cell * ROWS,
    originX: (field.width - boardW) / 2,
    originY: (field.height - cell * ROWS) / 2,
    /** 单侧留白够宽才在画布里画下一块/暂存面板，否则交给 DOM 侧栏 */
    panelWidth: panel,
    showPanels: device === "desktop" ? panel >= cell * 3.4 : panel >= cell * 3,
    lineWidth: clamp(cell * 0.06, 1, 3),
    gap: clamp(cell * 0.08, 1, 4),
    fontSize: clamp(Math.round(cell * 0.42), 11, 22),
  };
}

/**
 * @param viewport  可视区尺寸（window.innerWidth/Height）
 * @param available 舞台容器可用尺寸（已扣除导航、侧栏与安全区）
 */
export function computeLayout(viewport, available) {
  const device = deviceClass(viewport.width, viewport.height);
  const dir = orientation(viewport.width, viewport.height);
  const box = available.width > 0 && available.height > 0 ? available : { width: 1, height: 2 };
  const field = fieldSize(box);
  return {
    device,
    orientation: dir,
    field,
    aspect: field.width / field.height,
    metrics: metricsFor(field, device),
  };
}

/** 就地更新共享 FIELD，让渲染/输入读到同一份尺寸 */
export function applyField(field, device = FIELD.device) {
  FIELD.width = field.width;
  FIELD.height = field.height;
  FIELD.device = device;
  return FIELD;
}

/** 画布 CSS 盒子：在容器内等比铺满且不溢出，多余空间由场地面板消化 */
export function canvasBox(layout, container) {
  const ratio = layout.field.width / layout.field.height;
  let w = container.width;
  let h = w / ratio;
  if (h > container.height) {
    h = container.height;
    w = h * ratio;
  }
  return { width: Math.round(w), height: Math.round(h) };
}
