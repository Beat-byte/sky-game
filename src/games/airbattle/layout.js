/**
 * 画布几何：场地长宽比恒 9:16（FIELD.w × FIELD.h 单位），三端看到的战场范围完全一样，
 * 只有"每单位多少像素"（unit）不同 —— 这是难度与设备无关的根据。
 *
 * 与弹球的区别写在这里：弹球的逻辑场地随容器长宽比生成、再用 speedScale 拉平穿越时间；
 * 飞机大战因为判定只在场内发生（上下穿越、横向夹取），直接把场尺寸钉死更稳，
 * 于是 unit 只决定画多大，不参与任何判定。
 *
 * metricsFor 只供线宽/字号这类装饰量，任何"手机上画小一点所以更难看见"都不允许进这里。
 */

import { deviceClass, orientation } from "../../utils/device.js";
import { FIELD, clamp } from "./field.js";

export { FIELD };

/** 把 9:16 的场地内接进容器：吃满一边，另一边留居中空白（舞台底色兜住） */
export function fitBoard(box) {
  const safe = box.width > 0 && box.height > 0 ? box : { width: 4, height: 3 };
  const ratio = FIELD.w / FIELD.h;
  let width = safe.width;
  let height = width / ratio;
  if (height > safe.height) {
    height = safe.height;
    width = height * ratio;
  }
  // 至少留 1 px 可见边距，别让机翼贴住舞台边缘
  const scale = Math.min(1, (safe.width - 2) / width, (safe.height - 2) / height);
  return {
    width: Math.max(1, Math.floor(width * clamp(scale, 0, 1))),
    height: Math.max(1, Math.floor(height * clamp(scale, 0, 1))),
  };
}

/** 由视口与舞台盒子算出整套几何 */
export function airbattleLayout(viewport, box) {
  const device = deviceClass(viewport.width, viewport.height);
  const dir = orientation(viewport.width, viewport.height);
  const css = fitBoard(box);
  const unit = css.width / FIELD.w;
  return {
    device,
    orientation: dir,
    css,
    unit,
    view: { width: FIELD.w, height: FIELD.h },
  };
}

/** 单位坐标（y 向下，与逻辑场地同向）→ 画布 CSS 像素 */
export function worldToScreen(layout, x, y) {
  return { x: x * layout.unit, y: y * layout.unit };
}

/** 画布 CSS 像素 → 单位坐标，供输入层把像素增量换算成拖动量 */
export function screenToWorld(layout, px, py) {
  return { x: px / layout.unit, y: py / layout.unit };
}

/** 装饰量：线宽、字号、星星密度。只有渲染层读，不参与判定 */
export function metricsFor(layout, device = layout.device) {
  const unit = layout.unit;
  return {
    device,
    outline: clamp(unit * 0.05, 1, 2.4),
    star: clamp(unit * 0.07, 1, 3),
    glow: clamp(unit * 0.5, 6, 22),
    label: clamp(Math.round(unit * 0.5), 10, 18),
  };
}

/** 背衬像素 = CSS 像素 × DPR（上限 3，避免高分屏内存浪费） */
export function backingSize(css) {
  const dpr = clamp(typeof window === "undefined" ? 1 : window.devicePixelRatio || 1, 1, 3);
  return { width: Math.round(css.width * dpr), height: Math.round(css.height * dpr), dpr };
}
