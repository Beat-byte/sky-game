/**
 * 画布几何：横向"可见米数"恒定 15 米，三端看到的物理距离完全一样，只有像素大小不同。
 *
 * 为什么这样才叫难度与设备无关（docs/rules/game-module.md 的铁律）：
 * - 物理全在米里跑，ppm（pixels per meter）只影响画多大，不参与任何判定；
 * - 矮窗口（桌面超宽舞台）按 MIN_VIEW_HEIGHT 反算 ppm，宁可多看见几米宽，也不把结构压出画面；
 * - 发射功率用**屏幕行程**归一（pullRef），所以手指在 388 px 手机上拖 40 px 与桌面拖 90 px
 *   是同一档功率 —— 否则小屏必须用更小的位移表达同样功率，等于变相惩罚手机玩家。
 */

import { deviceClass, orientation } from "../../utils/device.js";
import { LEVEL_WIDTH, SLING } from "./levels.js";

export const VIEW_WIDTH = 15; // 米：任何设备横向至少看见这么多
export const MIN_VIEW_HEIGHT = 12; // 米：纵向至少看见这么多（拉满 45° 的抛物线顶点约 11 米）
export const PULL_REF_RATIO = 0.13; // 参考拖拽半径 = 画布短边 × 它
export const GRAB_RADIUS = 2.4; // 手指按下时离锚点多近才算"抓住小鸟"（单位：参考半径的倍数）

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/** 把舞台盒子内接成画布：吃满可用宽高，ppm 由两个下限共同决定 */
export function birdsLayout(viewport, box) {
  const device = deviceClass(viewport.width, viewport.height);
  const dir = orientation(viewport.width, viewport.height);
  const css = {
    width: Math.max(1, Math.floor(box.width)),
    height: Math.max(1, Math.floor(box.height)),
  };
  const ppm = Math.min(css.width / VIEW_WIDTH, css.height / MIN_VIEW_HEIGHT);
  return {
    device,
    orientation: dir,
    css,
    ppm,
    view: { width: css.width / ppm, height: css.height / ppm },
    pullRef: Math.max(28, Math.min(css.width, css.height) * PULL_REF_RATIO),
  };
}

/**
 * 相机：focus 尽量落在视野中部偏下（地面永远在画面里），横向夹在关卡两端内。
 * 视野比关卡还宽时贴左边界；鸟拉高时只整体上移，不改 ppm。
 */
export function cameraFor(layout, focus = { x: SLING.x, y: 0 }) {
  const camX = clamp(focus.x - layout.view.width / 2, 0, Math.max(0, LEVEL_WIDTH - layout.view.width));
  // 地面贴画布底边，除非焦点把抛物线顶抬出视野
  const lift = Math.max(0, focus.y + 1.6 - layout.view.height * 0.62);
  return { x: camX, y: lift };
}

/** 世界坐标（米，y 向上）→ 画布 CSS 像素（y 向下） */
export function worldToScreen(layout, cam, x, y) {
  return {
    x: (x - cam.x) * layout.ppm,
    y: layout.css.height - (y - cam.y) * layout.ppm,
  };
}

/** 画布 CSS 像素 → 世界坐标，供输入层把手指位置换算成拖拽向量 */
export function screenToWorld(layout, cam, px, py) {
  return {
    x: px / layout.ppm + cam.x,
    y: (layout.css.height - py) / layout.ppm + cam.y,
  };
}

/** 背衬像素 = CSS 像素 × DPR（上限 3，避免高分屏内存浪费） */
export function backingSize(css) {
  const dpr = clamp(typeof window === "undefined" ? 1 : window.devicePixelRatio || 1, 1, 3);
  return { width: Math.round(css.width * dpr), height: Math.round(css.height * dpr), dpr };
}

/** 把屏幕拖拽向量换算成 {power, angle}：power 0..1，angle 为发射仰角（弧度） */
export function aimFromPull(layout, dxPx, dyPx) {
  const len = Math.hypot(dxPx, dyPx);
  const power = clamp(len / layout.pullRef, 0, 1);
  // 往左下拖 = 往右上射：世界 vx = -dx，vy = +dy
  const vx = -dxPx;
  const vy = dyPx;
  const angle = Math.atan2(vy, vx);
  return { power, angle, len, vx, vy };
}
