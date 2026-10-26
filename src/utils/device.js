/**
 * 设备分级的唯一真实来源：首页、导航栏和游戏舞台都读同一份判定结果。
 * 用尺寸而不是 UA，折叠屏、分屏、桌面窗口缩小时同样准确。
 */

export const BREAKPOINTS = {
  phoneShortSide: 500,
  tabletLongSide: 1400,
  tabletShortSide: 1000,
};

export const DEVICE_LABEL = {
  phone: "手机端",
  tablet: "平板端",
  desktop: "桌面端",
};

export function deviceClass(width, height) {
  const short = Math.min(width, height);
  const long = Math.max(width, height);
  if (short < BREAKPOINTS.phoneShortSide) return "phone";
  if (long <= BREAKPOINTS.tabletLongSide && short < BREAKPOINTS.tabletShortSide) return "tablet";
  return "desktop";
}

export function orientation(width, height) {
  return height >= width ? "portrait" : "landscape";
}

export function measureViewport() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  return { width, height, device: deviceClass(width, height), orientation: orientation(width, height) };
}
