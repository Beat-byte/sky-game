import { FIELD } from "./layout.js";

/** 把指针的屏幕坐标映射到逻辑场地 X（画布可能被等比留白，需要按实际绘制区换算） */
export function toFieldX(canvas, clientX) {
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0) return 0;
  // 画布 CSS 尺寸已经与场地长宽比一致，直接线性映射
  return ((clientX - rect.left) / rect.width) * FIELD.width;
}

const KEY_STEP = 620;

/**
 * 三端统一输入：
 * · PC：鼠标移动即时跟随，键盘 ← → / A D 精确微调
 * · 手机/平板：手指在舞台上任意位置拖动即移动挡板，轻点发射
 * 触摸期间阻止页面滚动，避免误滑。
 * 返回 unbind：单页应用里切换路由会卸载游戏组件，必须能干净地摘掉监听。
 */
export function bindInput({ canvas, onPointer, onAction }) {
  const keys = new Set();
  const off = [];
  const listen = (target, type, handler, options) => {
    target.addEventListener(type, handler, options);
    off.push(() => target.removeEventListener(type, handler, options));
  };
  let dragging = false;
  let touchStart = null;

  const follow = (clientX) => onPointer(toFieldX(canvas, clientX));

  listen(canvas, "pointerdown", (e) => {
    dragging = true;
    touchStart = { x: e.clientX, y: e.clientY, at: performance.now() };
    follow(e.clientX);
    // 指针可能在事件到达前已抬起（快速点击），此时 capture 会抛 InvalidPointerId，不能因此打断跟随
    try {
      canvas.setPointerCapture?.(e.pointerId);
    } catch {
      /* 忽略：拿不到捕获只影响后续移出画布的拖动 */
    }
    if (e.pointerType !== "mouse") e.preventDefault();
  });

  listen(canvas, "pointermove", (e) => {
    if (e.pointerType === "mouse" && !dragging) {
      follow(e.clientX);
      return;
    }
    if (dragging) {
      follow(e.clientX);
      e.preventDefault();
    }
  });

  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    const moved = touchStart ? Math.hypot(e.clientX - touchStart.x, touchStart.y) : 0;
    const quick = touchStart ? performance.now() - touchStart.at < 350 : false;
    if (moved < 12 && quick) onAction("primary");
    touchStart = null;
  };
  listen(canvas, "pointerup", end);
  listen(canvas, "pointercancel", () => {
    dragging = false;
    touchStart = null;
  });
  listen(canvas, "contextmenu", (e) => e.preventDefault());

  listen(window, "keydown", (e) => {
    if (e.repeat) return;
    keys.add(e.code);
    if (["Space", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.code)) {
      e.preventDefault();
    }
    if (e.code === "Space") onAction("primary");
    if (e.code === "KeyR") onAction("restart");
    if (e.code === "KeyP" || e.code === "Escape") onAction("pause");
    if (e.code === "KeyM") onAction("mute");
    if (e.code === "Enter") onAction("confirm");
  });
  listen(window, "keyup", (e) => keys.delete(e.code));
  listen(window, "blur", () => keys.clear());

  return {
    /** 键盘横向位移（逻辑像素/秒 × 步长）；鼠标或触摸由 onPointer 直接给位置 */
    readPaddleDelta(scale) {
      const left = keys.has("ArrowLeft") || keys.has("KeyA");
      const right = keys.has("ArrowRight") || keys.has("KeyD");
      const dir = (right ? 1 : 0) - (left ? 1 : 0);
      return dir * KEY_STEP * (scale / 60);
    },
    unbind() {
      off.forEach((fn) => fn());
      off.length = 0;
      keys.clear();
    },
  };
}
