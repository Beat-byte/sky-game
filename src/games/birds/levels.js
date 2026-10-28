/**
 * 关卡数据：全部手写在"米"这套物理单位里，一个字节都不靠随机数。
 *
 * 为什么不用程序生成：结构必须**开局就站得住**（见 test/birds.test.js 的"自稳"一例），
 * 而自稳取决于支撑重叠、质量分布与睡眠判定，随机搭建几乎必然一开局就塌。
 *
 * 坐标约定（这是最容易写错的地方，所以每关都用一个小工厂 + 局部常量）：
 * - `B(x, bottom, w, h, material)` 的 bottom 是**底边**高度，内部换算成中心 y；
 *   要"放在谁上面"就写它的顶高，于是每关先算 `legH + topH`，再往下传。
 * - `P(x, bottom, r)` 同理，猪的 bottom 是脚底。
 * - 关卡世界宽 LEVEL_WIDTH 米，弹弓在左（x≈3）、结构从 x≈14 起；视野宽度由 layout.js 恒定给出，
 *   所以同一关在三端的物理距离完全一样，只有像素大小不同。
 */

import { MATERIALS, PIG } from "./physics.js";

export const LEVEL_WIDTH = 30; // 米
export const LEVEL_CEIL = 14; // 米：结构最高点到天顶的距离，相机与轨迹预演按它兜底
export const SLING = { x: 3, y: 2.15, leg: 1.05 }; // 弹弓锚点（叉兜中心）与叉脚高度
export const STRUCTURE_MIN_X = 13.5; // 结构不许伸进弹弓区

/** 鸟种：半径、质量、颜色与技能。技能一局一发，触发见 game.js */
export const BIRDS = {
  red: { name: "红鸟", r: 0.36, mass: 1.2, color: "#e6483c", belly: "#f7b1a6", ability: null, hint: "没有技能，靠撞击与弹跳" },
  yellow: { name: "黄鸟", r: 0.34, mass: 1.55, color: "#f2c53c", belly: "#fdf0b4", ability: "dash", hint: "空中再点一下：沿当前方向急冲" },
  black: { name: "黑鸟", r: 0.46, mass: 2.6, color: "#3b3f4a", belly: "#8b9099", ability: "bomb", hint: "空中再点一下：原地引爆" },
};

export const ROOF_H = 0.34; // 横梁默认厚度
export const LEG_W = 0.42; // 立柱默认宽度
export const DASH_MULTIPLIER = 1.85; // 黄鸟急冲后的速度倍率
export const BOMB = { radius: 3.8, power: 34 }; // 黑鸟引爆半径（米）与冲量强度

/** 发射速度（米/秒）。射程 = v²·sin2θ/g，拉满 28 m/s、45° 约 35.7 米，够横扫整个关卡 */
export const MAX_LAUNCH_SPEED = 28;
export const MIN_LAUNCH_SPEED = 8.5;
export const MIN_LAUNCH_ANGLE = 0.06; // 弧度：仰角低于它视为没抬起来，不许发射

const B = (x, bottom, w, h, material) => ({ x, y: bottom + h / 2, w, h, material });
const P = (x, bottom, r = PIG.r) => ({ x, y: bottom + r, r });

/** 两条腿 + 一根横梁的"棚"：猪放里面的经典户型。返回方块数组，顶高 = legH + topH */
function shelter({ x, legH, span, leg = "wood", top = "wood", topH = ROOF_H }) {
  return [
    B(x - span / 2 - LEG_W / 2, 0, LEG_W, legH, leg),
    B(x + span / 2 + LEG_W / 2, 0, LEG_W, legH, leg),
    B(x, legH, span + LEG_W * 2 + 0.3, topH, top),
  ];
}

const roofTop = (legH, topH = ROOF_H) => legH + topH;

/** 从 bottom 起依次往上摞，保证层与层严丝合缝 */
function stack(x, bottom, items) {
  let y = bottom;
  const out = [];
  for (const [w, h, material] of items) {
    out.push(B(x, y, w, h, material));
    y += h;
  }
  return out;
}

function barn1() {
  return {
    id: "barn-1",
    name: "第 1 关 · 木棚",
    hint: "拖住小鸟往后下方拉，松手发射。木头一撞就断，先打断一条腿。",
    birds: ["red", "red", "red"],
    blocks: shelter({ x: 18, legH: 1.7, span: 1.3 }),
    pigs: [P(18, 0)],
  };
}

function twin1() {
  const legH = 1.6;
  const top = roofTop(legH);
  return {
    id: "twin-1",
    name: "第 2 关 · 双棚",
    hint: "冰梁一碰就碎。打中间那两条腿，上面那层会自己砸下来。",
    birds: ["red", "red", "yellow"],
    blocks: [
      ...shelter({ x: 16, legH, span: 1.2, top: "glass" }),
      ...shelter({ x: 21.6, legH, span: 1.2, top: "glass" }),
      B(18.8, top, 4.4, ROOF_H, "wood"),
      ...stack(18.8, roofTop(top, ROOF_H), [[1.1, 1.0, "glass"]]),
    ],
    pigs: [P(16, 0), P(21.6, 0)],
  };
}

function tower1() {
  const legH = 2.2;
  const beamTop = roofTop(legH, 0.4);
  const rightH = 1.5;
  return {
    id: "tower-1",
    name: "第 3 关 · 石塔",
    hint: "石头撞不碎但很沉。让黄鸟俯冲把顶上那位砸下去，或者用黑鸟连根拔。",
    birds: ["red", "yellow", "black"],
    blocks: [
      B(17, 0, 0.5, legH, "stone"),
      B(20.4, 0, 0.5, legH, "stone"),
      B(18.7, legH, 4.1, 0.4, "wood"),
      ...stack(18.7, beamTop, [
        [1.1, 1.1, "stone"],
        [1.1, 1.1, "glass"],
      ]),
      B(24.6, 0, LEG_W, rightH, "wood"),
      B(26.4, 0, LEG_W, rightH, "wood"),
      B(25.5, rightH, 2.3, ROOF_H, "wood"),
    ],
    pigs: [P(18.7, 0), P(18.7, roofTop(beamTop, 2.2)), P(25.5, roofTop(rightH))],
  };
}

function ice1() {
  const legH = 1.5;
  const top = roofTop(legH, 0.36);
  const deckTop = roofTop(top, 0.36);
  return {
    id: "ice-1",
    name: "第 4 关 · 冰宫",
    hint: "满场是冰，一碰就裂。中间那箱炸药是礼物 —— 打它就够了。",
    birds: ["red", "black", "yellow"],
    blocks: [
      ...shelter({ x: 16.4, legH, span: 1.1, leg: "glass", top: "glass", topH: 0.36 }),
      B(19.2, 0, 0.7, 0.7, "tnt"),
      ...shelter({ x: 22, legH, span: 1.1, leg: "glass", top: "glass", topH: 0.36 }),
      B(19.2, top, 6.9, 0.36, "wood"),
      ...stack(19.2, roofTop(top, 0.36), [
        [0.9, 0.9, "glass"],
        [0.9, 0.9, "glass"],
      ]),
    ],
    pigs: [P(16.4, 0), P(22, 0), P(26, 0, 0.52)],
  };
}

function keep1() {
  const legH = 1.9;
  const stoneTop = roofTop(legH, 0.4);
  const midTop = roofTop(stoneTop + 0.4 + 1.6, 0.36);
  const smallH = 1.4;
  return {
    id: "keep-1",
    name: "第 5 关 · 三层堡",
    hint: "底层两条石腿决定一切：打断它，上面两层会自己砸进炸药。",
    birds: ["red", "yellow", "black", "red"],
    blocks: [
      ...shelter({ x: 15.6, legH, span: 1.4, leg: "stone", top: "wood", topH: 0.4 }),
      ...shelter({ x: 20.4, legH, span: 1.4, leg: "stone", top: "wood", topH: 0.4 }),
      B(18, stoneTop, 6.2, 0.4, "stone"),
      B(16.4, stoneTop + 0.4, LEG_W, 1.6, "wood"),
      B(19.6, stoneTop + 0.4, LEG_W, 1.6, "wood"),
      B(18, stoneTop + 2.0, 3.9, 0.36, "glass"),
      B(18, midTop, 0.8, 0.8, "tnt"),
      ...shelter({ x: 24.4, legH: smallH, span: 1.0, leg: "wood", top: "glass" }),
    ],
    pigs: [P(18, 0, 0.5), P(22.2, 0), P(18, roofTop(midTop, 0.8)), P(24.4, 0)],
  };
}

function fort1() {
  const wallH = 2.6;
  const upperH = 1.5;
  const stoneTop = roofTop(wallH, 0.42);
  const rightH = 1.7;
  return {
    id: "fort-1",
    name: "第 6 关 · 要塞",
    hint: "石墙 + 双炸药叠在右边。第一发用低角度贴地扫腿，第二发才谈得上拆顶。",
    birds: ["yellow", "black", "red", "black"],
    blocks: [
      B(14.2, 0, 0.6, wallH, "stone"),
      ...stack(16.6, 0, [
        [1.2, 1.2, "stone"],
        [1.2, 1.2, "stone"],
      ]),
      B(19, 0, 0.6, 2.4, "stone"),
      B(17.6, wallH, 5.4, 0.42, "stone"),
      ...shelter({ x: 17.6, legH: upperH, span: 1.2, leg: "wood", top: "glass" }).map((b) =>
        // 把这座小棚整体抬到石梁上：底边从 wallH + 0.42 起
        ({ ...b, y: b.y + stoneTop }),
      ),
      B(23.2, 0, 0.7, 0.7, "tnt"),
      B(23.2, 0.7, 0.7, 0.7, "tnt"),
      ...shelter({ x: 26.6, legH: rightH, span: 1.3, leg: "stone", top: "wood" }),
      B(26.6, roofTop(rightH), 2.6, 0.36, "glass"),
    ],
    pigs: [
      P(15.35, 0),
      P(20.1, 0),
      P(17.6, stoneTop + upperH + ROOF_H, 0.44),
      // 玻璃板顶 = roofTop(rightH) + 0.36，猪站在板子上而不是板子里
      P(26.6, roofTop(rightH) + 0.36, 0.4),
      P(21.6, 0),
    ],
  };
}

export const LEVELS = [barn1(), twin1(), tower1(), ice1(), keep1(), fort1()];

/**
 * 关卡自检：几何不合法会导致开局自塌或猪永远够不着，那种 bug 在页面里几乎看不出来，
 * 所以每次加载关卡都跑一遍，单测也逐关钉住。
 */
export function validateLevel(level) {
  const problems = [];
  if (!level.birds.length) problems.push(`${level.id} 没有鸟`);
  if (!level.pigs.length) problems.push(`${level.id} 没有猪`);
  for (const name of level.birds) if (!BIRDS[name]) problems.push(`${level.id} 用了未知鸟种：${name}`);
  const solids = level.blocks.map((b) => ({ ...b, hw: b.w / 2, hh: b.h / 2 }));
  const circles = level.pigs.map((p) => ({ ...p, hw: p.r, hh: p.r }));
  for (const s of [...solids, ...circles]) {
    if (s.x - s.hw < STRUCTURE_MIN_X) problems.push(`${level.id} 的实体伸进弹弓区：x=${(s.x - s.hw).toFixed(2)}`);
    if (s.x + s.hw > LEVEL_WIDTH - 0.6) problems.push(`${level.id} 的实体出右界：x=${(s.x + s.hw).toFixed(2)}`);
    if (s.y - s.hh < -1e-6) problems.push(`${level.id} 的实体陷进地里：y=${(s.y - s.hh).toFixed(2)}`);
    if (s.y + s.hh > LEVEL_CEIL) problems.push(`${level.id} 的实体高出天顶：y=${(s.y + s.hh).toFixed(2)}`);
    if (s.material && !MATERIALS[s.material]) problems.push(`${level.id} 用了未知材质：${s.material}`);
  }
  // 初始重叠：两个实体相交会让求解器第一帧就把它们互相推开，等于开局自爆
  const all = [...solids, ...circles];
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      const a = all[i];
      const b = all[j];
      const ox = Math.min(a.x + a.hw, b.x + b.hw) - Math.max(a.x - a.hw, b.x - b.hw);
      const oy = Math.min(a.y + a.hh, b.y + b.hh) - Math.max(a.y - a.hh, b.y - b.hh);
      if (ox > 1e-6 && oy > 1e-6) problems.push(`${level.id} 初始重叠：(${a.x},${a.y.toFixed(2)}) 与 (${b.x},${b.y.toFixed(2)})`);
    }
  }
  return problems;
}

export function levelAt(index) {
  return LEVELS[clampIndex(index)];
}

export function clampIndex(index) {
  const i = Math.floor(Number(index) || 0);
  return Math.min(LEVELS.length - 1, Math.max(0, i));
}
