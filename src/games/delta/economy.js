/**
 * 「危险行动」的局外经济：存档形状、清洗、结算与商店买卖。
 *
 * 这个文件只吃 save、只吐新的 save，拿不到 storage 也拿不到 DOM ——
 * "绝不在帧循环里落盘"由此变成结构上的不可能，而不是纪律要求。
 * 落盘时机只有两个：一局结算一次、配装或商店变更一次。
 *
 * 手工改档的原则：能作弊（改出钱和货），但不能改出崩溃或无限增长，
 * 所以每一条数组都有上限，每一个数字都有夹取。
 */

import { ITEM_KEYS, ITEMS, buyPrice, sellPrice } from "./loot.js";
import { WEAPONS, ARMORS, HELMETS, AMMO, MEDS } from "./weapons.js";

const OUTCOME_SET = new Set(["escaped", "killed", "timeout", "aborted"]);
const AMMO_KINDS = new Set(Object.keys(AMMO));
const MEDKIT = Object.keys(MEDS)[0] ?? null;

export const LEVEL_MAX = 30;
export const STASH_SLOTS = 60;
export const STASH_ITEM_CAP = 240;
export const STACK_MAX = 99;
export const WALLET_MAX = 1e9;
export const START_WALLET = 12000;

/** 技能二选一：烟幕阻视线 / 脉冲标记视野 */
export const SKILLS = ["smoke", "pulse"];

const SKILL_SET = new Set(SKILLS);

/** 等级只由 xp 派生：单独存一份就能被改档改出两套真相 */
export function levelFor(xp) {
  const gained = Math.max(0, Math.floor(Number(xp) || 0));
  return Math.min(LEVEL_MAX, 1 + Math.floor(Math.sqrt(gained / 120)));
}

/** 保险箱格数随等级涨，上限 5 —— 它是唯一豁免掉落的地方 */
export function safeBoxSlotsFor(level) {
  return Math.min(5, 2 + Math.floor(levelFor(level) / 3));
}

export const EMPTY_SAVE = {
  wallet: START_WALLET,
  xp: 0,
  level: 1,
  safeBox: { slots: 2, items: [] },
  // 起手包：手枪 + 小背包 + 一盒子弹 + 两个医疗包，够打完第一局低风险撤离再谈购物
  stash: {
    slots: STASH_SLOTS,
    items: [
      { key: "wp_pistol", qty: 1 },
      { key: "bg_small", qty: 1 },
      { key: "am_9", qty: 36 },
      { key: "md_medkit", qty: 2 },
    ],
  },
  loadout: {
    primary: null,
    sidearm: null,
    armor: null,
    armorDur: 0,
    helmet: null,
    bag: null,
    ammo: { kind: null, count: 0 },
    meds: 0,
    skill: null,
  },
  tasks: { active: null, got: 0, need: 0, cycle: 0 },
  stats: {
    raids: 0,
    escapes: 0,
    deaths: 0,
    timeouts: 0,
    quits: 0,
    kills: 0,
    containersSearched: 0,
    bestRaidValue: 0,
  },
  createdAt: 0,
  updatedAt: 0,
};

function integer(value, min, max, fallback = 0) {
  const num = Math.floor(Number(value));
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function textOrNull(value, keys) {
  if (typeof value !== "string" || value === "") return null;
  if (keys && !keys.has(value)) return null;
  return value;
}

/** 同 key 合并堆叠：改档塞两条一样的弹药也不会让列表越读越长 */
function cleanItems(list, cap, keys) {
  if (!Array.isArray(list)) return [];
  const byKey = new Map();
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const key = textOrNull(entry.key, keys);
    if (!key) continue;
    const qty = integer(entry.qty, 1, STACK_MAX);
    byKey.set(key, Math.min(STACK_MAX, (byKey.get(key) ?? 0) + qty));
    if (byKey.size >= cap) break;
  }
  return [...byKey].map(([key, qty]) => ({ key, qty }));
}

function cleanCounts(value, shape) {
  const source = value && typeof value === "object" ? value : {};
  const out = {};
  for (const [key, max] of Object.entries(shape)) out[key] = integer(source[key], 0, max);
  return out;
}

/**
 * 任何输入（缺字段、脏数据、超范围、未知物品 key）都返回一个完整可用的存档。
 * 不抛异常、不返回 null —— 主循环里没人能接住这个异常。
 */
export function sanitizeSave(raw, { itemKeys } = {}) {
  const doc = raw && typeof raw === "object" ? raw : {};
  const xp = integer(doc.xp, 0, Number.MAX_SAFE_INTEGER);
  const level = levelFor(xp);
  const loadout = doc.loadout && typeof doc.loadout === "object" ? doc.loadout : {};
  const ammo = loadout.ammo && typeof loadout.ammo === "object" ? loadout.ammo : {};
  const tasks = doc.tasks && typeof doc.tasks === "object" ? doc.tasks : {};
  const safeBox = doc.safeBox && typeof doc.safeBox === "object" ? doc.safeBox : {};
  const stash = doc.stash && typeof doc.stash === "object" ? doc.stash : {};

  return {
    wallet: integer(doc.wallet, 0, WALLET_MAX, EMPTY_SAVE.wallet),
    xp,
    level,
    safeBox: {
      slots: safeBoxSlotsFor(level),
      items: cleanItems(safeBox.items, safeBoxSlotsFor(level), itemKeys),
    },
    stash: {
      slots: integer(stash.slots, 1, STASH_SLOTS, STASH_SLOTS),
      items: cleanItems(stash.items, STASH_ITEM_CAP, itemKeys),
    },
    loadout: {
      primary: textOrNull(loadout.primary, itemKeys),
      sidearm: textOrNull(loadout.sidearm, itemKeys),
      armor: textOrNull(loadout.armor, itemKeys),
      armorDur: integer(loadout.armorDur, 0, 100),
      helmet: textOrNull(loadout.helmet, itemKeys),
      bag: textOrNull(loadout.bag, itemKeys),
      ammo: { kind: textOrNull(ammo.kind, itemKeys), count: integer(ammo.count, 0, STACK_MAX * 9) },
      meds: integer(loadout.meds, 0, STACK_MAX),
      skill: SKILL_SET.has(loadout.skill) ? loadout.skill : null,
    },
    tasks: {
      active: typeof tasks.active === "string" && tasks.active !== "" ? tasks.active : null,
      got: integer(tasks.got, 0, 999),
      need: integer(tasks.need, 0, 999),
      cycle: integer(tasks.cycle, 0, 9999),
    },
    stats: {
      ...EMPTY_SAVE.stats,
      ...cleanCounts(doc.stats, {
        raids: 999999,
        escapes: 999999,
        deaths: 999999,
        timeouts: 999999,
        quits: 999999,
        kills: 9999999,
        containersSearched: 9999999,
        bestRaidValue: WALLET_MAX,
      }),
    },
    createdAt: integer(doc.createdAt, 0, Number.MAX_SAFE_INTEGER),
    updatedAt: integer(doc.updatedAt, 0, Number.MAX_SAFE_INTEGER),
    // 同一局结算只生效一次：视图可能因卸载与按钮各调一次，重复结算会重复发钱
    lastRunId: integer(doc.lastRunId, 0, Number.MAX_SAFE_INTEGER),
  };
}

/** 等级 30 封顶对应的经验上限，防止改档把 xp 写成无穷大 */
export const XP_CAP = Math.pow(LEVEL_MAX - 1, 2) * 120;

/** 任务表：kind 决定这局该加多少进度，reward 只在完成的那一次发放 */
export const TASKS = [
  { id: "t_first_raid", label: "完成一次撤离", kind: "escape", need: 1, reward: { wallet: 4000, xp: 300 } },
  { id: "t_scavenger", label: "累计搜刮 12 个容器", kind: "searched", need: 12, reward: { wallet: 5000, xp: 400 } },
  { id: "t_hunter", label: "累计击倒 8 名敌人", kind: "kills", need: 8, reward: { wallet: 7000, xp: 600 } },
  { id: "t_liquidate", label: "累计带回 8000 价值的货", kind: "value", need: 8000, reward: { wallet: 9000, xp: 800 } },
  { id: "t_veteran", label: "累计撤离 5 次", kind: "escapes", need: 5, reward: { wallet: 12000, xp: 1200 } },
];

const TASK_BY_ID = new Map(TASKS.map((task) => [task.id, task]));

export function taskById(id) {
  return TASK_BY_ID.get(id) ?? null;
}

/** 每局的任务按 cycle 轮转，永远不发"已完成过的那种"以外的随机任务：轮转可预测，改档也刷不出奖励 */
export function taskForCycle(cycle) {
  const n = TASKS.length;
  return TASKS[Math.max(0, Math.floor(Number(cycle) || 0)) % n];
}

/** 开局前保证有一个进行中的任务（老档或空档都从这里补上） */
export function ensureTask(save) {
  const base = sanitizeSave(save, { itemKeys: ITEM_KEYS });
  const task = taskById(base.tasks.active) ?? taskForCycle(base.tasks.cycle);
  if (base.tasks.active === task.id && base.tasks.need === task.need) return base;
  return { ...base, tasks: { ...base.tasks, active: task.id, need: task.need, got: base.tasks.active === task.id ? base.tasks.got : 0 } };
}

function progressFor(taskKind, result) {
  switch (taskKind) {
    case "escape":
    case "escapes":
      return result.escaped ? 1 : 0;
    case "searched":
      return result.searched ?? 0;
    case "kills":
      return result.kills ?? 0;
    case "value":
      return result.value ?? 0;
    default:
      return 0;
  }
}

/** 同 key 合并 + 上限夹取；返回溢出部分给 UI 显示"装不下了" */
function pushItems(list, cap, entries) {
  const out = list.map((entry) => ({ ...entry }));
  const overflow = [];
  for (const entry of entries ?? []) {
    const key = typeof entry?.key === "string" && ITEMS[entry.key] ? entry.key : null;
    if (!key) continue;
    const qty = integer(entry.qty, 1, STACK_MAX);
    const existing = out.find((item) => item.key === key);
    if (existing) {
      const merged = Math.min(STACK_MAX, existing.qty + qty);
      const spill = existing.qty + qty - merged;
      existing.qty = merged;
      if (spill > 0) overflow.push({ key, qty: spill });
      continue;
    }
    if (out.length >= cap) { overflow.push({ key, qty }); continue; }
    out.push({ key, qty });
  }
  return { items: out, overflow };
}

function takeItems(list, key, qty) {
  const out = [];
  let left = Math.max(1, integer(qty, 1, STACK_MAX));
  for (const entry of list) {
    if (entry.key !== key || left <= 0) { out.push({ ...entry }); continue; }
    const keep = entry.qty - left;
    left -= entry.qty;
    if (keep > 0) out.push({ key, qty: keep });
  }
  return out;
}

export function findItem(list, key) {
  return (list ?? []).find((entry) => entry.key === key) ?? null;
}

export function countItem(list, key) {
  return findItem(list, key)?.qty ?? 0;
}

/** 仓库/保险箱能不能放下这批货（藏身处 UI 与结算共用同一把尺子） */
export function canStash(save, entries, { safeBox = false } = {}) {
  const base = sanitizeSave(save, { itemKeys: ITEM_KEYS });
  const zone = safeBox ? base.safeBox : base.stash;
  return pushItems(zone.items, zone.slots, entries).overflow.length === 0;
}

export function equipFromStash(save, key, slot) {
  const base = sanitizeSave(save, { itemKeys: ITEM_KEYS });
  const spec = ITEMS[key];
  const loadable = ["primary", "sidearm", "armor", "helmet", "bag"];
  if (!spec || !loadable.includes(slot)) return { save: base, ok: false, reason: "bad-slot" };
  const wanted = spec.kind === slot || (slot === "primary" && spec.kind === "weapon" && WEAPONS[key]?.slot === "primary") || (slot === "sidearm" && spec.kind === "weapon" && WEAPONS[key]?.slot === "sidearm");
  if (!wanted) return { save: base, ok: false, reason: "wrong-slot" };
  if (countItem(base.stash.items, key) <= 0) return { save: base, ok: false, reason: "not-in-stash" };
  const loadout = { ...base.loadout };
  const previous = loadout[slot];
  loadout[slot] = key;
  if (slot === "armor") loadout.armorDur = ARMORS[key]?.durMax ?? loadout.armorDur;
  if (slot === "helmet") loadout.helmetDur = HELMETS[key]?.durMax ?? loadout.helmetDur;
  // 先取出新装备那一件，再把原来那件放回仓库；放不回去就直接拒绝，避免出现"两件都在但仓库只有一件"
  const withoutNew = takeItems(base.stash.items, key, 1);
  const back = previous ? pushItems(withoutNew, base.stash.slots, [{ key: previous, qty: 1 }]) : { items: withoutNew, overflow: [] };
  if (back.overflow.length) return { save: base, ok: false, reason: "stash-full" };
  const next = sanitizeSave({ ...base, stash: { ...base.stash, items: back.items }, loadout }, { itemKeys: ITEM_KEYS });
  return { save: next, ok: true, reason: null };
}

export function unequip(save, slot) {
  const base = sanitizeSave(save, { itemKeys: ITEM_KEYS });
  const key = base.loadout[slot];
  if (!key || ["ammo", "meds", "skill"].includes(slot)) return { save: base, ok: false, reason: "empty" };
  const verdict = pushItems(base.stash.items, base.stash.slots, [{ key, qty: 1 }]);
  if (verdict.overflow.length) return { save: base, ok: false, reason: "stash-full" };
  const loadout = { ...base.loadout, [slot]: null };
  if (slot === "armor") loadout.armorDur = 0;
  if (slot === "helmet") loadout.helmetDur = 0;
  return { save: sanitizeSave({ ...base, stash: { ...base.stash, items: verdict.items }, loadout }, { itemKeys: ITEM_KEYS }), ok: true, reason: null };
}

export function buyItem(save, key, qty = 1) {
  const base = sanitizeSave(save, { itemKeys: ITEM_KEYS });
  const count = integer(qty, 1, STACK_MAX);
  const price = buyPrice(key, count);
  if (!ITEMS[key] || price <= 0) return { save: base, ok: false, reason: "unknown" };
  const verdict = pushItems(base.stash.items, base.stash.slots, [{ key, qty: count }]);
  if (verdict.overflow.length) return { save: base, ok: false, reason: "stash-full" };
  if (base.wallet < price) return { save: base, ok: false, reason: "wallet" };
  return {
    save: sanitizeSave({ ...base, wallet: base.wallet - price, stash: { ...base.stash, items: verdict.items } }, { itemKeys: ITEM_KEYS }),
    ok: true,
    reason: null,
    price,
  };
}

export function sellItem(save, key, qty = 1) {
  const base = sanitizeSave(save, { itemKeys: ITEM_KEYS });
  const count = integer(qty, 1, STACK_MAX);
  const have = countItem(base.stash.items, key);
  if (have <= 0) return { save: base, ok: false, reason: "not-in-stash" };
  const sold = Math.min(have, count);
  const price = sellPrice(key, sold);
  return {
    save: sanitizeSave({ ...base, wallet: Math.min(WALLET_MAX, base.wallet + price), stash: { ...base.stash, items: takeItems(base.stash.items, key, sold) } }, { itemKeys: ITEM_KEYS }),
    ok: true,
    reason: null,
    price,
  };
}

/** 保险箱是唯一豁免掉落的地方，所以移入移出必须是显式操作（藏身处按钮），不能顺手拖 */
export function moveToSafeBox(save, key, qty = 1) {
  const base = sanitizeSave(save, { itemKeys: ITEM_KEYS });
  const count = Math.min(integer(qty, 1, STACK_MAX), countItem(base.stash.items, key));
  if (count <= 0) return { save: base, ok: false, reason: "not-in-stash" };
  const verdict = pushItems(base.safeBox.items, base.safeBox.slots, [{ key, qty: count }]);
  if (verdict.overflow.length) return { save: base, ok: false, reason: "safebox-full" };
  return {
    save: sanitizeSave({ ...base, safeBox: { ...base.safeBox, items: verdict.items }, stash: { ...base.stash, items: takeItems(base.stash.items, key, count) } }, { itemKeys: ITEM_KEYS }),
    ok: true,
    reason: null,
  };
}

export function moveFromSafeBox(save, key, qty = 1) {
  const base = sanitizeSave(save, { itemKeys: ITEM_KEYS });
  const count = Math.min(integer(qty, 1, STACK_MAX), countItem(base.safeBox.items, key));
  if (count <= 0) return { save: base, ok: false, reason: "not-in-safebox" };
  const verdict = pushItems(base.stash.items, base.stash.slots, [{ key, qty: count }]);
  if (verdict.overflow.length) return { save: base, ok: false, reason: "stash-full" };
  return {
    save: sanitizeSave({ ...base, stash: { ...base.stash, items: verdict.items }, safeBox: { ...base.safeBox, items: takeItems(base.safeBox.items, key, count) } }, { itemKeys: ITEM_KEYS }),
    ok: true,
    reason: null,
  };
}

export function setSkill(save, skill) {
  const base = sanitizeSave(save, { itemKeys: ITEM_KEYS });
  if (!SKILL_SET.has(skill)) return { save: base, ok: false, reason: "unknown" };
  return { save: sanitizeSave({ ...base, loadout: { ...base.loadout, skill } }, { itemKeys: ITEM_KEYS }), ok: true, reason: null };
}

export function refillAmmo(save, kind, qty) {
  const base = sanitizeSave(save, { itemKeys: ITEM_KEYS });
  const count = integer(qty, 0, STACK_MAX * 9);
  if (!AMMO_KINDS.has(kind)) return { save: base, ok: false, reason: "unknown" };
  const have = countItem(base.stash.items, kind);
  const take = Math.min(have, count);
  if (take <= 0) return { save: base, ok: false, reason: "not-in-stash" };
  const left = Math.min(STACK_MAX * 9, base.loadout.ammo.count + take);
  return {
    save: sanitizeSave({ ...base, stash: { ...base.stash, items: takeItems(base.stash.items, kind, take) }, loadout: { ...base.loadout, ammo: { kind, count: left } } }, { itemKeys: ITEM_KEYS }),
    ok: true,
    reason: null,
    moved: take,
  };
}

export function refillMeds(save, qty) {
  const base = sanitizeSave(save, { itemKeys: ITEM_KEYS });
  const take = Math.min(countItem(base.stash.items, MEDKIT), integer(qty, 0, STACK_MAX));
  if (take <= 0) return { save: base, ok: false, reason: "not-in-stash" };
  return {
    save: sanitizeSave({ ...base, stash: { ...base.stash, items: takeItems(base.stash.items, MEDKIT, take) }, loadout: { ...base.loadout, meds: Math.min(STACK_MAX, base.loadout.meds + take) } }, { itemKeys: ITEM_KEYS }),
    ok: true,
    reason: null,
    moved: take,
  };
}

/** 出征检查：没主武器或没子弹就是"送死"，UI 直接拦住并说明缺什么 */
export function raidReadiness(save) {
  const base = sanitizeSave(save, { itemKeys: ITEM_KEYS });
  const missing = [];
  if (!base.loadout.primary && !base.loadout.sidearm) missing.push("武器");
  if (!base.loadout.ammo.kind || base.loadout.ammo.count <= 0) missing.push("弹药");
  if (!base.loadout.bag) missing.push("背包");
  if (!base.loadout.skill) missing.push("技能");
  return { ready: missing.length === 0, missing };
}

/**
 * 一局结算：唯一允许改钱和货的地方，也是唯一被视图调用的入口。
 *
 * 规则（暗区突围的简化版，写死在这里，视图不参与判定）：
 * - 撤离 / 中途返回：货和装备都回来，装备耐久与剩余弹药按 left 回写；
 * - 阵亡 / 超时：身上的一切（武器、防具、背包、弹约、医疗包、搜到的货）全部作废，
 *   只有保险箱里的东西留下——这就是"保险箱格数随等级涨"唯一的意义来源；
 * - 仓库放不下的货明列在 ledger.droppedForOverload，绝不静默吞。
 */
export function settleRaid(save, result, { now = Date.now(), runId = null } = {}) {
  const base = sanitizeSave(save, { itemKeys: ITEM_KEYS });
  if (runId !== null && base.lastRunId === integer(runId, 1, Number.MAX_SAFE_INTEGER)) {
    return { save: base, ledger: null, deduped: true };
  }
  const outcome = OUTCOME_SET.has(result?.outcome) ? result.outcome : "aborted";
  const survived = outcome === "escaped" || outcome === "aborted";
  const ledger = {
    outcome,
    survived,
    kept: [],
    lost: [],
    keptSafe: base.safeBox.items.map((entry) => ({ ...entry })),
    droppedForOverload: [],
    reissued: [],
    walletDelta: 0,
    xpGained: integer(result?.xp, 0, 99999),
    levelUp: null,
    taskDone: null,
  };

  const stats = { ...base.stats, raids: base.stats.raids + 1 };
  if (outcome === "escaped") stats.escapes += 1;
  else if (outcome === "killed") stats.deaths += 1;
  else if (outcome === "timeout") stats.timeouts += 1;
  else stats.quits += 1;
  stats.kills = Math.min(9999999, stats.kills + integer(result?.kills, 0, 999));
  stats.containersSearched = Math.min(9999999, stats.containersSearched + integer(result?.searched, 0, 999));
  stats.bestRaidValue = Math.max(stats.bestRaidValue, integer(result?.value, 0, WALLET_MAX));

  let stash = { ...base.stash, items: base.stash.items.map((entry) => ({ ...entry })) };
  let loadout = { ...base.loadout, ammo: { ...base.loadout.ammo } };
  const left = result?.left ?? {};

  if (survived) {
    const incoming = [];
    for (const entry of result?.loot ?? []) incoming.push({ key: entry.key, qty: entry.qty });
    // 身上那套装备不复制进仓库：撤离后它还在配装格里，只回写耐久与剩余弹药。
    // 早期版本在这里把装备一起塞进仓库，于是"撤离一次 = 武器变两把"，卖掉就是一直刷钱。
    const verdict = pushItems(stash.items, stash.slots, incoming);
    stash = { ...stash, items: verdict.items };
    ledger.droppedForOverload = verdict.overflow.map((entry) => ({ ...entry, label: ITEMS[entry.key]?.label ?? entry.key }));
    for (const entry of incoming) ledger.kept.push({ ...entry, label: ITEMS[entry.key]?.label ?? entry.key });
    loadout.armorDur = integer(left.armorDur, 0, ARMORS[loadout.armor]?.durMax ?? 100);
    loadout.helmetDur = integer(left.helmetDur, 0, HELMETS[loadout.helmet]?.durMax ?? 100);
    loadout.ammo = { kind: AMMO_KINDS.has(loadout.ammo.kind) ? loadout.ammo.kind : null, count: integer(left.ammoReserve, 0, STACK_MAX * 9) };
    loadout.meds = integer(left.meds, 0, STACK_MAX);
  } else {
    for (const entry of result?.loot ?? []) ledger.lost.push(entry);
    for (const slot of ["primary", "sidearm", "armor", "helmet", "bag"]) {
      if (loadout[slot]) ledger.lost.push({ key: loadout[slot], qty: 1, slot });
    }
    if (loadout.ammo.count > 0) ledger.lost.push({ key: loadout.ammo.kind ?? "ammo", qty: Math.min(STACK_MAX, loadout.ammo.count) });
    // 阵亡=装备全丢，这是"进图前先想清楚带什么"的唯一压强来源
    loadout = { ...EMPTY_SAVE.loadout, ammo: { kind: loadout.ammo.kind, count: 0 }, skill: loadout.skill };
    /**
     * 破产保底：补发一份起手包（与新档同一份）。
     * 不补的话，"起手包全在装备上 + 阵亡全丢"会让新玩家第一次死亡就买不起
     * 枪+弹+背包（8840+5508+2040 > 12000），卡死在藏身处出不去。
     * 压强仍然保留：高级货、护甲、搜到的货一律不补。
     */
    const reissue = EMPTY_SAVE.stash.items.map((entry) => ({ ...entry }));
    const verdict = pushItems(stash.items, stash.slots, reissue);
    stash = { ...stash, items: verdict.items };
    ledger.reissued = reissue.map((entry) => ({ ...entry, label: ITEMS[entry.key]?.label ?? entry.key }));
  }

  const xpBefore = base.xp;
  const levelBefore = base.level;
  const task = taskById(base.tasks.active) ?? taskForCycle(base.tasks.cycle);
  const gained = progressFor(task.kind, { ...result, escaped: outcome === "escaped" });
  const taskProgress = Math.min(999, base.tasks.got + integer(gained, 0, 99999));
  let wallet = base.wallet;
  let taskState;
  if (taskProgress >= task.need) {
    wallet = Math.min(WALLET_MAX, wallet + task.reward.wallet);
    ledger.walletDelta = task.walletDelta = task.reward.wallet;
    ledger.xpGained += task.reward.xp;
    ledger.taskDone = { id: task.id, label: task.label, reward: { ...task.reward } };
    const next = taskForCycle(base.tasks.cycle + 1);
    taskState = { active: next.id, got: 0, need: next.need, cycle: base.tasks.cycle + 1 };
  } else {
    taskState = { active: task.id, got: taskProgress, need: task.need, cycle: base.tasks.cycle };
  }

  const xp = Math.min(XP_CAP, xpBefore + ledger.xpGained);
  const level = levelFor(xp);
  if (level > levelBefore) ledger.levelUp = { from: levelBefore, to: level };

  const next = sanitizeSave({
    ...base,
    wallet,
    xp,
    safeBox: base.safeBox,
    stash,
    loadout,
    tasks: taskState,
    stats,
    createdAt: base.createdAt || now,
    updatedAt: now,
    lastRunId: integer(runId ?? now, 0, Number.MAX_SAFE_INTEGER),
  }, { itemKeys: ITEM_KEYS });
  next.updatedAt = now;
  return { save: next, ledger, deduped: false };
}
