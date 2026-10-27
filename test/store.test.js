import test from "node:test";
import assert from "node:assert/strict";
import {
  createStore,
  RECORD_LIMIT,
  SAVE_SCHEMA_VERSION,
  SCHEMA_VERSION,
} from "../src/services/store.js";
import { EMPTY_SAVE, START_WALLET } from "../src/games/delta/economy.js";

const KEY = "sky-games:game:breakout";
const GLOBAL_KEY = "sky-games:global";
const SAVE_KEY = "sky-games:save:delta";
const LEGACY = { breakout: "pixel-breakout-best" };

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

/** 隐私模式的 localStorage：读写都抛异常 */
function hostileStorage() {
  const boom = () => {
    throw Object.assign(new Error("QuotaExceededError"), { name: "QuotaExceededError" });
  };
  return { getItem: boom, setItem: boom };
}

const run = (over = {}) => ({ score: 800, level: 2, ms: 96000, outcome: "over", at: 1000, ...over });

test("空存储读出空档，不抛异常", () => {
  const store = createStore({ storage: fakeStorage(), legacyKeys: LEGACY });
  const profile = store.readGame("breakout");
  assert.deepEqual(profile, { best: 0, plays: 0, records: [], recent: [] });
  assert.equal(store.isAvailable(), true);
});

test("一局落盘：写最高分、局数与记录，低分不覆盖最高分", () => {
  const storage = fakeStorage();
  const store = createStore({ storage, legacyKeys: LEGACY });

  assert.equal(store.commitRun("breakout", run()), 800);
  assert.equal(store.commitRun("breakout", run({ score: 300, at: 2000 })), 800);

  const profile = store.readGame("breakout");
  assert.equal(profile.best, 800);
  assert.equal(profile.plays, 2);
  assert.equal(profile.records.length, 2);
  assert.equal(profile.records[0].score, 300, "最新一局排在最前");
  assert.equal(profile.records[1].score, 800);
  assert.deepEqual(
    { ...profile.records[0] },
    { at: 2000, score: 300, level: 2, won: false, ms: 96000, outcome: "over" }
  );
});

test("通关局记录 won 与关卡，未知结局归一化为 quit", () => {
  const store = createStore({ storage: fakeStorage(), legacyKeys: LEGACY });
  store.commitRun("breakout", run({ outcome: "won", level: 5 }));
  store.commitRun("breakout", run({ outcome: "随便什么", level: 1, score: 0 }));
  const [second, first] = store.readGame("breakout").records;
  assert.equal(first.won, true);
  assert.equal(first.level, 5);
  assert.equal(second.outcome, "quit");
  assert.equal(second.level, 1, "关卡至少记为第 1 关");
});

test("记录数量封顶，历史不会无限增长", () => {
  const store = createStore({ storage: fakeStorage(), legacyKeys: LEGACY });
  for (let i = 0; i < RECORD_LIMIT + 5; i += 1) {
    store.commitRun("breakout", run({ score: i, at: 1000 + i }));
  }
  const profile = store.readGame("breakout");
  assert.equal(profile.records.length, RECORD_LIMIT);
  assert.equal(profile.recent.length, 5);
  assert.equal(profile.plays, RECORD_LIMIT + 5, "局数继续累计，只是不再存明细");
  assert.equal(profile.best, RECORD_LIMIT + 4);
});

test("首次读取把 v1 的裸数字最高分迁进新结构并立刻落盘", () => {
  const storage = fakeStorage({ "pixel-breakout-best": "1050" });
  const store = createStore({ storage, legacyKeys: LEGACY });
  const profile = store.readGame("breakout");

  assert.equal(profile.best, 1050);
  assert.equal(profile.plays, 1);
  assert.equal(profile.records[0].legacy, true);
  assert.equal(profile.records[0].score, 1050);

  const saved = JSON.parse(storage.map.get(KEY));
  assert.equal(saved.v, 1);
  assert.equal(saved.best, 1050);
});

test("换 store 实例（等同刷新页面）后数据仍在", () => {
  const storage = fakeStorage();
  createStore({ storage, legacyKeys: LEGACY }).commitRun("breakout", run());
  const reopened = createStore({ storage, legacyKeys: LEGACY });
  assert.equal(reopened.readGame("breakout").best, 800);
  assert.equal(reopened.readGame("breakout").records.length, 1);
});

test("脏数据与旧版本一律当空档，不让页面崩溃", () => {
  for (const raw of ["", "不是 JSON", "{", '{"v":99,"best":7}', "null", "[]", '{"best":9,"records":[]}']) {
    const storage = fakeStorage({ [KEY]: raw });
    const store = createStore({ storage, legacyKeys: {} });
    assert.deepEqual(store.readGame("breakout").records, [], `脏数据 ${raw} 应读出空记录`);
  }
});

test("写不进去时退回内存副本并标记不可用，游戏流程不中断", () => {
  const store = createStore({ storage: hostileStorage(), legacyKeys: LEGACY });
  assert.equal(store.isAvailable(), false, "读就抛错的存储应当被判定为不可用");
  assert.equal(store.commitRun("breakout", run()), 800);
  assert.equal(store.readGame("breakout").best, 800, "内存副本仍然可用");
});

test("配额中途写满：已有数据可读，本局留在内存并广播不可用", () => {
  const storage = fakeStorage();
  const store = createStore({ storage, legacyKeys: LEGACY });
  store.commitRun("breakout", run());
  let notified = 0;
  store.subscribe(() => {
    notified += 1;
  });
  storage.setItem = () => {
    throw new Error("QuotaExceededError");
  };
  assert.equal(store.commitRun("breakout", run({ score: 9999, at: 5000 })), 9999);
  assert.equal(store.isAvailable(), false);
  assert.equal(notified, 2, "数据变更与“存储不可用”各通知一次");
  assert.equal(store.readGame("breakout").records[0].score, 9999);
  store.commitRun("breakout", run({ score: 1200, at: 6000 }));
  assert.equal(notified, 3, "后续写入失败不再重复广播不可用");
});

test("偏好独立存档：静音写入后可跨实例读回", () => {
  const storage = fakeStorage();
  createStore({ storage, legacyKeys: LEGACY }).setPref("muted", true);
  const reopened = createStore({ storage, legacyKeys: LEGACY });
  assert.deepEqual(reopened.readPrefs(), { muted: true });
  reopened.setPref("volume", 0.5);
  assert.equal(JSON.parse(storage.map.get(GLOBAL_KEY)).v, 1);
  assert.deepEqual(reopened.readPrefs(), { muted: true, volume: 0.5 });
});

test("没有 localStorage 的环境（如 Node）不抛异常，全程走内存", () => {
  const store = createStore({ storage: null, legacyKeys: LEGACY });
  assert.equal(store.isAvailable(), false);
  assert.equal(store.commitRun("breakout", run()), 800);
  store.setPref("muted", true);
  assert.deepEqual(store.readPrefs(), { muted: true });
});

/* ---------------- 局外存档键域（sky-games:save:<id>） ---------------- */

test("存档与成绩、偏好三个键域互不牵连", () => {
  const storage = fakeStorage();
  const store = createStore({ storage, legacyKeys: {} });
  store.writeSave("delta", { ...EMPTY_SAVE, wallet: 500 });
  assert.deepEqual([...storage.map.keys()], [SAVE_KEY], "写存档不该碰成绩或偏好键");

  store.commitRun("breakout", run());
  const save = store.readSave("delta", EMPTY_SAVE);
  assert.equal(save.wallet, 500, "落成绩不能把刚写的存档抹掉");
  assert.equal(store.readGame("breakout").best, 800);
  assert.notEqual(JSON.parse(storage.map.get(KEY)).v, undefined, "成绩文档照旧带自己的 v");
});

test("两个 schema 版本号都还是 1，老战绩原样读出", () => {
  assert.equal(SCHEMA_VERSION, 1, "动它等于把所有老用户的最高分清零");
  assert.equal(SAVE_SCHEMA_VERSION, 1);
  const legacyDoc = { v: 1, best: 4321, plays: 7, records: [{ at: 1, score: 4321, level: 3, won: false, ms: 1000, outcome: "over" }] };
  const store = createStore({ storage: fakeStorage({ [KEY]: JSON.stringify(legacyDoc) }), legacyKeys: {} });
  const profile = store.readGame("breakout");
  assert.deepEqual(profile.records, legacyDoc.records);
  assert.equal(profile.best, 4321);
  assert.equal(profile.plays, 7);
});

test("存档缺字段时按 defaults 补齐，已有字段保留", () => {
  const storage = fakeStorage({ [SAVE_KEY]: JSON.stringify({ v: 1, wallet: 880, xp: 500 }) });
  const save = createStore({ storage, legacyKeys: {} }).readSave("delta", EMPTY_SAVE);
  assert.equal(save.wallet, 880);
  assert.equal(save.xp, 500);
  assert.equal(save.stash.slots, EMPTY_SAVE.stash.slots, "这版新加的字段要从 defaults 补进来");
  assert.deepEqual(save.stats, EMPTY_SAVE.stats);
  assert.deepEqual(save.loadout, EMPTY_SAVE.loadout);
});

test("脏存档一律回落 defaults，不把页面搞崩", () => {
  for (const raw of ["", "不是 JSON", "{", "null", "[]", '{"v":99,"wallet":7}', '{"wallet":9}']) {
    const store = createStore({ storage: fakeStorage({ [SAVE_KEY]: raw }), legacyKeys: {} });
    assert.equal(store.readSave("delta", EMPTY_SAVE).wallet, START_WALLET, `脏数据 ${raw} 应回落到初始钱包`);
    assert.equal(store.isAvailable(), true, "读坏不该把整个存储层判死");
  }
});

test("readSave 交回深拷贝，writeSave 由存储层盖版本戳", () => {
  const storage = fakeStorage();
  const store = createStore({ storage, legacyKeys: {} });
  store.writeSave("delta", { ...EMPTY_SAVE, wallet: 1200 });

  const snapshot = store.readSave("delta", EMPTY_SAVE);
  assert.equal(snapshot.v, SAVE_SCHEMA_VERSION, "调用方不该自己填 v");
  snapshot.stash.items.push({ key: "ghost", qty: 1 });
  snapshot.loadout.primary = "stolen";

  const reread = store.readSave("delta", EMPTY_SAVE);
  assert.deepEqual(reread.stash.items, EMPTY_SAVE.stash.items, "改快照不能污染缓存");
  assert.equal(reread.stash.items.some((item) => item.key === "ghost"), false, "脏改动不能回流");
  assert.equal(reread.loadout.primary, null);
  assert.deepEqual(JSON.parse(storage.map.get(SAVE_KEY)).stash.items, EMPTY_SAVE.stash.items);
});

test("存档写不进去时退回内存副本并广播，成绩路径不受牵连", () => {
  const store = createStore({ storage: hostileStorage(), legacyKeys: LEGACY });
  let notified = 0;
  store.subscribe(() => {
    notified += 1;
  });
  assert.equal(store.isAvailable(), false);
  store.writeSave("delta", { ...EMPTY_SAVE, wallet: 77 });
  assert.equal(store.readSave("delta", EMPTY_SAVE).wallet, 77, "内存副本继续可用");
  assert.equal(store.commitRun("breakout", run()), 800);
  assert.equal(store.readGame("breakout").best, 800);
  assert.equal(notified, 2, "存档与成绩各广播一次数据变更，而「存储不可用」不再重复广播");
});

test("clearSave 之后回到 defaults，且跨实例等同刷新能读回", () => {
  const storage = fakeStorage();
  const store = createStore({ storage, legacyKeys: {} });
  store.writeSave("delta", { ...EMPTY_SAVE, wallet: 3300, xp: 1000 });
  const reopened = createStore({ storage, legacyKeys: {} });
  const reread = reopened.readSave("delta", EMPTY_SAVE);
  assert.equal(reread.wallet, 3300);
  assert.equal(reread.xp, 1000);

  reopened.clearSave("delta");
  assert.equal(storage.map.has(SAVE_KEY), false, "键要真的删掉，否则下次刷新又回来了");
  assert.equal(reopened.readSave("delta", EMPTY_SAVE).wallet, START_WALLET);
});
