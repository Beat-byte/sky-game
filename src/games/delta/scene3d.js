/**
 * 「危险行动」第一人称的场景规格：把 1×1 格子地图编译成"盒子清单"，纯数据、不 import three。
 *
 * 为什么单独一个文件：three 依赖 WebGL，node --test 里跑不起来；把几何与相机数学抽出来，
 * 就能在 Node 里断言"多少面墙、盒心在哪、视场角随宽高比怎么变"，three-view.js 只负责搬运。
 *
 * 四条纪律（与 renderer.js 同源）：
 * 1. **可见范围与设备无关**。1:1 与宽屏锁水平视场 75°；竖屏反过来夹垂直视场（V_FOV_MAX_DEG），
 *    因为按水平角反算会让手机算出 113° 垂直角，画面边缘拉伸到晕。雾远界固定 28 m，
 *    和俯视的 28×18 m 恒定视口同一量级，不因设备档位改变"能看见几米"。
 * 2. **不许 Math.random**。容器朝向抖动、地板花纹一律由整数格号经 hashJitter 派生。
 * 3. **不改玩法量**。盒子高度只是"眼睛看得见的形状"，碰撞与视线仍旧走 map.js 的网格。
 * 4. **色板只有这一份**。BLOCKS 的 body/cap、地面、灯光雾色、活体三态都写在这里，
 *    ΔE 下限由 test/delta.test.js 卡住；renderer.js 与 three-view.js 只许派生，不许各写一套。
 */

import { WORLD } from "./map.js";

/** 坐标轴约定：2D 的 x(东) → 3D 的 X，2D 的 y(南) → 3D 的 Z，向上是 Y */
export const EYE_M = 1.6;
export const H_FOV_RAD = (75 * Math.PI) / 180;
/**
 * 竖屏的垂直视场上限。纯按水平角反算的话，9:19.5 的手机（aspect≈0.46）会算出 113° 垂直角：
 * 屏幕上下沿严重拉伸，抬头低头像在翻跟头——这是第一人称晕眩最大的来源。
 * 夹住垂直角意味着竖屏让出一点水平视野（换"看得舒服"），1:1 及宽屏仍锁 75° 水平角。
 */
export const V_FOV_MAX_DEG = 80;
/** 雾远界：与俯视恒视口的长边 28 m 对齐，保证两种视图"看得最远"一样 */
export const FOG_FAR_M = 28;
/**
 * 起雾点比例。旧值 0.25（7 m）让中景就开始发灰，玩家分不清"那是墙还是箱子"；
 * 推到 0.5（14 m）——近处清晰、远处糊成亮霾，既有空气透视这个深度线索，又不糊掉可交互物。
 */
export const FOG_NEAR_RATIO = 0.5;
export const WALL_H = 2.8;
/** 转身灵敏度换算用的基准：一次整屏宽拖动 ≈ 300° */
export const LOOK_TAU_PER_WIDTH = 300 / 360;
/** 近裁面：枪模离眼睛只有几十厘米，再小就会吃掉持枪的手 */
export const NEAR_M = 0.06;
/** 远裁面在雾远界之外留一点余量，让雾把远处彻底糊住而不是直接切出黑边 */
export const FAR_PAD_M = 6;

/** 矮容器的顶盖：0.07 m 厚、每边内缩到 86%，眼睛在 1.6 m 俯视得见，盒子立刻有体积 */
export const CAP_M = { thickness: 0.07, inset: 0.86 };
/** 墙体的视线带：贴在眼睛高度、比墙宽 4 cm，所以邻墙相接处也露得出来（墙顶在 2.8 m，看不见） */
export const BAND_M = { thickness: 0.1, width: 1.04, y: 1.5 };

/**
 * 相机构型（纯函数，node 里可断言）。
 * three 的 PerspectiveCamera 构造签名是 (fov, aspect, near, far)——按位置传参曾经把
 * 0.06 当成 aspect、把 34 当成 near，于是整张图都落在近裁面之前，画了但全黑。
 * 这里一次性返回具名四元组，装配层只许整份取用。
 */
export function cameraConfig(aspect) {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  return { fov: fovForAspect(a), aspect: a, near: NEAR_M, far: FOG_FAR_M + FAR_PAD_M };
}

/**
 * 每类格子的盒子尺寸（米）与颜色。上一版 墙 #4a596e / 货架 #4d5375 / 弹药 #516178 是同一个蓝灰族、
 * 明度全挤在 33–44%，再叠上同族的雾色和地面——距离一远整张图就是一堆分不清的灰盒子（玩家原话"很难区分，很容易晕"）。
 * 现在按 CIELAB 挑：七类本体两两 ΔE ≥ 26，顶盖与本体 ΔE ≥ 22，本体对地面 ≥ 27、对雾 ≥ 23
 * （test/delta.test.js 里就是照着这几个下限断言的）。
 * 分工：结构（墙）保持中性低饱和，一切能搜/能躲的容器给饱和色 + 一块亮顶盖。
 * cap = 顶面颜色；俯视看到的正是这块顶面，所以 renderer.js 用它当 fill，两个视图看到的是同一个东西。
 * mark = 第一人称的形状提示位：矮箱子画顶盖（top），高墙画视线高度的横带（band）。
 */
export const BLOCKS = {
  "#": { kind: "wall", size: [1, WALL_H, 1], color: 0x55606f, cap: 0x93a4bd, mark: "band", jitter: 0 },
  x: { kind: "cover", size: [0.92, 0.78, 0.92], color: 0x3f8f4a, cap: 0x7cc98a, mark: "top", jitter: 0.3 },
  c: { kind: "crate", size: [0.86, 1.1, 0.86], color: 0x7a5227, cap: 0xbc8a4c, mark: "top", jitter: 0.22 },
  s: { kind: "shelf", size: [0.96, 1.9, 0.96], color: 0x169fc0, cap: 0x9fe4f7, mark: "top", jitter: 0.12 },
  $: { kind: "safe", size: [0.72, 1.05, 0.72], color: 0xc9a227, cap: 0xf6dd7e, mark: "top", jitter: 0.1 },
  a: { kind: "ammo", size: [0.82, 1.2, 0.82], color: 0x9aa83f, cap: 0xf0ff8c, mark: "top", jitter: 0.2 },
  m: { kind: "med", size: [0.82, 1.2, 0.82], color: 0xdfe6ec, cap: 0xe15a6a, mark: "top", jitter: 0.2 },
};

/** 活体配色：与场景色板彻底错开。红=正在打你、橙=看见你、紫=它不知道你看见了——环境里没有紫东西 */
export const FIGURE_TONE = {
  engage: { body: 0xd1352f, head: 0xffc9c2, legs: 0x7c1f1b },
  alert: { body: 0xe08a2c, head: 0xffe0ad, legs: 0x8a5315 },
  unseen: { body: 0x9b6fd1, head: 0xe8dcfa, legs: 0x5d3f85 },
};

export const EXFIL = { pad: { size: [1, 0.06, 1], color: 0x35a05f }, beacon: { size: [0.16, 3.4, 0.16], color: 0x9ff5ad } };

/**
 * 地面比墙暗一档、棋盘双色拉开到 ΔE≈10：竖直面弹得出来，脚下的网格也给移动提供光流线索
 * （静止的地板花纹晃动是内耳"我在动"的确认，太糊反而更容易晕）。
 * 夜间不能跟着"写实"压到接近全黑：实测整屏 67% 落在 rgb(3,6,15)，玩家分不清远近、也没有参照物，
 * 比白天更容易晕。所以夜间只比白天暗一档，剩下的暗调交给灯光强度。
 */
export const GROUND_COLORS = {
  day: { base: 0x1b2332, alt: 0x2b3648 },
  night: { base: 0x182130, alt: 0x283650 },
};

/**
 * 白天的雾是亮的霾（空气透视）。夜里的雾原来是 0x1a2438——比地面还暗，
 * 等于把"远处"画成一个越看越黑的洞：墙一旦退进雾里就整块消失，深度线索也一起没了。
 * 现在雾比地面亮一档（L*≈17 vs 10），并且半球光/平行光都提到接近白天的量级，
 * 夜靠色偏冷来体现，不靠把整幅画压黑。
 */
export const LIGHTS = {
  day: { hemi: { sky: 0xdfeaf7, ground: 0x202734, intensity: 0.9 }, sun: { color: 0xfff1d2, intensity: 1.35, dir: [-0.55, 1, -0.35] }, fog: 0x8799af },
  night: { hemi: { sky: 0x86a4cc, ground: 0x141c28, intensity: 1.05 }, sun: { color: 0xc3d7f0, intensity: 1.0, dir: [0.4, 0.8, 0.5] }, fog: 0x1e2a3d },
};

/** 2D canvas 要的是 "#rrggbb"：俯视层从这份色板派生，杜绝两边各写一份再各自漂移 */
export function cssHex(value) {
  return `#${(value >>> 0).toString(16).padStart(6, "0").slice(-6)}`;
}

/** 与 renderer.js 里同一个整数哈希：同一格号在两种视图下抖出同一个方向，视觉才对得上 */
function hashJitter(x, y, salt = 0) {
  let h = (x * 73856093) ^ (y * 19349663) ^ (salt * 83492791);
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** NaN 与 ±Infinity 都退回兜底值（`Number(x) || 0` 救不了 Infinity） */
function finite(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 由宽高比反算垂直视场：three 的 PerspectiveCamera.fov 是**垂直**角，
 * 直接给常量会让宽屏看到更多水平内容（= 手机上视野更窄、更难）。
 * 锁住水平角，宽高比只改变垂直方向的取舍；竖屏再把垂直角夹到 V_FOV_MAX_DEG，
 * 因为 100°+ 的垂直角会把屏幕上下沿拉成鱼眼，是晕眩的主要来源。
 */
export function fovForAspect(aspect, hFovRad = H_FOV_RAD) {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const vFov = (2 * Math.atan(Math.tan(hFovRad / 2) / a) * 180) / Math.PI;
  return Math.min(vFov, V_FOV_MAX_DEG);
}

/** 夹取后的实际水平角（反算给测试与文档用；竖屏会比 75° 小） */
export function horizontalFovForAspect(aspect, vFovDeg = fovForAspect(aspect)) {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  return (2 * Math.atan(Math.tan((vFovDeg * Math.PI) / 360) * a) * 180) / Math.PI;
}

/**
 * 2D 朝向角 → three 的相机 yaw（绕 Y）。
 * three 相机默认看向 -Z，绕 Y 转 θ 后方向是 (-sin θ, 0, -cos θ)，
 * 要它等于俯视的 (cos a, 0, sin a) ⇒ θ = atan2(-cos a, -sin a)。
 */
export function yawFor(angle2d) {
  return Math.atan2(-Math.cos(angle2d), -Math.sin(angle2d));
}

/** 每组的实例清单：three-view.js 一组一个 InstancedMesh，地图再大也只有十几次 draw call */
function group(kind, size, color) {
  return { kind, size: [...size], color, items: [] };
}

/**
 * 形状提示层的几何：矮容器给亮顶盖（top，眼睛俯视得到，盒子立刻有体积），
 * 墙给视线高度的横带（band，墙顶在 2.8 m，站着根本看不见）。返回 null 表示这类不画提示层。
 */
function markSpec(spec, w, h, d) {
  if (spec.mark === "band") {
    return { size: [BAND_M.width, BAND_M.thickness, BAND_M.width], color: spec.cap, y: Math.min(BAND_M.y, h - BAND_M.thickness) };
  }
  if (spec.mark === "top") {
    // 顶盖比盒顶高出 1 cm：与顶面共面会 z-fighting，闪成一片比原来的"分不清"更糟
    return { size: [w * CAP_M.inset, CAP_M.thickness, d * CAP_M.inset], color: spec.cap, y: h - CAP_M.thickness / 2 + 0.01 };
  }
  return null;
}

/**
 * 地图 → 静态盒子清单。返回 { bounds, groups, marks, exfils, ground, lights, fog }，
 * bounds 供相机夹取与地板尺寸用，groups 每项是 { kind, size, color, items:[{x,y,z,ry}] }，
 * marks 是同构的装饰层数组，单独拿出来是为了保住"groups 实例数 == 网格实体格数"这条不变量。
 */
export function buildSceneSpec(map) {
  const buckets = new Map();
  const markBuckets = new Map();
  const push = (target, key, size, color, item) => {
    if (!target.has(key)) target.set(key, group(key, size, color));
    target.get(key).items.push(item);
  };

  for (let gy = 0; gy < map.rows; gy += 1) {
    for (let gx = 0; gx < map.cols; gx += 1) {
      const spec = BLOCKS[map.grid[gy][gx]];
      if (!spec) continue;
      const [w, h, d] = spec.size;
      const ry = spec.jitter > 0 ? (hashJitter(gx, gy, 5) * 2 - 1) * spec.jitter : 0;
      push(buckets, spec.kind, spec.size, spec.color, { x: (gx + 0.5) * 1, y: h / 2, z: (gy + 0.5) * 1, ry });
      const mark = markSpec(spec, w, h, d);
      if (mark) push(markBuckets, spec.kind, mark.size, mark.color, { x: gx + 0.5, y: mark.y, z: gy + 0.5, ry });
    }
  }

  const exfils = map.exfils.map((point) => ({
    pad: { x: point.x, y: 0.03, z: point.y },
    beacon: { x: point.x, y: EXFIL.beacon.size[1] / 2, z: point.y },
  }));
  for (const exfil of exfils) {
    push(buckets, "exfil-pad", EXFIL.pad.size, EXFIL.pad.color, { ...exfil.pad, ry: 0 });
    push(buckets, "exfil-beacon", EXFIL.beacon.size, EXFIL.beacon.color, { ...exfil.beacon, ry: 0 });
  }

  const palette = GROUND_COLORS[map.timeSlot === "night" ? "night" : "day"];
  const light = map.timeSlot === "night" ? LIGHTS.night : LIGHTS.day;
  return {
    bounds: { cols: map.cols, rows: map.rows, width: map.width, height: map.height, wallH: WALL_H },
    groups: [...buckets.values()],
    marks: [...markBuckets.values()],
    exfils,
    ground: { cell: 1, base: palette.base, alt: palette.alt },
    lights: light,
    fog: { color: light.fog, near: FOG_FAR_M * FOG_NEAR_RATIO, far: FOG_FAR_M },
    eye: EYE_M,
    spawn: { x: map.spawn.x, z: map.spawn.y },
  };
}

/**
 * 眼睛的高度与侧倾：走路时用格号无关的连续相位做小幅起伏，站立归零。
 * magnitude 是摇杆长度（0..1），phase 是视图传入的秒，两者都不引入随机数。
 * 入参一律先过 finite 清洗：`NaN * 0` 仍是 NaN，一处坏值会让整帧相机矩阵变成 NaN（黑屏且无报错）。
 *
 * 幅度是照着"别让人晕"定的，不是照着真实步伐定的：旧值侧倾 0.022 rad ≈ 1.3°、起伏 ±3 cm，
 * 走动时整屏在滚，配合高视场角就是晕眩套餐。现在的量级只够"感觉在走"，
 * 屏幕不会明显倾斜（上限见 test/delta.test.js 的抗晕那一例）。
 */
export const BOB_M = { eyeY: 0.016, roll: 0.005, bob: 0.01 };
export function eyePose({ angle, magnitude = 0, phase = 0, pitch = 0 } = {}) {
  const speed = Math.max(0, Math.min(1, finite(magnitude, 0)));
  const stride = finite(phase, 0) * 9.2;
  return {
    yaw: yawFor(finite(angle, 0)),
    pitch: finite(pitch, 0),
    eyeY: EYE_M + Math.sin(stride * 2) * BOB_M.eyeY * speed,
    roll: Math.cos(stride) * BOB_M.roll * speed,
    bob: Math.sin(stride) * BOB_M.bob * speed,
    sway: speed,
  };
}

/**
 * 第一人称枪模：全部相对相机原点，尺寸与设备无关（枪口就在视野右下）。
 * 颜色刻意走**暖灰**：环境全是冷蓝灰，枪再是冷蓝灰就会和墙/地面融在一起（旧值 0x2b3038 压在变暗的地面上几乎看不见）。
 */
export const VIEWMODEL = {
  body: { size: [0.09, 0.11, 0.42], pos: [0.17, -0.17, -0.42], color: 0x5a5548 },
  barrel: { size: [0.05, 0.05, 0.34], pos: [0.17, -0.13, -0.72], color: 0x2f2c26 },
  mag: { size: [0.07, 0.16, 0.09], pos: [0.17, -0.28, -0.34], color: 0x6b6555 },
  hands: [
    { size: [0.12, 0.12, 0.14], pos: [0.13, -0.22, -0.3], color: 0x262a31 },
    { size: [0.12, 0.12, 0.14], pos: [0.21, -0.2, -0.52], color: 0x262a31 },
  ],
  muzzle: { radius: 0.11, pos: [0.17, -0.13, -0.9] },
};

/** 敌人/玩家在世界里的手感高度：俯视用一个圆，第一人称要站成一个人 */
export const FIGURE_M = {
  torso: { size: [0.62, 0.72, 0.34], y: 1.02 },
  head: { size: [0.3, 0.3, 0.3], y: 1.55 },
  legs: { size: [0.4, 0.66, 0.26], y: 0.33 },
  radius: WORLD.playerRadius,
};
