/**
 * 「危险行动」的装备与弹道数据表：纯数据 + 查表，没有任何逻辑分支。
 *
 * 所有距离/速度都以米与米每秒计（见 map.js 的单位约定），射速用 rpm、装填用秒，
 * 这样同一个数值在手机上和 PC 上表现一致，不存在"按设备分档调难度"的空间。
 *
 * value 是**唯一**的价格基准：商店买入价与变卖价都从它派生（见 loot.js），
 * 避免出现"买回来比卖掉便宜、可以无限刷钱"这种两张表互相打脸的情况。
 */

export const AMMO = {
  am_9: { label: "9mm 弹", value: 90, mass: 0.012, damageMul: 1, tiers: [1, 2] },
  am_556: { label: "5.56mm 弹", value: 210, mass: 0.016, damageMul: 1.1, tiers: [2, 3] },
  am_762: { label: "7.62mm 弹", value: 260, mass: 0.018, damageMul: 1.2, tiers: [3] },
  am_12: { label: "12 号口径弹", value: 180, mass: 0.045, damageMul: 1, tiers: [1, 2] },
};

export const WEAPONS = {
  wp_pistol: {
    label: "制式手枪", slot: "sidearm", ammo: "am_9", mag: 12, rpm: 420,
    damage: 17, pellets: 1, spreadRad: 0.05, speedMps: 30, rangeM: 22,
    reloadSec: 1.6, value: 5200, mass: 1.1, rarity: 0, sfx: "shot_light",
  },
  wp_smg: {
    label: "微型冲锋枪", slot: "primary", ammo: "am_9", mag: 32, rpm: 880,
    damage: 13, pellets: 1, spreadRad: 0.09, speedMps: 32, rangeM: 20,
    reloadSec: 2.1, value: 9800, mass: 2.8, rarity: 1, sfx: "shot_smg",
  },
  wp_rifle: {
    label: "突击步枪", slot: "primary", ammo: "am_556", mag: 30, rpm: 620,
    damage: 23, pellets: 1, spreadRad: 0.055, speedMps: 42, rangeM: 30,
    reloadSec: 2.3, value: 15600, mass: 3.4, rarity: 2, sfx: "shot_rifle",
  },
  wp_shotgun: {
    label: "泵动霰弹枪", slot: "primary", ammo: "am_12", mag: 6, rpm: 90,
    damage: 12, pellets: 5, spreadRad: 0.24, speedMps: 26, rangeM: 12,
    reloadSec: 2.7, value: 11200, mass: 3.8, rarity: 1, sfx: "shot_shell",
  },
  wp_dmr: {
    label: "精确射手步枪", slot: "primary", ammo: "am_762", mag: 10, rpm: 300,
    damage: 42, pellets: 1, spreadRad: 0.02, speedMps: 52, rangeM: 42,
    reloadSec: 2.9, value: 21000, mass: 4.2, rarity: 3, sfx: "shot_sniper",
  },
};

export const ARMORS = {
  ar_light: { label: "轻型防弹衣", absorb: 0.3, durMax: 45, value: 3000, mass: 2.6, rarity: 1 },
  ar_heavy: { label: "重型防弹衣", absorb: 0.48, durMax: 80, value: 8200, mass: 4.2, rarity: 2 },
};

export const HELMETS = {
  hl_basic: { label: "防弹头盔", absorb: 0.18, durMax: 40, value: 2600, mass: 1.2, rarity: 1 },
};

/** 背包决定搜刮的双约束：格数与载重，二者都会拒收 */
export const BAGS = {
  bg_small: { label: "小型背包", slots: 6, massMax: 10, value: 1200, mass: 0.6, rarity: 0 },
  bg_mid: { label: "中型背包", slots: 10, massMax: 18, value: 3200, mass: 0.9, rarity: 1 },
  bg_large: { label: "大型背包", slots: 14, massMax: 26, value: 6400, mass: 1.3, rarity: 2 },
};

export const MEDS = {
  md_medkit: { label: "医疗包", heal: 35, value: 420, mass: 0.5, rarity: 1 },
};

/** 无装备时的兜底数值：空手进图不该出现 0 伤害或 null 护甲 */
export const DEFAULTS = {
  bagSlots: 3,
  bagMassMax: 6,
  armorAbsorb: 0,
  helmetAbsorb: 0,
  sidearm: "wp_pistol",
};

/** AI 档位：数字与地图上的 1/2/3 字符一一对应 */
export const AI_LOADOUT = {
  1: { weapon: "wp_pistol", hp: 60, speed: 2.1, sightM: 14, accuracyRad: 0.1, fireDelaySec: 0.5, burst: 2, armor: null },
  2: { weapon: "wp_smg", hp: 90, speed: 2.4, sightM: 16, accuracyRad: 0.08, fireDelaySec: 0.4, burst: 3, armor: "ar_light" },
  3: { weapon: "wp_rifle", hp: 130, speed: 2.7, sightM: 19, accuracyRad: 0.05, fireDelaySec: 0.3, burst: 4, armor: "ar_heavy" },
};

export function weaponOf(id) {
  return WEAPONS[id] ?? null;
}

export function ammoOf(id) {
  return AMMO[id] ?? null;
}

export function armorOf(id) {
  return ARMORS[id] ?? HELMETS[id] ?? null;
}

export function bagOf(id) {
  return BAGS[id] ?? null;
}

/** 射速换算成"两发之间的秒数"，主循环只认秒 */
export function shotIntervalSec(weapon) {
  return 60 / Math.max(1, weapon.rpm);
}
