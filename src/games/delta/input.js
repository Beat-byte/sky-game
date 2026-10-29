/**
 * 「危险行动」输入层：把指针/键盘事件翻译成"摇杆向量 + 转向量 + 动作名"，不碰任何游戏状态。
 *
 * 与另外三款的差别在于这里是连续量：摇杆要给引擎一个 0..1 的二维向量（setStick），
 * 而不是"下一个方向"。于是有六条必须写死在这里的规矩：
 * 1. **摇杆两种形态**：给得出固定座（getPads 返回几何，手机档横屏与竖屏都画两枚座子）时，
 *    原点钉在座上、按下即成形变；给不出（平板/桌面）才退回"浮动摇杆"，以首次按下点为原点。
 * 2. **死区 + 满量程**：位移小于 DEAD 视为 0（避免手指贴屏时的抖动让人物乱走），
 *    超过半径归一化为 1（走得快慢由摇杆幅度决定，与设备像素无关）；
 * 3. **必须能归零**：pointerup / pointercancel / 页面隐藏 / 组件卸载 全都把向量清 0，
 *    否则会出现"手指离开了画布还在往前跑"的经典事故。多指也一样：
 *    松开移动区那根手指时，只要移动区里不再有余下的手指就必须归零，转向区那根不算。
 * 4. **右半屏转身有两条路**：按在转身座上＝摇杆，给 onLookRate 的连续量（推多少转多快）；
 *    按在座外的右半屏＝拖动，给 onLook 的像素增量（细瞄用）。两者都只喂引擎的 setLook，
 *    换算与夹取归装配层与引擎，这里只翻译事件。
 * 5. **摇杆要看得见**：onStickPad 把当前手指所在摇杆的画布内坐标（含 zone/原点/旋钮/半径）
 *    报给装配层，由 DOM 画那两圈。这是纯显示通道，和给引擎的归一化向量互不依赖，去掉它游戏照玩。
 * 6. **轻点只对"画布"生效**：短按且没移动＝交互（与键盘 F 等价），但落在固定座圆内的短按是"操作控件"，
 *    不发 interact —— 拇指在座子上歇一下就开始翻包，是吃鸡式摇杆最烦的误触发。
 *
 * 卸载返回 `{ unbind }`（不是裸函数），与另三款同一形状。
 */

/** 死区：摇杆半径的比例 */
const DEAD = 0.18;
/** 轻点判定：位移与时长阈值，超过就算拖动而不是交互 */
const TAP_SLOP = 12;
const TAP_MS = 300;
/** 转身座的触控放大圈：拇指落在座沿外侧一点也算"我要用摇杆"，不必精准命中 */
const LOOK_CAPTURE = 1.4;

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
/**
 * getPads 由装配层给出（手机档才有，横屏贴屏幕下沿、竖屏贴画布下沿）：返回两块固定摇杆座
 * 在画布内的几何 `{ move: { x, y, r }, look: { x, y, r } }`，或 null。几何一律画布内 CSS 像素。
 * 它改变"摇杆长在哪、什么时候有形变"，并让落在座子里的短按不再等价于轻点搜刮；
 * 但不动任何给引擎的量纲。
 */
export function bindInput({ canvas, onStick, onAction, metrics, shouldHandle = () => true, isFps = () => false, onLook = null, onLookRate = null, onStickPad = null, getPads = null }) {
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
    onLookRate(Math.max(-1, Math.min(1, dir)), "key");
  };

  const toLocal = (event) => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top, width: rect.width, height: rect.height };
  };

  /**
   * 可见摇杆：把当前那根手指所在摇杆的画布内坐标报给装配层去画圈（zone 区分移动/转身）。
   * 坐标一律是画布 CSS 像素（与 onStick 的归一化向量不同，那是给引擎的，这是给 DOM 的）；
   * 旋钮位置按半径夹一次，画面上不会出现手指跑出去了圈还跟着走的错位。
   */
  let stickId = null;
  let lookId = null;
  /**
   * 显示通道只说两句话：这跟手指归"move" 还是"look" 那枚圈画。
   * 内部的第三种 zone（座外右半屏的增量拖动）根本不发 pad，所以 lookstick 在这里就折成 look，
   * 装配层不必知道判定分了三种。
   */
  const emitStickPad = (pad) => {
    if (!onStickPad || !pad) return;
    const dx = pad.localX - pad.originX;
    const dy = pad.localY - pad.originY;
    const len = Math.hypot(dx, dy);
    const reach = len > pad.radius ? pad.radius / len : 1;
    onStickPad({
      zone: pad.zone === "lookstick" ? "look" : pad.zone,
      active: true,
      originX: pad.originX,
      originY: pad.originY,
      knobX: pad.originX + dx * reach,
      knobY: pad.originY + dy * reach,
      radius: pad.radius,
    });
  };
  const clearStickPad = (zone) => {
    onStickPad?.({ zone, active: false, originX: 0, originY: 0, knobX: 0, knobY: 0, radius });
  };

  /**
   * 触点分类：
   * - 没有固定座（平板/桌面）→ 老规矩，第一人称右半屏＝拖动转身，其余＝移动摇杆；
   * - 有固定座（手机档，横屏与竖屏）→ 落在转身座的放大圈里＝转身摇杆；左半屏＝移动摇杆（原点钉在座上）；
   *   右半屏的别处仍是拖动转身，细瞄不需要先把手指挪回摇杆上。
   */
  const classify = (local, rig) => {
    if (!rig) return isFps() && local.x > local.width / 2 ? "look" : "move";
    const look = rig.look;
    if (look && Math.hypot(local.x - look.x, local.y - look.y) <= look.r * LOOK_CAPTURE) return "lookstick";
    return local.x > local.width / 2 ? "look" : "move";
  };

  /** 移动摇杆：形变＝手指相对原点（固定座=座心，浮动=按下点）的向量，按半径夹一次再进死区 */
  const applyMove = (pad) => {
    emitStickPad(pad);
    const dx = pad.localX - pad.originX;
    const dy = pad.localY - pad.originY;
    const len = Math.hypot(dx, dy);
    if (len < pad.radius * DEAD) {
      onStick(0, 0);
      return;
    }
    const scale = Math.min(1, len / pad.radius);
    onStick((dx / len) * scale, (dy / len) * scale);
  };

  /**
   * 转身摇杆：只取横向形变换算成 -1..1 的连续量（这引擎没有俯仰，上下推不改任何东西），
   * 角速度与夹取交给装配层的 setLook；纵向形变仍然画进旋钮，手感上像个真摇杆。
   */
  const applyLookStick = (pad) => {
    emitStickPad(pad);
    const dx = pad.localX - pad.originX;
    const dy = pad.localY - pad.originY;
    const len = Math.hypot(dx, dy);
    if (len < pad.radius * DEAD) {
      onLookRate?.(0, "stick");
      return;
    }
    const reach = Math.min(len, pad.radius);
    onLookRate?.(Math.max(-1, Math.min(1, ((dx / len) * reach) / pad.radius)), "stick");
  };

  const onPointerDown = (event) => {
    if (pads.size >= 2) return;
    const local = toLocal(event);
    const rig = getPads?.() ?? null;
    const zone = classify(local, rig);
    const seat = rig ? (zone === "move" ? rig.move : rig.look) : null;
    const pad = {
      id: event.pointerId,
      // 固定座：原点=座心，按下即有形变；浮动档：原点=首次按下点，先移动再算
      zone,
      fixed: Boolean(seat),
      /**
       * 手指是否落在那枚**画得出来的座子**里。座子是控件，不是战场：拇指停在上面临时按一下
       * 不该同时等价于键盘 F（搜刮）；座子以外的画布照旧算轻点。
       */
      inSeat: Boolean(seat) && Math.hypot(local.x - seat.x, local.y - seat.y) <= seat.r,
      originX: seat ? seat.x : local.x,
      originY: seat ? seat.y : local.y,
      radius: seat ? seat.r : radius,
      localX: local.x,
      localY: local.y,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      startTime: Date.now(),
      moved: false,
    };
    pads.set(event.pointerId, pad);
    if (zone === "move" && stickId === null) {
      stickId = pad.id;
      if (pad.fixed) applyMove(pad);
      else emitStickPad(pad);
    } else if (zone === "lookstick" && lookId === null) {
      lookId = pad.id;
      applyLookStick(pad);
    }
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
    const local = toLocal(event);
    pad.localX = local.x;
    pad.localY = local.y;
    if (pad.zone === "look") {
      // 增量式：只报"这一帧手指走了几像素"，累计与夹取交给引擎的 setLook
      if (!pad.moved) return;
      if (onLook) onLook(event.clientX - pad.lastX);
      pad.lastX = event.clientX;
      return;
    }
    // 固定摇杆一按下就有形变，不需要先移动满 12 px；浮动摇杆仍然要求"确实拖了"
    if (!pad.moved && !pad.fixed) return;
    if (pad.id === lookId) applyLookStick(pad);
    else if (pad.id === stickId) applyMove(pad);
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
    // 轻点画布 = 搜刮/交互（与键盘 F 等价），拖动 = 移动/转身，两者不会互相误触发；
    // 落在摇杆座里的短按是"操作控件"，不算轻点，否则拇指在座子上歇一下就开始翻包
    if (quick && still && !pad.moved && !pad.inSeat) onAction("interact");
    if (pad.id === stickId) {
      // 另一根手指还在移动区时摇杆要接力，不能因为"还剩一根手指"就漏归零
      const next = [...pads.values()].find((p) => p.zone === "move");
      stickId = next ? next.id : null;
      if (next) applyMove(next);
      else {
        clearStickPad("move");
        onStick(0, 0);
      }
    }
    if (pad.id === lookId) {
      const next = [...pads.values()].find((p) => p.zone === "lookstick");
      lookId = next ? next.id : null;
      if (next) applyLookStick(next);
      else {
        clearStickPad("look");
        onLookRate?.(0, "stick");
      }
    }
  };

  const cancelAll = () => {
    pads.clear();
    keys.clear();
    lookKeys.clear();
    const hadLook = lookId !== null;
    stickId = null;
    lookId = null;
    onStick(0, 0);
    onStickPad?.({ zone: "move", active: false, originX: 0, originY: 0, knobX: 0, knobY: 0, radius });
    if (hadLook) onStickPad?.({ zone: "look", active: false, originX: 0, originY: 0, knobX: 0, knobY: 0, radius });
    if (onLookRate) onLookRate(0); // 不带来源 = 键盘与摇杆两条速率一起归零
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
