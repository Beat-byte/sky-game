/**
 * 六关编成表与生成计划（手写数据，不是随机）。
 *
 * 每关是一串 groups：at 是这一小组的入场秒数（相对该关开始），kind 是敌机类型，
 * count 是架数，gap 是组内间隔秒，lane 决定横向落点分布。
 * planFor(level) 把小组展开成逐架的 {at, kind, x, amp, period, phase}，
 * 其中的抖动全部来自 hashJitter(整数序号, 盐)——同一关永远展开出同一份计划，
 * 单测可以把"第几秒出现几架、从哪个 x 进场"钉成断言。
 */

import { ENEMIES, FIELD, clamp, hashJitter } from "./field.js";

/** lane 的合法取值；spread/alt/sine 需要 count 参与分宽 */
const LANES = ["left", "right", "mid", "spread", "alt", "sine"];

/** 第 6 关的 boss 由 hand 指定，别处不许再出现 boss（单测钉这条） */
export const BOSS_LEVEL = 6;

export const LEVELS = [
  {
    name: "边境巡逻",
    groups: [
      { at: 0.6, kind: "scout", count: 5, gap: 0.55, lane: "alt" },
      { at: 4.6, kind: "scout", count: 4, gap: 0.5, lane: "spread" },
      { at: 8.4, kind: "dart", count: 3, gap: 0.7, lane: "sine" },
    ],
  },
  {
    name: "干扰编队",
    groups: [
      { at: 0.6, kind: "scout", count: 6, gap: 0.45, lane: "alt" },
      { at: 5.2, kind: "fighter", count: 3, gap: 1.1, lane: "spread" },
      { at: 10.4, kind: "dart", count: 4, gap: 0.6, lane: "left" },
      { at: 13.6, kind: "scout", count: 4, gap: 0.5, lane: "right" },
    ],
  },
  {
    name: "火力点突入",
    groups: [
      { at: 0.5, kind: "gunner", count: 2, gap: 1.8, lane: "spread" },
      { at: 3.2, kind: "scout", count: 6, gap: 0.4, lane: "alt" },
      { at: 9.0, kind: "fighter", count: 4, gap: 0.9, lane: "sine" },
      { at: 15.0, kind: "dart", count: 5, gap: 0.5, lane: "spread" },
    ],
  },
  {
    name: "轰炸机航线",
    groups: [
      { at: 0.6, kind: "bomber", count: 2, gap: 2.6, lane: "alt" },
      { at: 4.0, kind: "fighter", count: 5, gap: 0.8, lane: "spread" },
      { at: 10.6, kind: "gunner", count: 3, gap: 1.4, lane: "sine" },
      { at: 16.4, kind: "dart", count: 6, gap: 0.45, lane: "alt" },
    ],
  },
  {
    name: "护航歼灭",
    groups: [
      { at: 0.5, kind: "gunner", count: 3, gap: 1.5, lane: "spread" },
      { at: 3.4, kind: "scout", count: 8, gap: 0.35, lane: "alt" },
      { at: 9.8, kind: "bomber", count: 3, gap: 2.0, lane: "left" },
      { at: 12.0, kind: "bomber", count: 3, gap: 2.0, lane: "right" },
      { at: 18.6, kind: "fighter", count: 6, gap: 0.7, lane: "sine" },
    ],
  },
  {
    name: "母舰突袭",
    groups: [
      { at: 0.8, kind: "fighter", count: 4, gap: 1.0, lane: "alt" },
      { at: 5.6, kind: "gunner", count: 4, gap: 1.2, lane: "spread" },
      { at: 12.4, kind: "bomber", count: 4, gap: 1.6, lane: "sine" },
      { at: 18.0, kind: "boss", count: 1, gap: 0, lane: "mid" },
    ],
  },
];

/** 每关的机动幅度上限：屏幕越窄也不影响，因为是单位 */
const DRIFT_PERIOD = [3.4, 4.6, 5.8];

/** 某个小组里第 i 架（共 count 架）的横向落点 */
function laneX(lane, i, count, seed) {
  const edge = 1.5;
  const mid = FIELD.w / 2;
  const usable = FIELD.w - edge * 2;
  switch (lane) {
    case "left":
      return edge + hashJitter(seed, 3) * usable * 0.45;
    case "right":
      return FIELD.w - edge - hashJitter(seed, 7) * usable * 0.45;
    case "mid":
      return mid;
    case "spread":
      return ((i + 0.5) * FIELD.w) / Math.max(1, count);
    case "alt":
      return i % 2 === 0
        ? edge + hashJitter(seed, 11) * usable * 0.4
        : FIELD.w - edge - hashJitter(seed, 13) * usable * 0.4;
    case "sine":
    default:
      return edge + ((i + 0.5) * usable) / Math.max(1, count);
  }
}

/** 校验一张编成表：类型合法、lane 合法、时间不倒序、boss 只在最后一关 */
export function validateGroups(levelIndex) {
  const level = LEVELS[levelIndex];
  const errors = [];
  if (!level) return [`缺少第 ${levelIndex + 1} 关`];
  if (!level.name) errors.push(`第 ${levelIndex + 1} 关没有名字`);
  if (!Array.isArray(level.groups) || level.groups.length === 0) errors.push(`第 ${levelIndex + 1} 关没有编成`);
  let lastAt = -1;
  for (const [gi, group] of (level.groups ?? []).entries()) {
    if (!ENEMIES[group.kind]) errors.push(`第 ${levelIndex + 1} 关第 ${gi + 1} 组类型未知：${group.kind}`);
    if (!LANES.includes(group.lane)) errors.push(`第 ${levelIndex + 1} 关第 ${gi + 1} 组 lane 未知：${group.lane}`);
    if (!(group.count >= 1)) errors.push(`第 ${levelIndex + 1} 关第 ${gi + 1} 组架数非法`);
    if (group.at < lastAt) errors.push(`第 ${levelIndex + 1} 关第 ${gi + 1} 组入场时间倒序`);
    if (group.kind === "boss" && levelIndex + 1 !== BOSS_LEVEL) errors.push(`boss 出现在第 ${levelIndex + 1} 关`);
    if (group.kind === "boss" && group.count !== 1) errors.push("boss 必须只有 1 架");
    lastAt = group.at;
  }
  return errors;
}

/**
 * 展开成逐架计划（按 at 升序）。
 * amp/period/phase 决定这架飞机的横向机动，全部由整数序号派生。
 */
export function planFor(levelIndex) {
  const errors = validateGroups(levelIndex);
  if (errors.length) throw new Error(errors.join("；"));
  const plan = [];
  for (const [gi, group] of LEVELS[levelIndex].groups.entries()) {
    const spec = ENEMIES[group.kind];
    for (let i = 0; i < group.count; i += 1) {
      const seed = (levelIndex + 1) * 977 + gi * 31 + i;
      const x = clamp(laneX(group.lane, i, group.count, seed), spec.r, FIELD.w - spec.r);
      const amp = Math.min(spec.amp ?? 0, x - spec.r, FIELD.w - spec.r - x);
      plan.push({
        at: group.at + i * (group.gap ?? 0),
        kind: group.kind,
        x,
        amp: Math.max(0, amp),
        period: DRIFT_PERIOD[Math.floor(hashJitter(seed, 17) * DRIFT_PERIOD.length)],
        phase: hashJitter(seed, 19) * Math.PI * 2,
        index: plan.length,
      });
    }
  }
  plan.sort((a, b) => (a.at === b.at ? a.index - b.index : a.at - b.at));
  return plan;
}

/** 该关的总架数（HUD 的"本关剩余"与单测都用它） */
export function planSize(levelIndex) {
  return planFor(levelIndex).length;
}
