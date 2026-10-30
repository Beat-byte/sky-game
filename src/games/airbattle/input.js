/**
 * 输入层：只把触控与键盘翻译成意图，不碰任何游戏状态。
 *
 * 三条写死在这里的规矩：
 * 1. **拖动给增量不给绝对位置**：手指挡住自己飞机是竖屏射击游戏的经典病根，
 *    所以这里报的是"这一下拖了多少"（换算成单位），由引擎把这架飞机挪同样的量，
 *    手指与机身不必重合，小屏大屏同一套（像素先除以 layout.unit）。
 * 2. **键盘轴必须能归零**：pointerup / keyup / pointercancel / 卸载 全都清零，
 *    否则会出现"手指离开了画布还在往前飞"。
 * 3. **轻点 ≠ 拖动**：位移小于阈值且时间够短才算一次确认（开始/再来一次），
 *    拖过界的短按不能把局误重开。
 *
 * 返回 `{ unbind }`（不是裸函数），与另外五款同一形状，见 docs/rules/game-module.md。
 */

/** 轻点判定：与贪吃蛇同一套门槛，避免两端手感分家 */
const TAP_SLOP = 12;
const TAP_MS = 300;

const AXIS_KEYS = {
  ArrowLeft: ["left", -1, 0],
  ArrowRight: ["right", 1, 0],
  ArrowUp: ["up", 0, -1],
  ArrowDown: ["down", 0, 1],
  a: ["left", -1, 0],
  d: ["right", 1, 0],
  w: ["up", 0, -1],
  s: ["down", 0, 1],
  A: ["left", -1, 0],
  D: ["right", 1, 0],
  W: ["up", 0, -1],
  S: ["down", 0, 1],
};

const KEY_ACTION = {
  " ": "primary",
  Enter: "primary",
  b: "bomb",
  B: "bomb",
  Shift: "bomb",
  p: "pause",
  P: "pause",
  Escape: "pause",
  r: "restart",
  R: "restart",
  m: "mute",
  M: "mute",
};

/**
 * @param getUnit  取当前每单位像素（layout.unit），把像素增量换算成单位
 */
export function bindInput({ canvas, getUnit, onDrag, onAxis, onAction }) {
  const offs = [];
  const listen = (target, type, handler, options) => {
    target.addEventListener(type, handler, options);
    offs.push(() => target.removeEventListener(type, handler, options));
  };

  let drag = null;
  const held = new Set();

  const unit = () => {
    const u = getUnit?.() ?? 1;
    return u > 0 ? u : 1;
  };

  const local = (event) => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  /** 键盘轴：把当前按住的方向键合成一个 -1..1 的二维向量 */
  const pushAxis = () => {
    let x = 0;
    let y = 0;
    for (const key of held) {
      const entry = AXIS_KEYS[key];
      if (!entry) continue;
      x += entry[1];
      y += entry[2];
    }
    onAxis(Math.max(-1, Math.min(1, x)), Math.max(-1, Math.min(1, y)));
  };

  const onPointerDown = (event) => {
    const at = local(event);
    drag = { id: event.pointerId, x: at.x, y: at.y, time: Date.now(), moved: false };
    if (event.pointerType !== "mouse") event.preventDefault();
  };

  const onPointerMove = (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const at = local(event);
    const dxPx = at.x - drag.x;
    const dyPx = at.y - drag.y;
    if (Math.abs(dxPx) > TAP_SLOP || Math.abs(dyPx) > TAP_SLOP) drag.moved = true;
    if (!drag.moved) return;
    const u = unit();
    onDrag(dxPx / u, dyPx / u);
    drag.x = at.x;
    drag.y = at.y;
    event.preventDefault();
  };

  const onPointerUp = (event) => {
    if (!drag) return;
    const at = local(event);
    const quick = Date.now() - drag.time < TAP_MS;
    const still = !drag.moved && Math.abs(at.x - drag.x) < TAP_SLOP && Math.abs(at.y - drag.y) < TAP_SLOP;
    if (quick && still) onAction("primary");
    drag = null;
  };

  const onPointerCancel = () => {
    drag = null;
  };

  const onKeyDown = (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (AXIS_KEYS[event.key]) {
      event.preventDefault();
      held.add(event.key);
      pushAxis();
      return;
    }
    const action = KEY_ACTION[event.key];
    if (!action) return;
    event.preventDefault();
    onAction(action);
  };

  const onKeyUp = (event) => {
    if (!AXIS_KEYS[event.key]) return;
    held.delete(event.key);
    pushAxis();
  };

  const onBlur = () => {
    // 窗口失焦后 keyup 收不到，不归零就会一直往前飞
    held.clear();
    onAxis(0, 0);
  };

  listen(canvas, "pointerdown", onPointerDown);
  listen(canvas, "pointermove", onPointerMove);
  listen(window, "pointerup", onPointerUp);
  listen(window, "pointercancel", onPointerCancel);
  listen(window, "keydown", onKeyDown);
  listen(window, "keyup", onKeyUp);
  listen(window, "blur", onBlur);

  return {
    unbind() {
      for (const off of offs) off();
      offs.length = 0;
      drag = null;
      held.clear();
    },
  };
}
