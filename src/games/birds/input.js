/**
 * 输入层：只把手势与按键翻译成意图，不碰任何游戏状态。
 *
 * 触屏：手指按住弹兜里的鸟往左下拖，拖距按 layout.pullRef（画布短边的 13%）归一成功率，
 * 松手发射；拖得不够（功率 < 0.08）算取消，不发。飞行中在画面任意处点一下 = 放技能。
 * 键盘：↑↓ 调仰角、→← 调功率、空格发射、X 放技能，和触屏共用同一条意图通道。
 *
 * 返回 { unbind }（不是裸函数）—— 装配层统一按 input.unbind() 清理，见 docs/rules/game-module.md。
 */

const KEY_ACTION = {
  " ": "primary",
  Enter: "primary",
  x: "ability",
  X: "ability",
  p: "pause",
  P: "pause",
  Escape: "pause",
  r: "restart",
  R: "restart",
  m: "mute",
  M: "mute",
  n: "next",
  N: "next",
};

const TRIM_ANGLE = 0.045; // 弧度/次
const TRIM_POWER = 0.05;

export function bindInput({ canvas, onPull, onRelease, onAbility, onAction, onTrim, getAim }) {
  const offs = [];
  const listen = (target, type, handler, options) => {
    target.addEventListener(type, handler, options);
    offs.push(() => target.removeEventListener(type, handler, options));
  };

  let drag = null;

  /** 手指/鼠标位置换算成画布内 CSS 像素（canvas 已被相机偏移，锚点也在同一坐标系） */
  function local(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  const onPointerDown = (event) => {
    const aim = getAim();
    const at = local(event);
    if (aim.grabbable) {
      const dist = Math.hypot(at.x - aim.anchor.x, at.y - aim.anchor.y);
      if (dist <= aim.grab) {
        drag = { id: event.pointerId, anchor: aim.anchor, pullRef: aim.pullRef };
        onPull(0, 0);
        if (event.pointerType !== "mouse") event.preventDefault();
        return;
      }
    }
    if (aim.flying) {
      onAbility();
      return;
    }
    onAction("primary");
  };

  const onPointerMove = (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const at = local(event);
    onPull(at.x - drag.anchor.x, at.y - drag.anchor.y);
    event.preventDefault();
  };

  const onPointerUp = (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    drag = null;
    onRelease();
  };

  const onPointerCancel = () => {
    if (!drag) return;
    drag = null;
    onRelease();
  };

  const onKey = (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const trim = { up: ["ArrowUp", "w", "W"], down: ["ArrowDown", "s", "S"], right: ["ArrowRight", "d", "D"], left: ["ArrowLeft", "a", "A"] };
    for (const [dir, keys] of Object.entries(trim)) {
      if (!keys.includes(event.key)) continue;
      event.preventDefault();
      if (dir === "up") onTrim(0, TRIM_ANGLE);
      else if (dir === "down") onTrim(0, -TRIM_ANGLE);
      else if (dir === "right") onTrim(TRIM_POWER, 0);
      else onTrim(-TRIM_POWER, 0);
      return;
    }
    const action = KEY_ACTION[event.key];
    if (!action) return;
    event.preventDefault();
    onAction(action);
  };

  listen(canvas, "pointerdown", onPointerDown);
  listen(canvas, "pointermove", onPointerMove);
  listen(window, "pointerup", onPointerUp);
  listen(window, "pointercancel", onPointerCancel);
  listen(window, "keydown", onKey);

  return {
    unbind() {
      for (const off of offs) off();
      offs.length = 0;
      drag = null;
    },
  };
}
