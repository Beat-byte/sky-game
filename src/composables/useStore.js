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
