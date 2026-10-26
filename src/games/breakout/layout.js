/**
 * 三端适配的唯一真实来源：把视口与舞台容器尺寸换算成设备档位、逻辑场地与各处度量。
 *
 * 关键约定：逻辑场地按容器长宽比生成（高度 420..1200，宽度 800..1600），画布几乎铺满舞台；
 * 小球速度按高度同比放大，所以垂直穿越时间在手机、平板、PC 上保持一致，手感不会忽快忽慢。
 */

import { BREAKPOINTS, deviceClass, orientation } from "../../utils/device.js";

export { BREAKPOINTS, deviceClass, orientation };

export const BASE_WIDTH = 800;
export const MIN_HEIGHT = 420;
export const MAX_HEIGHT = 1200;
export const MAX_WIDTH = 1600;
export const FIELD = { width: BASE_WIDTH, height: 600, hud: 54, device: "desktop" };

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/**
 * 逻辑场地：先由容器长宽比定高度（420..1200），再让宽度同比展开（800..1600），
 * 使画布几乎铺满容器；竖屏拿到瘦高场地，横屏拿到宽扁场地，不再两侧留白。
 */
export function fieldSize(box) {
  // 舞台在首次布局或被折叠成 0 时按 4:3 兜底，避免除零产生 NaN 场地
  const safe = box.width > 0 && box.height > 0 ? box : { width: 4, height: 3 };
  const a = clamp(safe.width / safe.height, 0.55, 3.4);
  const height = clamp(Math.round(BASE_WIDTH / a), MIN_HEIGHT, MAX_HEIGHT);
  const width = Math.round(clamp(a * height, BASE_WIDTH, MAX_WIDTH));
  return { width, height };
}

/**
 * @param viewport  可视区尺寸（window.innerWidth/Height）
 * @param available 舞台容器可用尺寸（已扣除导航、侧栏与安全区）
 */
export function computeLayout(viewport, available) {
  const device = deviceClass(viewport.width, viewport.height);
  const dir = orientation(viewport.width, viewport.height);
  const box = available.width > 0 && available.height > 0 ? available : { width: 4, height: 3 };
  const field = fieldSize(box);
  return { device, orientation: dir, field, aspect: field.width / field.height };
}

/** 度量全部由逻辑场地推出，随档位微调触控目标尺寸 */
export function metricsFor(field, device = FIELD.device) {
  const h = field.height;
  const w = field.width;
  const touch = device !== "desktop";
  return {
    device,
    hud: clamp(Math.round(h * 0.09), 40, 62),
    paddleW: w * (device === "phone" ? 0.19 : touch ? 0.16 : 0.14),
    paddleH: clamp(h * 0.026, 12, 20),
    paddleLift: clamp(h * 0.075, 30, 64),
    ball: clamp(w * (device === "phone" ? 0.019 : 0.015), 12, 17),
    brickHeight: clamp(h * 0.032, 18, 26),
    brickMarginX: 24,
    brickGap: 6,
    brickTop: clamp(Math.round(h * 0.09), 40, 62) + clamp(h * 0.03, 14, 30),
    powerupW: device === "phone" ? 34 : 26,
    powerupH: device === "phone" ? 22 : 18,
    fontSize: clamp(Math.round(h * 0.021), 13, 19),
    // 逻辑高度越大，速度同比放大，垂直穿越时间保持 600/基准速度 不变
    speedScale: h / 600,
  };
}

/** 就地更新共享 FIELD，让物理/关卡/渲染读到同一份尺寸 */
export function applyField(field, device = FIELD.device) {
  FIELD.width = field.width;
  FIELD.height = field.height;
  FIELD.device = device;
  FIELD.hud = metricsFor(FIELD, device).hud;
  return FIELD;
}

/** 画布 CSS 盒子：在容器内等比铺满，避免拉伸变形 */
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
