/**
 * 贪吃蛇输入：触屏用四向滑动改方向、轻点确认；键盘用方向键或 WASD、空格确认。
 * 返回 unbind() 供组件卸载时解绑，避免在 SPA 里重复进出后监听叠加。
 */

const SWIPE_MIN = 22;

const KEY_DIR = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  w: "up",
  s: "down",
  a: "left",
  d: "right",
  W: "up",
  S: "down",
  A: "left",
  D: "right",
};

const KEY_ACTION = {
  " ": "primary",
  Enter: "primary",
  p: "pause",
  P: "pause",
  Escape: "pause",
  r: "restart",
  R: "restart",
  m: "mute",
  M: "mute",
};

export function bindInput({ canvas, onDir, onAction }) {
  const offs = [];
  const listen = (target, type, handler, options) => {
    target.addEventListener(type, handler, options);
    offs.push(() => target.removeEventListener(type, handler, options));
  };

  let start = null;

  const emitDir = (dx, dy) => {
    if (Math.abs(dx) > Math.abs(dy)) onDir(Math.abs(dx) < SWIPE_MIN ? null : dx > 0 ? "right" : "left");
    else onDir(Math.abs(dy) < SWIPE_MIN ? null : dy > 0 ? "down" : "up");
  };

  const onPointerDown = (e) => {
    start = { x: e.clientX, y: e.clientY, time: Date.now(), id: e.pointerId };
    if (e.pointerType !== "mouse") e.preventDefault();
  };

  const onPointerMove = (e) => {
    if (!start || e.pointerId !== start.id) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    // 一次拖动只改一个方向，改完后把起点挪到当前位置，允许连续划圈式转向
    if (Math.abs(dx) < SWIPE_MIN && Math.abs(dy) < SWIPE_MIN) return;
    emitDir(dx, dy);
    start = { ...start, x: e.clientX, y: e.clientY };
  };

  const onPointerUp = (e) => {
    if (!start) return;
    const quick = Date.now() - start.time < 260;
    const still = Math.abs(e.clientX - start.x) < SWIPE_MIN && Math.abs(e.clientY - start.y) < SWIPE_MIN;
    if (quick && still) onAction("primary");
    start = null;
  };

  const onKey = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const dir = KEY_DIR[e.key];
    const action = KEY_ACTION[e.key];
    if (!dir && !action) return;
    e.preventDefault();
    if (action) onAction(action);
    else onDir(dir);
  };

  listen(canvas, "pointerdown", onPointerDown);
  listen(canvas, "pointermove", onPointerMove);
  listen(window, "pointerup", onPointerUp);
  listen(window, "keydown", onKey);

  return {
    // 与弹球、方块堆叠保持同一形状：装配层统一用 input.unbind() 清理
    unbind() {
      for (const off of offs) off();
      offs.length = 0;
      start = null;
    },
  };
}
