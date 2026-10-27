/**
 * 「危险行动」输入层：把指针/键盘事件翻译成"摇杆向量 + 转向量 + 动作名"，不碰任何游戏状态。
 *
 * 与另外三款的差别在于这里是连续量：摇杆要给引擎一个 0..1 的二维向量（setStick），
 * 而不是"下一个方向"。于是有四条必须写死在这里的规矩：
 * 1. **浮动摇杆**：以首次按下点为原点，玩家不需要先瞄准摇杆图形；
 * 2. **死区 + 满量程**：位移小于 DEAD 视为 0（避免手指贴屏时的抖动让人物乱走），
 *    超过半径归一化为 1（走得快慢由摇杆幅度决定，与设备像素无关）；
 * 3. **必须能归零**：pointerup / pointercancel / 页面隐藏 / 组件卸载 全都把向量清 0，
 *    否则会出现"手指离开了画布还在往前跑"的经典事故。
 * 4. **第一人称分屏**：isFps() 为真时右半屏的拖动改走 onLook（像素增量，不换算弧度），
 *    左半屏仍是移动摇杆；单位换算与角速度都归装配层，这里只翻译事件。
 *
 * 卸载返回 `{ unbind }`（不是裸函数），与另三款同一形状。
 */

/** 死区：摇杆半径的比例 */
const DEAD = 0.18;
/** 轻点判定：位移与时长阈值，超过就算拖动而不是交互 */
const TAP_SLOP = 12;
const TAP_MS = 300;

const KEY_MOVE = {
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  w: [0, -1],
  s: [0, 1],
  a: [-1, 0],
  d: [1, 0],
  W: [0, -1],
  S: [0, 1],
  A: [-1, 0],
  D: [1, 0],
};

/**
 * 第一人称下的转向键：左右箭头在这里是"转身"，不是俯视的横移（是否生效由 isFps 决定）。
 * 值只给方向（-1/1），角速度与单位换算归装配层。
 */
const KEY_LOOK = {
  ArrowLeft: -1,
  ArrowRight: 1,
  ",": -1,
  ".": 1,
};

const KEY_ACTION = {  " ": "fire-toggle",
  f: "interact",
  F: "interact",
  e: "interact",
  E: "interact",
  r: "reload",
  R: "reload",
  h: "med",
  H: "med",
  q: "skill",
  Q: "skill",
  x: "stop-search",
  X: "stop-search",
  p: "pause",
  P: "pause",
  Escape: "pause",
  m: "mute",
  M: "mute",
  v: "view",
  V: "view",
};

/**
 * shouldHandle 由装配层给出（藏身处/结算页不接单）：键盘监听挂在 window 上，
 * 不在这里拦一次， lobby 里的 <kbd>空格</kbd> 会被 preventDefault 吃掉，按钮就没法用键盘点。
 */
export function bindInput({ canvas, onStick, onAction, metrics, shouldHandle = () => true, isFps = () => false, onLook = null, onLookRate = null }) {
  const offs = [];
  const listen = (target, type, handler, options) => {
    target.addEventListener(type, handler, options);
    offs.push(() => target.removeEventListener(type, handler, options));
  };
  const radius = (metrics?.padRadius ?? 64) * 1.15;

  const pads = new Map();
  const keys = new Set();
  const lookKeys = new Set();

  const emitKeyStick = () => {
    let x = 0;
    let y = 0;
    for (const key of keys) {
      const vec = KEY_MOVE[key];
      if (!vec) continue;
      x += vec[0];
      y += vec[1];
    }
    const len = Math.hypot(x, y);
    if (len === 0) onStick(0, 0);
    else onStick(x / len, y / len);
  };

  const emitKeyLook = () => {
    if (!onLookRate) return;
    let dir = 0;
    for (const key of lookKeys) dir += KEY_LOOK[key] ?? 0;
    onLookRate(Math.max(-1, Math.min(1, dir)));
  };

  const toLocal = (event) => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top, width: rect.width, height: rect.height };
  };

  const onPointerDown = (event) => {
    if (pads.size >= 2) return;
    const local = toLocal(event);
    pads.set(event.pointerId, {
      id: event.pointerId,
      // 浮动摇杆：原点取首次按下点，画布内坐标只给视图画摇杆用，位移一律用 client 坐标算
      localX: local.x,
      localY: local.y,
      originX: local.x,
      originY: local.y,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      // 第一人称下右半屏是"转身区"，左半屏才是移动摇杆；俯视下两者都是移动
      zone: isFps() && local.x > local.width / 2 ? "look" : "move",
      startTime: Date.now(),
      moved: false,
    });
    try {
      canvas.setPointerCapture?.(event.pointerId);
    } catch {
      // 某些浏览器在鼠标事件上没有 capture 能力：不影响拖动，只是松手可能落到 window
    }
    if (event.pointerType !== "mouse") event.preventDefault();
  };

  const onPointerMove = (event) => {
    const pad = pads.get(event.pointerId);
    if (!pad) return;
    const rawX = event.clientX - pad.startX;
    const rawY = event.clientY - pad.startY;
    if (Math.hypot(rawX, rawY) > TAP_SLOP) pad.moved = true;
    if (!pad.moved) return;
    if (pad.zone === "look") {
      // 增量式：只报"这一帧手指走了几像素"，累计与夹取交给引擎的 setLook
      if (onLook) onLook(event.clientX - pad.lastX);
      pad.lastX = event.clientX;
      pad.localX = pad.originX + rawX;
      pad.localY = pad.originY + rawY;
      return;
    }
    pad.localX = pad.originX + rawX;
    pad.localY = pad.originY + rawY;
    const len = Math.hypot(rawX, rawY);
    if (len < radius * DEAD) {
      onStick(0, 0);
      return;
    }
    const scale = Math.min(1, len / radius);
    onStick((rawX / len) * scale, (rawY / len) * scale);
  };

  const release = (event) => {
    const pad = pads.get(event.pointerId);
    if (!pad) return;
    pads.delete(event.pointerId);
    try {
      canvas.releasePointerCapture?.(event.pointerId);
    } catch {
      // 同上：capture 不存在就跳过
    }
    const quick = Date.now() - pad.startTime < TAP_MS;
    const still = Math.hypot(event.clientX - pad.startX, event.clientY - pad.startY) < TAP_SLOP;
    // 轻点画布 = 搜刮/交互（与键盘 F 等价），拖动 = 移动/转身，两者不会互相误触发
    if (quick && still && !pad.moved) onAction("interact");
    if (pad.zone === "move" && pads.size === 0) onStick(0, 0);
  };

  const cancelAll = () => {
    pads.clear();
    keys.clear();
    lookKeys.clear();
    onStick(0, 0);
    if (onLookRate) onLookRate(0);
  };

  const onKey = (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    // 松开无条件清两边：中途切视图时按住的那根键不能留在"转身"或"横移"里出不来
    if (event.type === "keyup") {
      if (KEY_MOVE[event.key]) {
        keys.delete(event.key);
        emitKeyStick();
      }
      if (KEY_LOOK[event.key] !== undefined) {
        lookKeys.delete(event.key);
        emitKeyLook();
      }
      return;
    }
    const fps = isFps();
    // 同一个左右箭头：俯视是横移，第一人称是转身（键位归属由视图模式决定）
    const asLook = fps && KEY_LOOK[event.key] !== undefined;
    const move = asLook ? null : KEY_MOVE[event.key];
    const action = KEY_ACTION[event.key];
    if (!move && !action && !asLook) return;
    if (!shouldHandle()) return;
    // 空格会滚动页面、Esc 会被浏览器吃掉，凡是本游戏占用的键一律拦下默认行为
    event.preventDefault();
    if (asLook) {
      if (lookKeys.has(event.key)) return;
      lookKeys.add(event.key);
      emitKeyLook();
      return;
    }
    if (move) {
      if (keys.has(event.key)) return;
      keys.add(event.key);
      emitKeyStick();
      return;
    }
    onAction(action);
  };

  listen(canvas, "pointerdown", onPointerDown);
  listen(canvas, "pointermove", onPointerMove);
  listen(window, "pointerup", release);
  listen(window, "pointercancel", (event) => {
    if (pads.has(event.pointerId)) release(event);
    else cancelAll();
  });
  listen(window, "keydown", onKey);
  listen(window, "keyup", onKey);
  listen(document, "visibilitychange", () => {
    if (document.visibilityState === "hidden") cancelAll();
  });
  listen(window, "blur", cancelAll);

  return {
    unbind() {
      for (const off of offs) off();
      offs.length = 0;
      cancelAll();
    },
  };
}
