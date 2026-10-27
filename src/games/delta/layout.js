/**
 * 「危险行动」的三端适配层。
 *
 * 铁律落点：本合集要求"难度与可见范围不随设备改变"。格子类游戏（贪吃蛇、方块堆叠）用恒定行列数表达，
 * 弹球因为是连续场地改用 speedScale 保证穿越时间恒定。搜打撤是连续世界，所以这里的口径是
 * **逻辑视口恒定 28×18 米（面积恒 504 m²）**，横竖屏只互换长边——手机能看到的战场和 PC 一样大，
 * 差别只是每一米摊到多少 CSS 像素。
 *
 * 由此产生两条纪律，改这个文件前先读：
 * 1. 一切玩法量（移速、弹速、感知半径、射速、撤离圈）都以**米/米每二次方秒**定义，住在 map.js 的 WORLD 里。
 *    本文件的 metricsFor **只准返回装饰量**（线宽、字号、描边、摇杆半径、小地图边长）。
 *    一旦有人把"每米像素数"或"伤害"塞进 metricsFor，手机和 PC 的难度就分叉了，而且单测抓不住。
 * 2. fieldFor/fieldSize **只读朝向，不读容器尺寸**。这与弹球、方块的 fieldSize(box) 同名反义
 *    （那两个是按容器反推场地），所以这里保留薄封装但把语义写死在注释里。
 *
 * 坐标系：世界用米；画布用"逻辑像素"= 米 × PX_PER_M。CSS 尺寸与 devicePixelRatio 的换算
 * 沿用三款的 canvasBox + setTransform(scale) 方案，本文件不碰 DOM。
 */

import { BREAKPOINTS, deviceClass, orientation } from "../../utils/device.js";

export { BREAKPOINTS, deviceClass, orientation };

/** 1 世界单位 = 1 米；逻辑像素 = 米 × PX_PER_M */
export const PX_PER_M = 24;

/** 逻辑视口（米）：长边 28、短边 18，面积恒 504 —— 这是本文件不许被容器尺寸影响的量 */
export const VIEW = { long: 28, short: 18 };

/** HUD 浮层压在画布顶部时给玩家的重心偏移：只挪相机，绝不缩视野 */
export const HUD_BIAS_M = 2;

/** 当前生效的逻辑场地（就地更新，渲染与输入读同一份），竖屏初始值 */
export const FIELD = {
  width: VIEW.short * PX_PER_M,
  height: VIEW.long * PX_PER_M,
  device: "desktop",
  orientation: "portrait",
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * 朝向 → 逻辑场地。竖屏是"瘦高 18×28 m"，横屏是"扁宽 28×18 m"，面积恒定。
 * 参数故意叫 dir 而不是 box：任何容器尺寸都不该传进来。
 */
export function fieldFor(dir = "portrait") {
  return dir === "landscape"
    ? { width: VIEW.long * PX_PER_M, height: VIEW.short * PX_PER_M }
    : { width: VIEW.short * PX_PER_M, height: VIEW.long * PX_PER_M };
}

/**
 * 与弹球/方块同名以便复用装配代码，语义相反：**忽略 box 的具体大小，只取它的朝向**。
 * 容器 0×0（首帧、display:none）时按竖屏兜底，避免除零产生 NaN。
 */
export function fieldSize(box) {
  const usable = box && box.width > 0 && box.height > 0 ? box : { width: 9, height: 16 };
  return fieldFor(orientation(usable.width, usable.height));
}

export function metersToPixels(meters) {
  return meters * PX_PER_M;
}

export function pixelsToMeters(px) {
  return px / PX_PER_M;
}

/** 当前场地能看到的米数，长边恒 28、短边恒 18 */
export function viewMeters(field = FIELD) {
  return { width: field.width / PX_PER_M, height: field.height / PX_PER_M };
}

/**
 * 装饰度量。device 只用来调整线宽/字号这类可读性，**不得**影响任何以米为单位的东西。
 * 手机每米摊到的 CSS 像素约为桌面的 0.55 倍，所以描边加粗、字号加大 —— 这是"看不清"的唯一合法解法。
 */
export function metricsFor(field = FIELD, device = FIELD.device) {
  const phone = device === "phone";
  const tablet = device === "tablet";
  return {
    device,
    field,
    pxPerM: PX_PER_M,
    viewMeters: viewMeters(field),
    /** 实体描边：小屏加粗，保证 16 px 的人形在手机上仍读得出轮廓 */
    outlineWidth: phone ? 2.4 : tablet ? 2 : 1.8,
    hairline: phone ? 1.4 : 1,
    fontSize: phone ? 15 : 13,
    hudFontSize: phone ? 13 : 12,
    /** 虚拟摇杆半径（逻辑像素），浮动式：以首次按下点为心 */
    padRadius: phone ? 58 : 72,
    padHandleRadius: phone ? 22 : 24,
    /** 摇杆死区与轻点判定属于输入层，这里只给半径，避免两处硬编码 */
    minimapSize: phone ? 72 : tablet ? 96 : 128,
    minimapPadding: phone ? 6 : 10,
    /** 撤离圈/视野扇形的线宽补偿 */
    glowWidth: phone ? 3 : 2.4,
  };
}

/**
 * @param viewport  可视区尺寸（window.innerWidth/Height）——只用来定档位与朝向
 * @param available 舞台容器可用尺寸：**在这里只用来判定朝向**，不参与场地尺寸换算
 */
export function computeLayout(viewport, available) {
  const device = deviceClass(viewport.width, viewport.height);
  const dir = orientation(viewport.width, viewport.height);
  const field = fieldFor(dir);
  return {
    device,
    orientation: dir,
    field,
    aspect: field.width / field.height,
    metrics: metricsFor(field, device),
  };
}

/** 就地更新共享 FIELD，让渲染/输入读到同一份尺寸 */
export function applyField(field, device = FIELD.device, dir = FIELD.orientation) {
  FIELD.width = field.width;
  FIELD.height = field.height;
  FIELD.device = device;
  FIELD.orientation = dir;
  return FIELD;
}

/** 画布 CSS 盒子：在容器内等比内接且不溢出（可见范围由场地决定，与容器大小无关） */
export function canvasBox(layout, container) {
  const ratio = layout.field.width / layout.field.height;
  const box = container.width > 0 && container.height > 0 ? container : { width: ratio, height: 1 };
  let width = box.width;
  let height = width / ratio;
  if (height > box.height) {
    height = box.height;
    width = height * ratio;
  }
  return { width: Math.round(width), height: Math.round(height) };
}

/**
 * 相机：跟随目标（米，通常是人的位置），夹在地图范围内。
 * biasM 把画面沿 Y 推开（HUD 浮层压顶时让人物落在视口中线偏下），只挪相机不改视野。
 * 地图某一轴比视口还窄时改为居中，负偏移由渲染层保证图外不露底色。
 */
export function cameraFor(target, field = FIELD, world, { biasM = 0 } = {}) {
  const viewW = field.width / PX_PER_M;
  const viewH = field.height / PX_PER_M;
  // 某一轴比视口还窄（由 map 的单测拦住不发生）时改为居中：视口尺寸仍然不变
  const axis = (center, span, size) => (span < size ? (span - size) / 2 : clamp(center - size / 2, 0, span - size));
  return {
    x: axis(target.x, world.width, viewW),
    y: axis(target.y + biasM, world.height, viewH),
  };
}

/**
 * 世界坐标（米）→ 画布逻辑像素。camera 与 point 一律以**米**为单位（见 cameraFor），
 * 这里乘 PX_PER_M 是唯一的换算点，渲染层不许再自己乘一遍。
 */
export function worldToScreen(point, camera) {
  return { x: (point.x - camera.x) * PX_PER_M, y: (point.y - camera.y) * PX_PER_M };
}

/** 画布逻辑像素 → 世界坐标（米），轻点交互要用 */
export function screenToWorld(point, camera) {
  return { x: point.x / PX_PER_M + camera.x, y: point.y / PX_PER_M + camera.y };
}

/** 渲染裁剪窗口（含端点的格号区间）：只画视口内那几列，配合游程合并把调用数压到 <150 */
export function visibleWindow(camera, field = FIELD, world) {
  const x0 = clamp(Math.floor(camera.x), 0, world.width - 1);
  const y0 = clamp(Math.floor(camera.y), 0, world.height - 1);
  const x1 = clamp(Math.ceil(camera.x + field.width / PX_PER_M), x0, world.width - 1);
  const y1 = clamp(Math.ceil(camera.y + field.height / PX_PER_M), y0, world.height - 1);
  return { x0, y0, x1, y1 };
}
