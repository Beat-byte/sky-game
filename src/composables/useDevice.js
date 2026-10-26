import { readonly, reactive } from "vue";
import { measureViewport } from "../utils/device.js";

const state = reactive(measureViewport());
let installed = false;

function remeasure() {
  Object.assign(state, measureViewport());
}

/**
 * 全站共享的设备档位：旋转、分屏、桌面窗口拖拽、手机软键盘都会刷新。
 * 只装一份监听，返回只读代理，避免各组件重复绑定 resize。
 */
export function useDevice() {
  if (!installed) {
    installed = true;
    window.addEventListener("resize", remeasure);
    window.addEventListener("orientationchange", () => setTimeout(remeasure, 120));
    window.visualViewport?.addEventListener("resize", remeasure);
  }
  return readonly(state);
}
