/**
 * 「危险行动」的地图层：逐格手写的字符图 + 编译 + 网格光线投射（DDA）。
 *
 * **单位约定（整个 delta 只在这里写死一次，别处不许再定义第二遍）**
 * 1 世界单位 = 1 米；格子边长 `TILE_M` = 1 米；画布逻辑像素 = 米 × `PX_PER_M`（取自 layout.js）。
 * 一切玩法量（半径、移速、感知、射速、撤离圈）都以米或米/秒定义并住在下面的 `WORLD` 里，三端共用同一份。
 * 这是"可见范围恒定"铁律在连续世界中的落点：逻辑视口恒 28×18 m（layout.js），地图恒为米制网格。
 *
 * **图例**
 * `.` 地面 · `#` 墙体 · `x` 掩体箱 · `c` 木箱 · `s` 货架 · `$` 保险柜 · `a` 弹药箱 · `m` 医疗箱
 * · `E` 撤离点 · `P` 玩家出生点 · `1/2/3` AI 出生点（数字即档位，档位决定武器与血量）
 *
 * 容器与墙体**同时挡移动、挡视线、挡弹**，三个语义共用同一张格子表（`solid` / `sight` 两个 Uint8Array）。
 * 这条约定消掉的是本项目最难查的一类 bug：子弹穿过了"AI 认为挡住视线"的墙，或者反过来。
 *
 * **地图为什么手写而不程序化**：单测要能钉死坐标（"掩体后不开枪""拐角不穿视线"都得给定具体格号）；
 * 撤离点位置、搜索密度梯度、AI 巡逻环本身是关卡设计而不是噪声；程序化还得额外背连通性校验。
 * 两张图在提交前用脚手架跑过四项校验：行长一致、边框封死、撤离点/容器/AI 出生全部与出生点连通、无封闭空腔。
 *
 * **DDA 用 Amanatides & Woo 网格光线投射**，不用固定步长采样：后者在 1 m 墙上会"穿过去"。
 * 线段恰好擦过两格对角公共顶点时，本实现先进 Y 格再进 X 格，两格都判 —— 即"贴角不算看见"，
 * 宁可让 AI 少开一枪，也不能让它隔着墙角杀人。
 */

import { PX_PER_M, VIEW } from "./layout.js";

export { PX_PER_M, VIEW };

/** 一格 1 米：地图数组的下标即米制坐标的整数部分 */
export const TILE_M = 1;

/** 玩法量唯一真实来源：全部以米、米/秒、秒计，与设备档位无关 */
export const WORLD = {
  playerRadius: 0.42,
  playerSpeed: 3.6,
  playerHp: 100,
  aiRadius: 0.42,
  /**
   * 搜刮手长，按"到格子边的距离"量（见 game.js 的 edgeDistance）：
   * 贴边站立 0.42、斜角贴边 0.71 都够得着，隔一格 0.92 就够不着。
   * 若改成按格心量（1.8 那种写法），玩家被实体格挡住时中心距永远 ≥1.92，
   * 容器会变成看得见摸不着——所以这个数必须和 edgeDistance 一起改。
   */
  interactRange: 0.9,
  exfilRadius: 2.5,
  exfilHoldSec: 5,
  /** 自动开火的朝向半角：70° */
  fireConeRad: (70 * Math.PI) / 180,
  /** 枪声惊动半径（米） */
  noiseRadiusM: 18,
  maxAi: 8,
  maxBullets: 64,
  maxParticles: 140,
  maxGroundBags: 16,
};

const TILE_CHARS = ".#xcs$amEP123";

/** 字符 → 语义。solid 挡移动，sight 挡视线与子弹，container/ai/exfil/spawn 是编译期标记 */
export const TILES = {
  ".": { id: "floor", label: "地面" },
  "#": { id: "wall", label: "墙体", solid: true, sight: true },
  "x": { id: "cover", label: "掩体箱", solid: true, sight: true, container: "cover" },
  "c": { id: "crate", label: "木箱", solid: true, sight: true, container: "crate" },
  "s": { id: "shelf", label: "货架", solid: true, sight: true, container: "shelf" },
  "$": { id: "safe", label: "保险柜", solid: true, sight: true, container: "safe" },
  "a": { id: "ammo", label: "弹药箱", solid: true, sight: true, container: "ammo" },
  "m": { id: "med", label: "医疗箱", solid: true, sight: true, container: "med" },
  "E": { id: "exfil", label: "撤离点", exfil: true },
  "P": { id: "spawn", label: "出生点", spawn: true },
  "1": { id: "ai1", label: "AI 一档", ai: 1 },
  "2": { id: "ai2", label: "AI 二档", ai: 2 },
  "3": { id: "ai3", label: "AI 三档", ai: 3 },
};

const TILE_INDEX = new Map([...TILE_CHARS].map((ch, i) => [ch, i]));

/** 搜索耗时（秒）：保险柜最久，这也是它掉落高一档的代价 */
export const CONTAINERS = {
  cover: { label: "掩体箱", searchSec: 1.8 },
  crate: { label: "木箱", searchSec: 2.2 },
  ammo: { label: "弹药箱", searchSec: 2.0 },
  med: { label: "医疗箱", searchSec: 2.0 },
  shelf: { label: "货架", searchSec: 3.0 },
  safe: { label: "保险柜", searchSec: 4.5 },
};

export const MAPS = [
  {
    id: "farm",
    name: "农林区",
    tier: 1,
    lootTier: 1,
    timeSlot: "day",
    /** 夜间只影响感知距离，不引入任何随机天气 */
    sightFactor: 1,
    timeLimitSec: 300,
    desc: "三栋棚屋夹一条田埂，掩体多、通道宽，适合熟悉搜打撤节奏。",
    grid: [
      "####################################",
      "#..#######...............########.E#",
      "#..#.....#....#######....#.....a#..#",
      "#..#$..ac#....#....c#....#$..2..#..#",
      "#..#.....#....#..1..#.....sss..m#..#",
      "#..###.###....#.....#....#....3.#..#",
      "#.............#x....#....###.####..#",
      "#.............###.###..............#",
      "#..................................#",
      "#.....x...............x.......x....#",
      "#...........x......c...............#",
      "#E................................x#",
      "#.......c.......x.......c..........#",
      "#.........x...............x......1.#",
      "#...................1..............#",
      "#...............x..................#",
      "#...####.###..........####.####....#",
      "#...#s...x.#......c...#$.....s#....#",
      "#...#..ac..#..........#..2.x..#....#",
      "#...#s.....#..........#m.....s#....#",
      "#...###.####..........#####.###....#",
      "#.P................................#",
      "#...........x.c.....x............3E#",
      "####################################",
    ],
  },
  {
    id: "port",
    name: "港口仓库",
    tier: 2,
    lootTier: 2,
    timeSlot: "night",
    sightFactor: 0.7,
    timeLimitSec: 360,
    desc: "夜间作业：货架密集、保险柜多，但视野打折且三档 AI 值守吊机与三号库。",
    grid: [
      "########################################",
      "#........................######.....E..#",
      "#..########.#########....#...3....x....#",
      "#..#.sss.........ss.#....#.$..#.....x..#",
      "#..#........$.......#....######........#",
      "#..#.sss.........ss.#...........c....a.#",
      "#..#.1.........2....#.............c....#",
      "#..#.....m....a.....#..................#",
      "#..########.#########..................#",
      "#......................................#",
      "#.....................x................#",
      "#.........x...............x....x.......#",
      "#E.x.c...........#####.................#",
      "#............x.......#.............x...#",
      "#.......x........#.$.#.................#",
      "#................#####..######.######..#",
      "#..c....................#..ss...$...#..#",
      "#..............x........#.2.......s.#..#",
      "#..........................ss.......#..#",
      "#...######..c........c..#.....3...s.#..#",
      "#...#.a..#......c.......#.m....a....#..#",
      "#......1.#..............#...........#..#",
      "#.P.#...m#..............#############..#",
      "#...######...x.........................#",
      "#...................2...1..x..........E#",
      "########################################",
    ],
  },
  // tier3 预留位：等高线更陡、三档 AI 密布的"指挥中心"，等玩法数值调稳再加
];

export function mapById(id) {
  return MAPS.find((item) => item.id === id) ?? null;
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * 字符网格 → 可查询的地图。作者写错一个字（行长不齐、未知字符、没有 P、放不下视口）
 * 就在这里抛错：这些是关卡数据的问题，只会在开发期出现，且必须响亮地出现。
 */
export function compileMap(def) {
  const grid = def.grid;
  const rows = grid.length;
  const cols = grid[0].length;
  const tiles = new Uint8Array(cols * rows);
  const solid = new Uint8Array(cols * rows);
  const sight = new Uint8Array(cols * rows);
  const containers = [];
  const exfils = [];
  const aiSpawns = [];
  let spawn = null;

  for (let gy = 0; gy < rows; gy += 1) {
    const row = grid[gy];
    if (row.length !== cols) {
      throw new Error(`地图 ${def.id} 第 ${gy} 行长 ${row.length}，与首行 ${cols} 不一致`);
    }
    for (let gx = 0; gx < cols; gx += 1) {
      const ch = row[gx];
      const tile = TILES[ch];
      if (!tile) throw new Error(`地图 ${def.id} (${gx},${gy}) 出现图例外的字符 "${ch}"`);
      const i = gy * cols + gx;
      tiles[i] = TILE_INDEX.get(ch);
      if (tile.solid) solid[i] = 1;
      if (tile.sight) sight[i] = 1;
      const center = { x: (gx + 0.5) * TILE_M, y: (gy + 0.5) * TILE_M };
      if (tile.container) {
        containers.push({ ...center, gx, gy, kind: tile.container, searchSec: CONTAINERS[tile.container].searchSec });
      } else if (tile.exfil) {
        exfils.push({ ...center, gx, gy });
      } else if (tile.spawn) {
        if (spawn) throw new Error(`地图 ${def.id} 有第二个 P`);
        spawn = center;
      } else if (tile.ai) {
        aiSpawns.push({ ...center, gx, gy, tier: tile.ai });
      }
    }
  }

  if (!spawn) throw new Error(`地图 ${def.id} 没有 P 出生点`);
  if (exfils.length === 0) throw new Error(`地图 ${def.id} 没有 E 撤离点`);
  if (Math.max(cols, rows) * TILE_M < VIEW.long || Math.min(cols, rows) * TILE_M < VIEW.short) {
    throw new Error(`地图 ${def.id} ${cols}×${rows} m 放不下 ${VIEW.long}×${VIEW.short} m 逻辑视口，相机会露出图外`);
  }

  return {
    id: def.id,
    name: def.name,
    tier: def.tier,
    lootTier: def.lootTier,
    timeSlot: def.timeSlot,
    sightFactor: def.sightFactor,
    timeLimitSec: def.timeLimitSec,
    desc: def.desc,
    cols,
    rows,
    width: cols * TILE_M,
    height: rows * TILE_M,
    grid,
    tiles,
    solid,
    sight,
    containers,
    exfils,
    spawn,
    aiSpawns,
  };
}

/** 格号 → 字符（越界按墙体，和 DDA 的"越界当墙"保持一致） */
export function tileAt(map, gx, gy) {
  if (gx < 0 || gy < 0 || gx >= map.cols || gy >= map.rows) return "#";
  return map.grid[gy][gx];
}

function readTable(table, map, gx, gy) {
  if (gx < 0 || gy < 0 || gx >= map.cols || gy >= map.rows) return 1;
  return table[gy * map.cols + gx];
}

export function isSolid(map, gx, gy) {
  return readTable(map.solid, map, gx, gy) === 1;
}

export function blocksSight(map, gx, gy) {
  return readTable(map.sight, map, gx, gy) === 1;
}

const MARCH = { sight: "sight", solid: "solid" };
const probe = {};

/**
 * 网格光线投射：把 from→to 这条线段在格子上走一遍。
 * 结果写进 out（默认内部暂存对象，热循环不分配），字段含义：
 * reached 完整走完、blocked 撞上传播阻挡、truncated 超过 maxSteps 被截断、
 * gx/gy 撞到的格号、t 撞点在整段上的比例、x/y 撞点坐标、steps 实际跨了几格。
 * 起点格自身若阻挡也算命中（t=0），用于退化位置的保守判定。
 */
export function marchSegment(map, from, to, { maxSteps = 64, mode = MARCH.sight } = {}, out = probe) {
  const table = mode === MARCH.solid ? map.solid : map.sight;
  const dx = to.x - from.x;
  const dy = to.y - from.y;

  out.reached = false;
  out.blocked = false;
  out.truncated = false;
  out.gx = -1;
  out.gy = -1;
  out.t = 0;
  out.steps = 0;
  out.x = to.x;
  out.y = to.y;

  if (dx === 0 && dy === 0) {
    out.reached = true;
    return out;
  }

  let gx = Math.floor(from.x / TILE_M);
  let gy = Math.floor(from.y / TILE_M);
  if (readTable(table, map, gx, gy) === 1) {
    out.blocked = true;
    out.gx = gx;
    out.gy = gy;
    out.x = from.x;
    out.y = from.y;
    return out;
  }

  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const tDeltaX = stepX === 0 ? Infinity : TILE_M / absX;
  const tDeltaY = stepY === 0 ? Infinity : TILE_M / absY;
  let tMaxX = stepX === 0 ? Infinity : (stepX > 0 ? (gx + 1) * TILE_M - from.x : from.x - gx * TILE_M) / absX;
  let tMaxY = stepY === 0 ? Infinity : (stepY > 0 ? (gy + 1) * TILE_M - from.y : from.y - gy * TILE_M) / absY;

  let steps = 0;
  let t = 0;
  for (;;) {
    steps += 1;
    if (steps > maxSteps) {
      out.truncated = true;
      out.steps = steps - 1;
      out.t = t;
      return out;
    }
    if (tMaxX < tMaxY) {
      if (tMaxX > 1) break;
      t = tMaxX;
      gx += stepX;
      tMaxX += tDeltaX;
    } else {
      if (tMaxY > 1) break;
      t = tMaxY;
      gy += stepY;
      tMaxY += tDeltaY;
    }
    if (readTable(table, map, gx, gy) === 1) {
      out.blocked = true;
      out.gx = gx;
      out.gy = gy;
      out.t = t;
      out.x = from.x + dx * t;
      out.y = from.y + dy * t;
      out.steps = steps;
      return out;
    }
  }

  out.reached = true;
  out.t = 1;
  out.steps = steps;
  return out;
}

/** 两点之间是否看得见（含两端所在格）；被截断时保守地判为看不见 */
export function hasLineSight(map, a, b, maxSteps = 64) {
  marchSegment(map, a, b, { maxSteps, mode: MARCH.sight }, probe);
  return probe.reached && !probe.blocked;
}

/** 圆是否完全没有压到任何实心格：出生点放置与移动碰撞都只认这一个判据 */
export function circleFree(map, x, y, radius) {
  const gx0 = Math.floor((x - radius) / TILE_M);
  const gx1 = Math.floor((x + radius) / TILE_M);
  const gy0 = Math.floor((y - radius) / TILE_M);
  const gy1 = Math.floor((y + radius) / TILE_M);
  const r2 = radius * radius;
  for (let gy = gy0; gy <= gy1; gy += 1) {
    for (let gx = gx0; gx <= gx1; gx += 1) {
      if (readTable(map.solid, map, gx, gy) !== 1) continue;
      const nearestX = clamp(x, gx * TILE_M, (gx + 1) * TILE_M);
      const nearestY = clamp(y, gy * TILE_M, (gy + 1) * TILE_M);
      const ddx = x - nearestX;
      const ddy = y - nearestY;
      if (ddx * ddx + ddy * ddy < r2) return false;
    }
  }
  return true;
}

/**
 * 按轴分离的碰撞推进（先 X 后 Y），写进 out 不分配。
 * 分开两轴是"贴着墙滑行"的来源：整体位移一旦撞墙就全丢，玩家会觉得卡在墙角。
 */
export function moveWithCollision(map, from, dx, dy, radius, out = { x: 0, y: 0 }) {
  let x = from.x;
  let y = from.y;
  if (dx !== 0 && circleFree(map, x + dx, y, radius)) x += dx;
  if (dy !== 0 && circleFree(map, x, y + dy, radius)) y += dy;
  out.x = x;
  out.y = y;
  return out;
}

/**
 * 找最近的掩护格：在 self 周边 maxDist 内扫阻挡格，取"格子背对 threat 的那一侧"作为站位，
 * 要求站位自身放得下圆、且从 threat 看不见它。找不到返回 null（AI 此时应原地开火而不是乱跑）。
 */
export function nearestCover(map, self, threat, { radius = WORLD.aiRadius, maxDist = 9 } = {}, out = null) {
  const scan = Math.ceil(maxDist / TILE_M);
  const gx0 = clamp(Math.floor(self.x / TILE_M) - scan, 0, map.cols - 1);
  const gx1 = clamp(Math.floor(self.x / TILE_M) + scan, 0, map.cols - 1);
  const gy0 = clamp(Math.floor(self.y / TILE_M) - scan, 0, map.rows - 1);
  const gy1 = clamp(Math.floor(self.y / TILE_M) + scan, 0, map.rows - 1);
  const push = TILE_M / 2 + radius + 0.06;
  let best = null;
  let bestDist = Infinity;

  for (let gy = gy0; gy <= gy1; gy += 1) {
    for (let gx = gx0; gx <= gx1; gx += 1) {
      if (readTable(map.sight, map, gx, gy) !== 1) continue;
      const cx = (gx + 0.5) * TILE_M;
      const cy = (gy + 0.5) * TILE_M;
      const ax = cx - threat.x;
      const ay = cy - threat.y;
      const len = Math.hypot(ax, ay);
      if (len < 1e-6) continue;
      const spotX = cx + (ax / len) * push;
      const spotY = cy + (ay / len) * push;
      if (!circleFree(map, spotX, spotY, radius)) continue;
      if (hasLineSight(map, threat, { x: spotX, y: spotY }, 64)) continue;
      const dist = Math.hypot(spotX - self.x, spotY - self.y);
      if (dist > maxDist || dist >= bestDist) continue;
      bestDist = dist;
      best = out ?? { x: 0, y: 0, gx: 0, gy: 0 };
      best.x = spotX;
      best.y = spotY;
      best.gx = gx;
      best.gy = gy;
    }
  }
  return best;
}
