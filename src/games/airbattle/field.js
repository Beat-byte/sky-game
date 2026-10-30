/**
 * 「飞机大战」的逻辑场地与实体规格：纯数据，不碰 DOM、不碰 Vue、不碰像素。
 *
 * 为什么全都写在"单位"里（docs/rules/game-module.md 的铁律）：
 * 视野恒 9 × 16 单位，三端只改每单位多少像素（layout.unit），判定一个都不改。
 * 速度一律"单位/秒"——敌机从入场飞到出场要几秒，在 390 的手机和 1280 的桌面上完全一样；
 * 火力、血量、掉落同理，都不许出现"手机上更好打/更难打"。
 *
 * 不许 Math.random：所有抖动、lane 偏移、掉落一律由整数序号经 hashJitter 派生，
 * 同一局喂同样的输入必然得到同一个结果，单测才能钉住。
 */

/** 逻辑场地：宽 9、高 16（长宽比 9:16，三端恒定） */
export const FIELD = { w: 9, h: 16 };

export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/**
 * 确定性抖动：把 (整数序号, 盐) 映到 0..1，同一对输入永远同一个值。
 * 取无符号右移保证 JS 的 32 位溢出行为一致，负数入参也稳定。
 */
export function hashJitter(n, salt = 0) {
  let x = (Math.imul(n | 0, 374761393) + Math.imul(salt | 0, 668265263)) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177) | 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x / 4294967296;
}

/** 玩家机：碰撞半径、跟随上限、生命与炸弹 */
export const SHIP = {
  r: 0.55,
  /** 单位/秒：拖动目标点的跟随上限，也是键盘平移速度 */
  speed: 11,
  hpStart: 3,
  hpMax: 5,
  bombsStart: 2,
  bombsMax: 3,
  /** 秒：中弹后的无敌时长（含碰撞与敌弹） */
  invuln: 1.35,
  /** 秒：1 档火力的射击间隔，越高档越短 */
  fireBase: 0.28,
  /** 开局位置：横向居中、纵向偏下 */
  startY: FIELD.h - 2.2,
};

/** 我方子弹 */
export const SHOT = { speed: 24, r: 0.16, dmg: 1 };
/** 敌方子弹 */
export const ENEMY_SHOT = { speed: 6.8, r: 0.2, dmg: 1 };

/**
 * 火力 1..4 档：streams 是相对机身的出场横向偏移与横向速度（弧度无关，直接给单位/秒）。
 * 间隔倍率与伤害写在一起，renderer 与 HUD 都从这里取，不复制数字。
 */
export const WEAPONS = [
  { gap: 1.0, streams: [{ dx: 0, vx: 0 }] },
  { gap: 0.9, streams: [{ dx: -0.34, vx: 0 }, { dx: 0.34, vx: 0 }] },
  { gap: 0.8, streams: [{ dx: 0, vx: 0 }, { dx: -0.46, vx: 0 }, { dx: 0.46, vx: 0 }] },
  {
    gap: 0.7,
    streams: [
      { dx: -0.26, vx: 0 },
      { dx: 0.26, vx: 0 },
      { dx: -0.66, vx: -3.2 },
      { dx: 0.66, vx: 3.2 },
    ],
  },
];
export const MAX_WEAPON = WEAPONS.length;

/**
 * 敌机规格：r 是判定半径（单位），vy 是入场下降速度（单位/秒），
 * stop 非 0 表示飞到该 y 就转横向机动，fire 是射击间隔秒数（0 = 不打）。
 */
export const ENEMIES = {
  scout: { hp: 1, r: 0.5, vy: 3.4, score: 100, drop: 0.07, tint: "#9bd8ff" },
  dart: { hp: 1, r: 0.46, vy: 5.2, score: 140, drop: 0.06, tint: "#ffd166", amp: 2.6 },
  fighter: { hp: 3, r: 0.62, vy: 2.5, score: 220, drop: 0.18, tint: "#a78bfa", fire: 2.2, amp: 1.4 },
  gunner: { hp: 5, r: 0.78, vy: 1.9, stop: 4.6, score: 320, drop: 0.32, tint: "#f0728a", fire: 1.5, amp: 2.4 },
  bomber: { hp: 9, r: 0.9, vy: 1.4, stop: 6.4, score: 520, drop: 0.45, tint: "#f0b072", fire: 2.6, amp: 1.8 },
  boss: { hp: 64, r: 1.7, vy: 1.1, stop: 4.2, score: 4000, drop: 1, tint: "#e6483c", fire: 1.0, amp: 2.2 },
};
export const ENEMY_KINDS = Object.keys(ENEMIES);

/** 坠机对玩家的撞击伤害：撞一次扣 1 血，同时自己也掉 3 点血（撞击不是无代价的） */
export const RAM = { shipDamage: 1, enemyDamage: 3 };

/** 炸弹：全屏伤害 + 清空敌弹 + 短暂无敌 */
export const BOMB = { dmg: 8, invuln: 0.9, flash: 0.5 };

/** 道具：掉落类型与下落速度（单位/秒）、判定半径 */
export const ITEMS = {
  power: { r: 0.55, vy: 2.4, score: 120, tint: "#7dd3fc" },
  repair: { r: 0.55, vy: 2.4, score: 150, tint: "#34d399" },
  bomb: { r: 0.55, vy: 2.4, score: 150, tint: "#f0b072" },
};
export const ITEM_KINDS = Object.keys(ITEMS);

/** 连击：每次击杀 +1，超过 streakHold 秒没有新击杀就清零；每阶 +2% 分数，封顶 20 阶 */
export const COMBO = { hold: 3.2, step: 0.02, max: 20 };

/** 关卡数地板：少于六关就不足以撑起"编成逐关加密"的节奏，单测按这条把编成表钉住 */
export const LEVEL_COUNT_FLOOR = 6;
