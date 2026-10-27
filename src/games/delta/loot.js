/**
 * 「危险行动」的掉落与背包容量：物品总表 + 稀有度权重 + 容器掉落 + 双约束收纳。
 *
 * 只认数据、不读存档、不碰 DOM —— 所以"这一箱会出什么"可以在 Node 里用一条假 rng 钉死，
 * 也是 test/delta.test.js 里"同一 seed 两次掉落完全一致"那一例的前提。
 *
 * 物品一律 `{ key, qty }`：可堆叠、逐格计数，刻意不做逐件耐久与异形格装箱
 * （那些机制在简化说明里已经列进"砍掉清单"，别在这里悄悄加回来）。
 */

import { AMMO, ARMORS, BAGS, HELMETS, MEDS, WEAPONS } from "./weapons.js";

/** 稀有度：0 白 1 绿 2 蓝 3 紫 4 金 */
export const RARITY_LABEL = ["普通", "优良", "稀有", "史诗", "传说"];
export const RARITY_COLOR = ["#9aa7bd", "#7ee787", "#4ac1ff", "#a78bfa", "#fbbf24"];
/** 一档的基准权重，单调递减；tier 通过 LOOT_TILT 指数倾斜把质量往上推 */
export const RARITY_WEIGHT = [58, 27, 11, 3.2, 0.8];
export const LOOT_TILT = 1.9;

/** 纯战利品：只在掉落表里出现，商店不卖（卖的话"搜"就没有意义了） */
export const GOODS = {
  gd_scrap: { label: "废铁件", rarity: 0, value: 60, mass: 0.4, pool: "goods" },
  gd_bandage: { label: "绷带包", rarity: 0, value: 90, mass: 0.2, pool: "goods" },
  gd_ration: { label: "军用口粮", rarity: 1, value: 180, mass: 0.7, pool: "goods" },
  gd_battery: { label: "储能电池", rarity: 1, value: 260, mass: 0.9, pool: "goods" },
  gd_toolkit: { label: "工具箱", rarity: 1, value: 340, mass: 1.6, pool: "goods" },
  gd_part: { label: "精密零件", rarity: 2, value: 720, mass: 0.8, pool: "goods" },
  gd_drive: { label: "加密硬盘", rarity: 2, value: 950, mass: 0.3, pool: "goods" },
  gd_jewel: { label: "珠宝", rarity: 3, value: 1600, mass: 0.2, pool: "valuables" },
  gd_fpga: { label: "军用芯片", rarity: 3, value: 2100, mass: 0.15, pool: "valuables" },
  gd_goldbar: { label: "金条", rarity: 4, value: 4800, mass: 1.0, pool: "valuables" },
  gd_art: { label: "艺术品", rarity: 4, value: 6400, mass: 0.6, pool: "valuables" },
};

/**
 * 装备类：商店有售、也会从容器里掉，key 与 weapons.js 的表一一对应。
 * pool 必须逐表传准：弹药写成 "ammo"、医疗写成 "med"，
 * 否则 rollLoot 的 goodsFor("ammo") 会拿到空数组，掉落 key 变成 undefined，
 * 表现是"搜了箱子但背包永远是空的"（collect 会静默跳过未知 key）。
 */
function equip(entries, slotKind, pool) {
  const out = {};
  for (const [key, item] of Object.entries(entries)) {
    out[key] = { label: item.label, rarity: item.rarity, value: item.value, mass: item.mass, pool, kind: slotKind };
  }
  return out;
}

export const ITEMS = {
  ...GOODS,
  ...equip(WEAPONS, "weapon", "equipment"),
  ...equip(ARMORS, "armor", "equipment"),
  ...equip(HELMETS, "helmet", "equipment"),
  ...equip(BAGS, "bag", "equipment"),
  ...equip(MEDS, "med", "med"),
  ...equip(AMMO, "ammo", "ammo"),
};

export const ITEM_KEYS = new Set(Object.keys(ITEMS));

export function itemOf(key) {
  return ITEMS[key] ?? null;
}

/** 弹药是"一堆发数"，其余都是一件一重量 */
export function stackQty(key, roll) {
  return ITEMS[key]?.kind === "ammo" ? roll : 1;
}

/** 保险柜高一档、货架高一档是"危险程度决定收益"的唯一实现处 */
export const CONTAINER_TIER_BONUS = { cover: 0, crate: 0, ammo: 0, med: 0, shelf: 1, safe: 2 };

/** 每个容器的件数区间与掉落池权重（池内再按稀有度抽具体件） */
const CONTAINER_ROLLS = {
  cover: { count: [1, 1], pools: [["goods", 74], ["ammo", 26]] },
  crate: { count: [1, 2], pools: [["goods", 58], ["ammo", 24], ["med", 18]] },
  ammo: { count: [1, 2], pools: [["ammo", 78], ["goods", 22]] },
  med: { count: [1, 2], pools: [["med", 82], ["goods", 18]] },
  shelf: { count: [2, 2], pools: [["goods", 64], ["ammo", 20], ["med", 16]] },
  safe: { count: [2, 3], pools: [["valuables", 76], ["equipment", 24]] },
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function effectiveTier(mapTier, containerKind, night = false) {
  const bonus = CONTAINER_TIER_BONUS[containerKind] ?? 0;
  return clamp(Math.round(mapTier) + bonus + (night ? 1 : 0), 1, 5);
}

/** 档位越高越偏向高稀有度：指数倾斜保证期望稀有度随 tier 单调上升（有单测钉住） */
export function rarityWeights(tier) {
  const t = clamp(Math.round(tier), 1, 5);
  const k = Math.pow(LOOT_TILT, t - 1);
  return RARITY_WEIGHT.map((w, r) => w * Math.pow(k, r));
}

export function expectedRarity(tier) {
  const weights = rarityWeights(tier);
  let sum = 0;
  let acc = 0;
  for (let r = 0; r < weights.length; r += 1) {
    sum += weights[r];
    acc += weights[r] * r;
  }
  return acc / sum;
}

function pickWeighted(pairs, rng) {
  let total = 0;
  for (const [, weight] of pairs) total += weight;
  let roll = rng() * total;
  for (const [key, weight] of pairs) {
    roll -= weight;
    if (roll <= 0) return key;
  }
  return pairs[pairs.length - 1][0];
}

function rollRarity(tier, rng) {
  const weights = rarityWeights(tier);
  const pairs = weights.map((w, r) => [r, w]);
  return Number(pickWeighted(pairs, rng));
}

function goodsFor(pool, rarity) {
  const list = [];
  for (const [key, item] of Object.entries(ITEMS)) {
    if (item.pool !== pool) continue;
    if (pool === "equipment" || pool === "ammo" || pool === "med") {
      list.push(key);
      continue;
    }
    if (item.rarity === rarity) list.push(key);
  }
  return list;
}

/**
 * 搜一个容器得到一批物品。rng 是唯一的随机来源（本项目 rng 只有 5 个消耗点，这是其二）。
 * 同 rng 序列 ⇒ 同结果，掉落测试就是这么钉的。
 */
export function rollLoot(containerKind, { mapTier = 1, night = false, rng = Math.random } = {}) {
  const spec = CONTAINER_ROLLS[containerKind] ?? CONTAINER_ROLLS.crate;
  const tier = effectiveTier(mapTier, containerKind, night);
  const [lo, hi] = spec.count;
  const count = lo + (hi > lo ? Math.floor(rng() * (hi - lo + 1)) : 0);
  const items = [];

  const push = (key, qty) => {
    const known = items.find((entry) => entry.key === key);
    if (known) known.qty = Math.min(99, known.qty + qty);
    else items.push({ key, qty });
  };

  for (let i = 0; i < count; i += 1) {
    const pool = pickWeighted(spec.pools, rng);
    if (pool === "equipment") {
      const candidates = goodsFor("equipment", 0);
      push(candidates[Math.floor(rng() * candidates.length) % candidates.length], 1);
      continue;
    }
    if (pool === "ammo") {
      const calibers = goodsFor("ammo", 0);
      const key = calibers[Math.floor(rng() * calibers.length) % calibers.length];
      push(key, 12 * (1 + Math.floor(rng() * 3)));
      continue;
    }
    if (pool === "med") {
      const meds = goodsFor("med", 0);
      push(meds[Math.floor(rng() * meds.length) % meds.length], 1 + Math.floor(rng() * 2));
      continue;
    }
    const rarity = rollRarity(pool === "valuables" ? Math.min(5, tier + 1) : tier, rng);
    const goods = goodsFor(pool, rarity);
    if (goods.length === 0) continue;
    const key = goods[Math.floor(rng() * goods.length) % goods.length];
    const qty = rarity <= 1 ? 1 + Math.floor(rng() * 3) : 1 + Math.floor(rng() * 2);
    push(key, qty);
  }

  return { items, tier };
}

/** 背包/仓库里的现在多重（kg，保留两位避免浮点尾巴在断言里跳） */
export function totalMass(items) {
  let mass = 0;
  for (const entry of items ?? []) mass += (ITEMS[entry.key]?.mass ?? 0) * entry.qty;
  return Math.round(mass * 100) / 100;
}

export function totalValue(items) {
  let value = 0;
  for (const entry of items ?? []) value += (ITEMS[entry.key]?.value ?? 0) * entry.qty;
  return Math.round(value);
}

/**
 * 双约束收纳：格数与载重都得过，返回拒绝原因给 UI 直接显示。
 * 新 key 占一格；已有 key 加数量不占新格，但仍然吃重量。
 */
export function fits({ slots, massMax }, carried, item) {
  const spec = ITEMS[item?.key];
  if (!spec) return { ok: false, reason: "unknown" };
  const qty = Math.max(1, Math.floor(item.qty ?? 1));
  const existing = (carried ?? []).find((entry) => entry.key === item.key);
  const usedSlots = (carried ?? []).length + (existing ? 0 : 1);
  if (usedSlots > slots) return { ok: false, reason: "slots" };
  if (totalMass([...(carried ?? []), { key: item.key, qty }]) > massMax) return { ok: false, reason: "mass" };
  return { ok: true, reason: null };
}

export const BUY_MARKUP = 1.7;
export const SELL_RATIO = 0.6;

/** 买一行的价格：从 value 派生，避免商店与回收价各写一张表 */
export function buyPrice(key, qty = 1) {
  const spec = ITEMS[key];
  if (!spec) return 0;
  return Math.round(spec.value * BUY_MARKUP * qty);
}

export function sellPrice(key, qty = 1) {
  const spec = ITEMS[key];
  if (!spec) return 0;
  return Math.round(spec.value * SELL_RATIO * qty);
}

/** 商店货架：只卖装备类，按档位分组，越贵越靠后 */
export const SHOP_SECTIONS = [
  { id: "primary", label: "主武器", keys: Object.keys(WEAPONS).filter((k) => WEAPONS[k].slot === "primary") },
  { id: "sidearm", label: "副武器", keys: Object.keys(WEAPONS).filter((k) => WEAPONS[k].slot === "sidearm") },
  { id: "ammo", label: "弹药", keys: Object.keys(AMMO) },
  { id: "protection", label: "防护", keys: [...Object.keys(ARMORS), ...Object.keys(HELMETS)] },
  { id: "bag", label: "背包", keys: Object.keys(BAGS) },
  { id: "med", label: "医疗", keys: Object.keys(MEDS) },
];
