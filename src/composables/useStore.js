import { computed, ref } from "vue";
import { createStore } from "../services/store.js";
import { GAMES } from "../games/registry.js";

/**
 * 单一 store 实例 + 一个版本号 ref：store 内部不是响应式的，写盘后自增 tick，
 * 让所有依赖它的 computed 一起失效重算，首页卡片和游戏页因此不需要各自轮询。
 */
const browserStorage = typeof localStorage === "undefined" ? null : localStorage;
const legacyKeys = Object.fromEntries(GAMES.filter((g) => g.bestKey).map((g) => [g.id, g.bestKey]));
const store = createStore({ storage: browserStorage, legacyKeys });
const tick = ref(0);
store.subscribe(() => {
  tick.value += 1;
});

export function useStore() {
  return store;
}

export function useGameStats(id) {
  return computed(() => {
    void tick.value;
    return store.readGame(id);
  });
}

export function usePrefs() {
  return computed(() => {
    void tick.value;
    return store.readPrefs();
  });
}

export function useStorageAvailable() {
  return computed(() => {
    void tick.value;
    return store.isAvailable();
  });
}

/**
 * 局外存档（仓库/货币/配装这类跨局资产）。
 * defaults 必须是模块级常量：它在 computed 里参与读档，传字面量会让缓存判断失义。
 * save 是只读快照——改完要 write，否则刷新就丢；写盘同样通过 tick 让 save 重算。
 */
export function useGameSave(id, defaults) {
  const available = useStorageAvailable();
  const save = computed(() => {
    void tick.value;
    return store.readSave(id, defaults);
  });
  return {
    save,
    write: (doc) => store.writeSave(id, doc),
    reset: () => store.clearSave(id),
    available,
  };
}
