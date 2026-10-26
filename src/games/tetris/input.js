/**
 * 三端统一输入（Pointer Events + 键盘），返回 unbind 供组件卸载时摘掉监听。
 *
 * · 手机/平板：棋盘上左右拖动 = 逐格移动；向下拖 = 逐格软降；快速下甩 = 硬降；轻点 = 旋转。
 * · PC：方向键移动/软降，↑ 或 X 顺时针旋转、Z 逆时针，空格硬降，C 暂存。
 * 所有动作都只调用 enqueue 进游戏队列，由 update 按顺序消费；触摸期间 preventDefault
 * 防止页面跟着手势滚动。
 */

import { FIELD, metricsFor } from "./layout.js";

/** 触摸判定阈值：轻点位移上限（CSS 像素）与判定窗口（毫秒） */
export const TAP_SLOP = 12;
export const TAP_MS = 300;
export const FLING_MS = 280;
/** 下甩至少跨过这么多个格子才算硬降 */
export const FLING_CELLS = 2.5;

/** 允许浏览器自动重复的按键（横向移动与软降），其余按键按住不放不连发 */
const REPEATABLE = new Set(["ArrowLeft", "ArrowRight", "ArrowDown", "KeyA", "KeyD"]);

const MOVE_KEYS = {
  ArrowLeft: "left",
  KeyA: "left",
  ArrowRight: "right",
  KeyD: "right",
  ArrowDown: "soft",
  KeyS: "soft",
};

const ROTATE_KEYS = {
  ArrowUp: "rotate",
  KeyX: "rotate",
  KeyW: "rotate",
  KeyZ: "rotateCCW",
  ControlLeft: "rotateCCW",
  ControlRight: "rotateCCW",
};

const ONCE_KEYS = {
  Space: "hard",
  KeyC: "hold",
  ShiftLeft: "hold",
  ShiftRight: "hold",
};

/** 把指针的屏幕坐标映射到逻辑场地坐标（画布 CSS 盒子与场地长宽比一致，线性换算即可） */
export function toFieldPoint(canvas, clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
  return {
    x: ((clientX - rect.left) / rect.width) * FIELD.width,
    y: ((clientY - rect.top) / rect.height) * FIELD.height,
  };
}

export function bindInput({ canvas, enqueue, onAction, getStatus = () => "playing" }) {
  const off = [];
  const listen = (target, type, handler, options) => {
    target.addEventListener(type, handler, options);
    off.push(() => target.removeEventListener(type, handler, options));
  };
  const playing = () => getStatus() === "playing";
  const cell = () => metricsFor(FIELD, FIELD.device).cell;

  /** 一次触摸手势的状态：残差累加，保证「拖过一整格才动一格」 */
  let gesture = null;

  listen(canvas, "pointerdown", (e) => {
    onAction("unlock");
    if (e.pointerType !== "mouse") e.preventDefault();
    const point = toFieldPoint(canvas, e.clientX, e.clientY);
    gesture = {
      id: e.pointerId,
      type: e.pointerType,
      startClient: { x: e.clientX, y: e.clientY },
      last: point,
      start: point,
      residualX: 0,
      residualY: 0,
      moved: 0,
      at: performance.now(),
    };
    // 指针可能在事件到达前已抬起，capture 会抛 InvalidPointerId，不能因此打断手势
    try {
      canvas.setPointerCapture?.(e.pointerId);
    } catch {
      /* 忽略：拿不到捕获只影响后续移出画布的拖动 */
    }
  });

  listen(canvas, "pointermove", (e) => {
    if (!gesture || e.pointerId !== gesture.id) return;
    const size = cell();
    const point = toFieldPoint(canvas, e.clientX, e.clientY);
    const dx = point.x - gesture.last.x;
    const dy = point.y - gesture.last.y;
    gesture.moved = Math.max(gesture.moved, Math.hypot(e.clientX - gesture.startClient.x, e.clientY - gesture.startClient.y));
    gesture.last = point;

    if (!playing()) return;
    // 横向：每跨过一格发一次移动，方向由位移符号决定
    gesture.residualX += dx;
    while (Math.abs(gesture.residualX) >= size) {
      const dir = gesture.residualX > 0 ? 1 : -1;
      enqueue(dir > 0 ? "right" : "left");
      gesture.residualX -= dir * size;
    }
    // 纵向向下：每跨过一格发一次软降
    gesture.residualY += dy;
    while (gesture.residualY >= size) {
      enqueue("soft");
      gesture.residualY -= size;
    }
    if (gesture.type !== "mouse") e.preventDefault();
  });

  const finish = (e) => {
    if (!gesture || e.pointerId !== gesture.id) return;
    const size = cell();
    const elapsed = performance.now() - gesture.at;
    const travelled = gesture.last.y - gesture.start.y;
    const isTap = gesture.moved < TAP_SLOP && elapsed <= TAP_MS;
    const isFling = elapsed <= FLING_MS && travelled >= size * FLING_CELLS;

    if (!playing()) {
      // 准备/暂停/结束状态下，棋盘上的任何一次轻点都当作「主操作」
      if (isTap || gesture.type !== "mouse") onAction("primary");
    } else if (isFling) {
      enqueue("hard");
    } else if (isTap) {
      enqueue("rotate");
    }
    gesture = null;
  };

  listen(canvas, "pointerup", finish);
  listen(canvas, "pointercancel", () => {
    gesture = null;
  });
  listen(canvas, "contextmenu", (e) => e.preventDefault());

  listen(window, "keydown", (e) => {
    if (e.repeat && !REPEATABLE.has(e.code)) return;
    if (["Space", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.code)) {
      e.preventDefault();
    }
    onAction("unlock");

    if (e.code === "KeyR" && !e.repeat) return onAction("restart");
    if ((e.code === "KeyP" || e.code === "Escape") && !e.repeat) return onAction("pause");
    if (e.code === "KeyM" && !e.repeat) return onAction("mute");

    if (!playing()) {
      if (!e.repeat && (e.code === "Space" || e.code === "Enter")) onAction("primary");
      return;
    }

    if (MOVE_KEYS[e.code]) return enqueue(MOVE_KEYS[e.code]);
    if (ROTATE_KEYS[e.code]) return enqueue(ROTATE_KEYS[e.code]);
    if (ONCE_KEYS[e.code]) return enqueue(ONCE_KEYS[e.code]);
    return undefined;
  });

  listen(window, "keyup", (e) => {
    if (e.code === "Space" || e.code === "Enter") e.preventDefault();
  });

  return {
    unbind() {
      off.forEach((fn) => fn());
      off.length = 0;
      gesture = null;
    },
  };
}
