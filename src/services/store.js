/**
 * 本地成绩、偏好与局外存档的存储层（框架无关，可在 Node 里注入任意 storage 做单测）。
 *
 * 三个互不相干的键域：
 *   sky-games:game:<id>  = { v, best, plays, records[] }   单局成绩，三款街机游戏用
 *   sky-games:global     = { v, prefs }                   全局偏好（静音等）
 *   sky-games:save:<id>  = { v, ...任意游戏自定义 }        跨局资产（仓库/货币/配装）
 *
 * 存档必须单独一个键域，不要往 game:<id> 里塞新字段：本文件对成绩文档有两处"自愈"
 * （版本不符当空档、records 非数组时只挑 best/plays 重建），未知字段会被静默丢掉；
 * 而存档的 SAVE_SCHEMA_VERSION 与成绩的 SCHEMA_VERSION 各有各的递增节奏，混用会互相清零。
 *
 * 写入时机只有"一局结束"和"配装/商店变更"，绝不每帧落盘。
 * localStorage 不是无限可靠的：隐私模式可能抛错、配额可能满、内容可能被手工改坏。
 * 这里的原则是——读坏就当没有，写失败就退回内存副本并广播"存储不可用"，
 * 绝不让持久化异常打断游戏主循环。
 */

export const SCHEMA_VERSION = 1;
export const SAVE_SCHEMA_VERSION = 1;
export const RECORD_LIMIT = 20;

const PREFIX = "sky-games";
const GLOBAL_KEY = `${PREFIX}:global`;
const gameKey = (id) => `${PREFIX}:game:${id}`;
const saveKey = (id) => `${PREFIX}:save:${id}`;

const emptyGame = () => ({ v: SCHEMA_VERSION, best: 0, plays: 0, records: [] });
const emptyGlobal = () => ({ v: SCHEMA_VERSION, prefs: {} });

/** 只走 JSON 能表达的结构：存档文档本来就要求可序列化 */
const snapshot = (value) => JSON.parse(JSON.stringify(value));

function parse(raw, fallback, version = SCHEMA_VERSION) {
  if (typeof raw !== "string" || raw === "") return fallback();
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || value.v !== version) return fallback();
    return value;
  } catch {
    return fallback();
  }
}

function readNumber(storage, key) {
  if (!storage) return 0;
  try {
    const raw = Number(storage.getItem(key) ?? 0);
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
  } catch {
    return 0;
  }
}

export function createStore({ storage = null, legacyKeys = {}, now = () => Date.now() } = {}) {
  const cache = new Map();
  const saveCache = new Map();
  const globalCache = { doc: null };
  const listeners = new Set();
  let available = Boolean(storage);

  function safeGet(s, key) {
    try {
      return s.getItem(key);
    } catch {
      fail();
      return null;
    }
  }

  if (storage) {
    // 开局就探一次，避免等到用户打完一局才发现存不进去
    safeGet(storage, GLOBAL_KEY);
  }

  function gameDoc(id) {
    if (cache.has(id)) return cache.get(id);
    let doc = parse(storage ? safeGet(storage, gameKey(id)) : null, emptyGame);
    if (!Array.isArray(doc.records)) doc = { ...emptyGame(), best: doc.best ?? 0, plays: doc.plays ?? 0 };
    if (doc.best === 0 && doc.records.length === 0) {
      // 老版本只有一个裸数字键（pixel-breakout-best），首次读取时把它迁进来
      const legacyKey = legacyKeys[id];
      const legacy = readNumber(storage, legacyKey);
      if (legacy > 0) {
        doc.best = legacy;
        doc.plays = 1;
        doc.records = [{ at: now(), score: legacy, level: 1, won: false, ms: 0, legacy: true }];
        writeGame(id, doc);
      }
    }
    cache.set(id, doc);
    return doc;
  }

  function writeGame(id, doc) {
    cache.set(id, doc);
    if (!storage) return fail();
    try {
      storage.setItem(gameKey(id), JSON.stringify(doc));
    } catch {
      fail();
    }
  }

  function fail() {
    // 写不进去不代表游戏不能继续：数据留在内存里，界面提示用户本次不会保存
    if (!available) return;
    available = false;
    emit();
  }

  function globalDoc() {
    if (!globalCache.doc) {
      globalCache.doc = parse(storage ? safeGet(storage, GLOBAL_KEY) : null, emptyGlobal);
    }
    return globalCache.doc;
  }

  /**
   * 读局外存档。defaults 只用于补齐"这版新加的字段"，浅合并即可——
   * 深层结构（背包、配装）由游戏自己的 sanitize 负责，存储层不理解它们。
   * 每次返回深拷贝：调用方随手改对象不会污染缓存，要落盘必须显式 writeSave。
   */
  function readSave(id, defaults) {
    if (!saveCache.has(id)) {
      const stored = parse(storage ? safeGet(storage, saveKey(id)) : null, () => ({}), SAVE_SCHEMA_VERSION);
      saveCache.set(id, { ...(defaults ? snapshot(defaults) : {}), ...stored });
    }
    return snapshot(saveCache.get(id));
  }

  /** 版本戳由存储层盖章，游戏侧不必也不该自己填 v；返回带戳文档便于调用方直接回填界面 */
  function writeSave(id, doc) {
    const stamped = { ...doc, v: SAVE_SCHEMA_VERSION };
    saveCache.set(id, stamped);
    if (storage) {
      try {
        storage.setItem(saveKey(id), JSON.stringify(stamped));
      } catch {
        fail();
      }
    } else {
      fail();
    }
    emit();
    return stamped;
  }

  function clearSave(id) {
    saveCache.delete(id);
    if (storage) {
      try {
        storage.removeItem?.(saveKey(id));
      } catch {
        fail();
      }
    }
    emit();
  }

  function emit() {
    for (const listener of [...listeners]) listener();
  }

  return {
    /** 本地存储当前是否真的可写（隐私模式或配额满会变 false） */
    isAvailable: () => available,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    readGame(id) {
      const doc = gameDoc(id);
      return {
        best: doc.best,
        plays: doc.plays,
        records: doc.records.slice(0, RECORD_LIMIT),
        recent: doc.records.slice(0, 5),
      };
    },
    /**
     * 落一局成绩。outcome: "over" 打光生命 / "won" 全部通关 / "quit" 中途退出。
     * 返回新的最高分，便于调用方直接刷新界面。
     */
    commitRun(id, run) {
      const doc = { ...gameDoc(id) };
      const score = Math.max(0, Math.floor(Number(run.score) || 0));
      const record = {
        at: Number(run.at) || now(),
        score,
        level: Math.max(1, Math.floor(Number(run.level) || 1)),
        won: run.outcome === "won",
        ms: Math.max(0, Math.floor(Number(run.ms) || 0)),
        outcome: run.outcome === "over" || run.outcome === "won" ? run.outcome : "quit",
      };
      doc.records = [record, ...doc.records].slice(0, RECORD_LIMIT);
      doc.plays += 1;
      doc.best = Math.max(doc.best, score);
      writeGame(id, doc);
      emit();
      return doc.best;
    },
    readPrefs() {
      return { ...globalDoc().prefs };
    },
    /** 局外存档（`sky-games:save:<id>`）：读永远返回深拷贝，写要显式调用 */
    readSave,
    writeSave,
    clearSave,
    setPref(key, value) {
      const doc = { ...globalDoc(), prefs: { ...globalDoc().prefs, [key]: value } };
      globalCache.doc = doc;
      if (!storage) return fail();
      try {
        storage.setItem(GLOBAL_KEY, JSON.stringify(doc));
      } catch {
        fail();
      }
      emit();
    },
  };
}
