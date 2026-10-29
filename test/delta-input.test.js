import test from "node:test";
import assert from "node:assert/strict";
import { bindInput } from "../src/games/delta/input.js";

/**
 * input.js 是唯一"读浏览器事件"的一层，之前完全没有单测：它一坏就是
 * "手指离开了人物还在往前跑"这类只能在真机上复现的事故。
 * 这里用一个够小的假 DOM：只实现 bindInput 真正调用的那几样（事件订阅、
 * getBoundingClientRect、setPointerCapture），把 window/document 也一起桩掉。
 */
const makeEmitter = () => {
  const map = new Map();
  return {
    addEventListener(type, handler) {
      if (!map.has(type)) map.set(type, []);
      map.get(type).push(handler);
    },
    removeEventListener(type, handler) {
      const list = map.get(type) ?? [];
      const at = list.indexOf(handler);
      if (at >= 0) list.splice(at, 1);
    },
    dispatch(type, event) {
      for (const handler of [...(map.get(type) ?? [])]) handler(event);
    },
  };
};

const makeCanvas = (width, height) => ({
  ...makeEmitter(),
  getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
  setPointerCapture() {},
  releasePointerCapture() {},
});

const touch = (pointerId, x, y) => ({
  pointerId,
  pointerType: "touch",
  clientX: x,
  clientY: y,
  key: "",
  preventDefault() {},
});

const withGlobals = (fn) => {
  const hadWindow = "window" in globalThis;
  const hadDocument = "document" in globalThis;
  const window = makeEmitter();
  const document = { ...makeEmitter(), visibilityState: "visible" };
  globalThis.window = window;
  globalThis.document = document;
  try {
    return fn({ window, document });
  } finally {
    if (!hadWindow) delete globalThis.window;
    if (!hadDocument) delete globalThis.document;
  }
};

/** 记录每一次 onStick / onStickPad / onLook 调用，断言打在"最后一帧的值"上 */
const harness = (over = {}) => {
  const calls = { stick: [], pad: [], look: [], action: [], lookRate: [] };
  const canvas = makeCanvas(over.width ?? 800, over.height ?? 400);
  const bind = () =>
    bindInput({
      canvas,
      metrics: { padRadius: 58 },
      isFps: over.isFps ?? (() => false),
      onStick: (x, y) => calls.stick.push({ x, y }),
      onStickPad: (pad) => calls.pad.push(pad),
      onLook: (dx) => calls.look.push(dx),
      onLookRate: (dir, source) => calls.lookRate.push({ dir, source }),
      onAction: (name) => calls.action.push(name),
      // 手机档（横屏与竖屏）才有固定双摇杆座；这里直接喂几何，跳过 DOM 测量
      getPads: over.pads ? () => over.pads : null,
    });
  return { canvas, calls, bind };
};

const last = (list) => list[list.length - 1];

/** 844×390 横屏画布里两枚座子的位置（画布内 CSS 像素），与 CSS 里的 128 px 座同径 */
const SEATS = {
  move: { x: 78, y: 312, r: 64 },
  look: { x: 766, y: 312, r: 64 },
};

test("拖动即出摇杆向量，松手一定归零", () => {
  withGlobals(({ window }) => {
    const h = harness();
    const input = h.bind({ window });
    const radius = 58 * 1.15;
    h.canvas.dispatch("pointerdown", touch(1, 100, 100));
    // 位移超过死区才给向量：手指贴着屏幕的抖动不该让人物乱走
    h.canvas.dispatch("pointermove", touch(1, 100 + radius, 100));
    const moved = last(h.calls.stick);
    assert.ok(Math.abs(moved.x - 1) < 1e-9, `满量程应当是 1，实得 ${moved.x}`);
    assert.ok(Math.abs(moved.y) < 1e-9);
    window.dispatch("pointerup", touch(1, 100 + radius, 100));
    const released = last(h.calls.stick);
    assert.deepEqual(released, { x: 0, y: 0 }, "松手之后摇杆没归零");
    input.unbind();
  });
});

test("可见摇杆跟着手指走，且旋钮不会跑出半径外", () => {
  withGlobals(({ window }) => {
    const h = harness();
    const input = h.bind({ window });
    const radius = 58 * 1.15;
    h.canvas.dispatch("pointerdown", touch(1, 120, 200));
    const down = last(h.calls.pad);
    assert.equal(down.active, true, "按下就该把圈画出来，看不见落点是吃鸡式摇杆的大忌");
    assert.deepEqual({ x: down.originX, y: down.originY }, { x: 120, y: 200 }, "原点应取画布内的首次按下点");
    h.canvas.dispatch("pointermove", touch(1, 120, 200 - radius * 3));
    const far = last(h.calls.pad);
    assert.ok(Math.hypot(far.knobX - far.originX, far.knobY - far.originY) <= radius + 1e-6, "旋钮跑到了半径之外");
    window.dispatch("pointerup", touch(1, 120, 200 - radius * 3));
    assert.equal(last(h.calls.pad).active, false, "松手后摇杆圈还留着");
    input.unbind();
  });
});

test("两根手指：松开移动那根必须归零，哪怕转向区那根还按着", () => {
  withGlobals(({ window }) => {
    const h = harness({ isFps: () => true });
    const input = h.bind({ window });
    const radius = 58 * 1.15;
    h.canvas.dispatch("pointerdown", touch(1, 100, 200));
    h.canvas.dispatch("pointermove", touch(1, 100, 200 - radius));
    // 右半屏那根手指只负责转身，绝不能替摇杆"续命"
    h.canvas.dispatch("pointerdown", touch(2, 700, 200));
    window.dispatch("pointerup", touch(1, 100, 200 - radius));
    assert.deepEqual(last(h.calls.stick), { x: 0, y: 0 }, "还剩一根转向手指，移动向量就漏归零了");
    assert.equal(last(h.calls.pad).active, false);
    window.dispatch("pointerup", touch(2, 700, 200));
    input.unbind();
  });
});

test("第一人称右半屏只出转向增量，不产生摇杆向量", () => {
  withGlobals(({ window }) => {
    const h = harness({ isFps: () => true, width: 800, height: 400 });
    const input = h.bind({ window });
    h.canvas.dispatch("pointerdown", touch(1, 700, 200));
    h.canvas.dispatch("pointermove", touch(1, 730, 200));
    assert.deepEqual(h.calls.stick, [], "转向区的手指把移动摇杆也触发了");
    assert.deepEqual(h.calls.look, [30], "转向增量应当是这一帧走了 30 像素");
    window.dispatch("pointerup", touch(1, 730, 200));
    input.unbind();
  });
});

test("固定双摇杆：原点钉在座心，按下即有形变，绝不跟着手指长到屏幕中间", () => {
  withGlobals(({ window }) => {
    const h = harness({ width: 844, height: 390, pads: SEATS });
    const input = h.bind({ window });
    // 拇指按在左半屏偏上的位置（远离座子），摇杆原点必须是座心，不是手指
    h.canvas.dispatch("pointerdown", touch(1, 120, 90));
    const down = last(h.calls.pad);
    assert.equal(down.zone, "move");
    assert.deepEqual({ x: down.originX, y: down.originY }, { x: SEATS.move.x, y: SEATS.move.y }, "原点跑到了手指上，控件就等于放在画面中间");
    assert.ok(down.active, "按下就得把圈亮出来");
    // 固定座不需要先拖 12 px：按下已经偏离座心，向量当场生效（和平精英的左摇杆就是这个手感）
    const moved = last(h.calls.stick);
    assert.ok(moved.y < -0.9, `手指在座心正上方，应当几乎全是前进，实得 y=${moved.y}`);
    assert.ok(Math.abs(moved.x) < 0.3, `不该有横向分量，实得 x=${moved.x}`);
    window.dispatch("pointerup", touch(1, 120, 90));
    assert.deepEqual(last(h.calls.stick), { x: 0, y: 0 }, "松手没归零");
    assert.equal(last(h.calls.pad).active, false);
    input.unbind();
  });
});

test("转身摇杆：推多少转多少（连续量），松手速率归零；座外的右半屏仍是像素增量", () => {
  withGlobals(({ window }) => {
    const h = harness({ width: 844, height: 390, pads: SEATS, isFps: () => true });
    const input = h.bind({ window });
    h.canvas.dispatch("pointerdown", touch(1, SEATS.look.x, SEATS.look.y));
    // 正中心按下＝死区，不给转向量；否则手指一放上去人就自己转起来了
    assert.equal(last(h.calls.lookRate).dir, 0, "座心按下应当是死区");
    assert.equal(last(h.calls.lookRate).source, "stick");
    h.canvas.dispatch("pointermove", touch(1, SEATS.look.x + 32, SEATS.look.y));
    const half = last(h.calls.lookRate);
    assert.ok(half.dir > 0.4 && half.dir < 0.6, `推半程应当给半速，实得 ${half.dir}`);
    h.canvas.dispatch("pointermove", touch(1, SEATS.look.x + 999, SEATS.look.y));
    const full = last(h.calls.lookRate);
    assert.equal(full.dir, 1, "推过座沿没有夹到满量程");
    const knob = last(h.calls.pad);
    assert.equal(knob.zone, "look", "转身摇杆的可视化串到了移动圈上");
    assert.ok(Math.abs(knob.knobX - (SEATS.look.x + SEATS.look.r)) < 1e-6, "旋钮没夹在座半径上");
    window.dispatch("pointerup", touch(1, SEATS.look.x + 999, SEATS.look.y));
    assert.equal(last(h.calls.lookRate).dir, 0, "松开转身摇杆后速率还在，人就一直在转");
    assert.equal(last(h.calls.pad).active, false);
    // 座外的右半屏：拖动细瞄那条路不能被双摇杆取消
    h.canvas.dispatch("pointerdown", touch(2, 500, 80));
    h.canvas.dispatch("pointermove", touch(2, 540, 80));
    assert.deepEqual(h.calls.look, [40], "座外右半屏的拖动转身增量丢了");
    window.dispatch("pointerup", touch(2, 540, 80));
    input.unbind();
  });
});

test("双座档位下两枚摇杆各管各的：左手走路不受右手转身影响，反之也一样", () => {
  withGlobals(({ window }) => {
    const h = harness({ width: 844, height: 390, pads: SEATS });
    const input = h.bind({ window });
    h.canvas.dispatch("pointerdown", touch(1, SEATS.move.x, SEATS.move.y - 40));
    h.canvas.dispatch("pointerdown", touch(2, SEATS.look.x + 40, SEATS.look.y));
    const zones = h.calls.pad.map((p) => p.zone);
    assert.ok(zones.includes("move") && zones.includes("look"), "两根手指没有各自画出自己的圈");
    assert.ok(last(h.calls.stick).y < 0, "左手推上应当前进");
    assert.ok(last(h.calls.lookRate).dir > 0, "右手推右应当转身");
    // 松开转身那根：走路不能跟着归零（那是移动摇杆的手指）
    window.dispatch("pointerup", touch(2, SEATS.look.x + 40, SEATS.look.y));
    assert.ok(last(h.calls.stick).y < 0, "松开转身摇杆把走路也清零了");
    assert.equal(last(h.calls.lookRate).dir, 0);
    window.dispatch("pointerup", touch(1, SEATS.move.x, SEATS.move.y - 40));
    assert.deepEqual(last(h.calls.stick), { x: 0, y: 0 }, "松开移动摇杆没归零");
    input.unbind();
  });
});

test("轻点画布＝搜刮：只有座子以外的短按才算轻点", () => {
  withGlobals(({ window }) => {
    // 竖屏手机那一档：两座在画布下沿两角，画布中部大片区域仍是"可以点的战场"
    const portrait = { move: { x: 72, y: 535, r: 64 }, look: { x: 318, y: 535, r: 64 } };
    const h = harness({ width: 390, height: 607, pads: portrait });
    const input = h.bind({ window });
    for (const seat of [portrait.move, portrait.look]) {
      h.canvas.dispatch("pointerdown", touch(1, seat.x, seat.y));
      window.dispatch("pointerup", touch(1, seat.x, seat.y));
    }
    assert.deepEqual(h.calls.action, [], "按在摇杆座上等于按下 F：拇指在座子上歇一下就开始搜刮");
    h.canvas.dispatch("pointerdown", touch(2, 195, 240));
    window.dispatch("pointerup", touch(2, 195, 240));
    assert.deepEqual(h.calls.action, ["interact"], "座子以外轻点画布的交互入口丢了");
    input.unbind();
  });
  withGlobals(({ window }) => {
    // 平板/桌面没有座子：按下点就是浮动摇杆原点，短按照旧等价于 F
    const h = harness({ width: 800, height: 400 });
    const input = h.bind({ window });
    h.canvas.dispatch("pointerdown", touch(1, 100, 100));
    window.dispatch("pointerup", touch(1, 100, 100));
    assert.deepEqual(h.calls.action, ["interact"], "浮动摇杆档位的轻点交互被改坏了");
    input.unbind();
  });
});
