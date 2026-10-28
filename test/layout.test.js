import test from "node:test";
import assert from "node:assert/strict";
import { Game } from "../src/games/breakout/game.js";
import {
  BASE_WIDTH,
  FIELD,
  MAX_WIDTH,
  MIN_HEIGHT,
  MAX_HEIGHT,
  applyField,
  canvasBox,
  computeLayout,
  deviceClass,
  fieldSize,
  metricsFor,
  orientation,
} from "../src/games/breakout/layout.js";
// 弹球与方块都导出同名的 FIELD/applyField/canvasBox/fieldSize/metricsFor，
// delta 用命名空间别名，否则下面的弹球断言会被顶掉。
import * as DL from "../src/games/delta/layout.js";

test("三种设备档位按视口尺寸划分", () => {
  // 手机：iPhone 15 / 15 Pro Max / 小屏安卓
  assert.equal(deviceClass(390, 844), "phone");
  assert.equal(deviceClass(430, 932), "phone");
  assert.equal(deviceClass(360, 640), "phone");
  assert.equal(deviceClass(844, 390), "phone"); // 手机横屏仍是手机
  // 平板：iPad / iPad Pro / 安卓平板
  assert.equal(deviceClass(820, 1180), "tablet");
  assert.equal(deviceClass(1180, 820), "tablet");
  assert.equal(deviceClass(768, 1024), "tablet");
  assert.equal(deviceClass(676, 712), "tablet");
  // PC
  assert.equal(deviceClass(1440, 900), "desktop");
  assert.equal(deviceClass(1920, 1080), "desktop");
  assert.equal(deviceClass(2560, 1440), "desktop");
});

test("方向判定覆盖手机与平板的旋转", () => {
  assert.equal(orientation(390, 844), "portrait");
  assert.equal(orientation(844, 390), "landscape");
  assert.equal(orientation(820, 1180), "portrait");
  assert.equal(orientation(1180, 820), "landscape");
});

/** 手机竖屏的窄容器（390×844，舞台被压到 388×598 时的样子；全屏层的 753 高见下面那组用例） */
const phone = computeLayout({ width: 390, height: 844 }, { width: 388, height: 598 });
/** 手机横屏（844×390，舞台约 842×250） */
const phoneWide = computeLayout({ width: 844, height: 390 }, { width: 842, height: 250 });
/** 平板竖屏（820×1180，侧栏在下方，舞台约 816×820） */
const tablet = computeLayout({ width: 820, height: 1180 }, { width: 816, height: 818 });
/** 桌面（1440×900，右侧栏 300px，舞台约 1100×820） */
const desktop = computeLayout({ width: 1440, height: 900 }, { width: 1102, height: 818 });

test("逻辑场地随容器长宽比伸缩，宽高都在预算区间内", () => {
  for (const l of [phone, phoneWide, tablet, desktop]) {
    assert.ok(l.field.width >= BASE_WIDTH && l.field.width <= MAX_WIDTH);
    assert.ok(l.field.height >= MIN_HEIGHT && l.field.height <= MAX_HEIGHT);
    // 场地比例必须贴合容器，否则画布会缩放失真
    assert.ok(Math.abs(l.aspect - l.field.width / l.field.height) < 0.01);
  }
  assert.equal(phone.device, "phone");
  assert.equal(phoneWide.device, "phone");
  assert.equal(tablet.device, "tablet");
  assert.equal(desktop.device, "desktop");
  // 竖屏拿到瘦高场地，横屏拿到宽扁场地
  assert.ok(phone.field.height > desktop.field.height);
  assert.ok(phoneWide.field.width > BASE_WIDTH, "手机横屏应加宽场地而不是两侧留白");
});

test("度量随档位调整：手机触控目标更大", () => {
  const p = metricsFor(phone.field, "phone");
  const t = metricsFor(tablet.field, "tablet");
  const d = metricsFor(desktop.field, "desktop");
  assert.ok(p.paddleW > d.paddleW, "手机挡板在逻辑宽度上更宽");
  assert.ok(p.ball >= d.ball, "手机小球不小");
  assert.ok(p.powerupW > d.powerupW, "手机端道具更好点");
  assert.ok(p.hud >= 40 && p.hud <= 62);
  assert.ok(t.paddleW > d.paddleW && t.paddleW < p.paddleW);
  // 每关砖块都在场地内
  assert.ok(p.brickTop + 8 * (p.brickHeight + p.brickGap) < phone.field.height * 0.62);
  // 宽扁场地里砖块仍然铺得开、留得住 8 行
  const pw = metricsFor(phoneWide.field, "phone");
  assert.ok(pw.brickTop + 8 * (pw.brickHeight + pw.brickGap) < phoneWide.field.height);
  assert.ok(phoneWide.field.height / (380 * pw.speedScale) < 2, "横屏垂直穿越时间不应拉长");
});

test("速度按高度同比放大，垂直穿越时间保持恒定", () => {
  const p = metricsFor(phone.field, "phone");
  const d = metricsFor(desktop.field, "desktop");
  assert.ok(Math.abs(p.speedScale - phone.field.height / 600) < 1e-9);
  assert.ok(Math.abs(d.speedScale - desktop.field.height / 600) < 1e-9);
  // 逻辑位移 = 速度 × speedScale，穿越时间 = 高度 / 速度 ≈ 常数
  const timePhone = phone.field.height / (380 * p.speedScale);
  const timeDesktop = desktop.field.height / (380 * d.speedScale);
  assert.ok(Math.abs(timePhone - timeDesktop) < 0.01);
});

test("画布盒子等比铺满容器，旋转后不留大边", () => {
  for (const [name, l, box] of [
    ["phone 竖屏", phone, { width: 388, height: 598 }],
    ["phone 横屏", phoneWide, { width: 842, height: 250 }],
    ["tablet", tablet, { width: 816, height: 818 }],
    ["desktop", desktop, { width: 1102, height: 818 }],
  ]) {
    const css = canvasBox(l, box);
    assert.ok(css.width <= box.width + 1, `${name} 宽度溢出`);
    assert.ok(css.height <= box.height + 1, `${name} 高度溢出`);
    assert.ok(Math.abs(css.width / css.height - l.field.width / l.field.height) < 0.02, `${name} 比例失真`);
    const fill = Math.min(css.width / box.width, css.height / box.height);
    assert.ok(fill > 0.96, `${name} 只填充了 ${Math.round(fill * 100)}%`);
  }
});

/**
 * 手机全屏层（src/styles/playfield.css）把控制带压到 89 px，舞台从旧的 598 长到 753，
 * 容器长宽比 0.515 比当年的地板还窄：MAX_HEIGHT/长宽比地板必须跟着放开，
 * 否则画布会被锁在 800×1200（比例 0.667），上下各白扔 86 px。
 */
const phoneFullBox = { width: 388, height: 753 };

test("手机全屏竖屏：画布吃满舞台，且加高场地不改垂直穿越时间", () => {
  const l = computeLayout({ width: 390, height: 844 }, phoneFullBox);
  assert.equal(l.device, "phone");
  assert.ok(l.field.height <= MAX_HEIGHT, "场地高度不许越过预算上限");

  const css = canvasBox(l, phoneFullBox);
  assert.ok(css.width <= phoneFullBox.width + 1 && css.height <= phoneFullBox.height + 1, "画布溢出舞台");
  assert.ok(css.height >= phoneFullBox.height - 2, `画布只占了 ${css.height} px 高，舞台被浪费`);

  const m = metricsFor(l.field, "phone");
  const timePhone = l.field.height / (380 * m.speedScale);
  const timeDesktop = desktop.field.height / (380 * metricsFor(desktop.field, "desktop").speedScale);
  assert.ok(Math.abs(timePhone - timeDesktop) < 0.01, "全屏加高场地不能改变垂直穿越时间");
  assert.ok(m.brickTop + 8 * (m.brickHeight + m.brickGap) < l.field.height * 0.62, "砖块区不能占满新场地");
  // 手机挡板的 CSS 宽度：0.19 的逻辑宽 × 每 CSS 像素对应的逻辑宽
  const paddleCss = m.paddleW * (css.width / l.field.width);
  assert.ok(paddleCss >= 60, `挡板只有 ${paddleCss.toFixed(0)} CSS px，手指盖不住`);
});

test("极端长宽比被夹在安全区间，不产生 NaN 或无穷", () => {
  for (const box of [
    { width: 320, height: 2000 },
    { width: 4000, height: 300 },
    { width: 0, height: 0 },
  ]) {
    const f = fieldSize(box);
    assert.ok(Number.isFinite(f.width) && Number.isFinite(f.height));
    assert.ok(f.width >= BASE_WIDTH && f.width <= MAX_WIDTH);
    assert.ok(f.height >= MIN_HEIGHT && f.height <= MAX_HEIGHT);
  }
});

test("applyField 就地更新共享场地并同步 HUD 高度", () => {
  const before = { ...FIELD };
  try {
    applyField({ width: BASE_WIDTH, height: 1000 }, "phone");
    assert.equal(FIELD.height, 1000);
    assert.equal(FIELD.device, "phone");
    assert.equal(FIELD.hud, metricsFor(FIELD, "phone").hud);
    assert.ok(FIELD.hud > 40);
  } finally {
    applyField({ width: before.width, height: before.height }, before.device);
  }
  assert.equal(FIELD.height, 600);
});

test("旋转到竖屏后重排：保留砖块损伤、小球按高度比例平移、元素不越界", () => {
  const game = new Game({ rng: () => 0 });
  game.start();
  applyField({ width: BASE_WIDTH, height: 600 }, "phone");
  game.relayout();

  // 打掉两块砖，模拟进行中的局面
  const [first, second] = game.targets;
  first.hp = 0;
  const damagedHp = second.maxHp - 1;
  second.hp = damagedHp;
  const ballY = FIELD.height * 0.5;
  game.balls[0].stuck = false;
  game.balls[0].y = ballY;

  // 旋转到手机竖屏，场地变高
  applyField({ width: BASE_WIDTH, height: 1100 }, "phone");
  game.relayout();

  assert.equal(game.bricks.find((b) => b.id === first.id).hp, 0, "已摧毁的砖块不应复活");
  assert.equal(
    game.bricks.find((b) => b.id === second.id).hp,
    damagedHp,
    "半损砖块的耐久应保留"
  );
  assert.ok(Math.abs(game.balls[0].y - (ballY * 1100) / 600) < 1, "小球高度按比例映射");
  assert.ok(game.paddle.y > 1100 - 120, "挡板贴住新场地底部");
  assert.ok(game.paddle.w === game.paddleWidth());

  for (const brick of game.bricks) {
    assert.ok(brick.y >= game.metrics.brickTop && brick.y + brick.h < 1100, "砖块全部在新场内");
  }

  // 再转回横屏（场地变扁）也不能把小球挤到场外
  applyField({ width: BASE_WIDTH, height: 520 }, "phone");
  game.relayout();
  const ball = game.balls[0];
  assert.ok(ball.y >= 0 && ball.y + ball.h <= FIELD.height, "压扁后小球仍在场内");
  assert.ok(ball.x >= 0 && ball.x + ball.w <= FIELD.width);

  applyField({ width: BASE_WIDTH, height: 600 }, "desktop");
});

/* ---------------- delta「危险行动」：连续世界用「逻辑视口恒定」表达同一条铁律 ---------------- */

const DL_WORLD = { width: 44, height: 30 };

test("delta 逻辑视口恒定 28×18 m，只由朝向决定、与容器尺寸无关", () => {
  assert.deepEqual(DL.fieldFor("portrait"), { width: 432, height: 672 });
  assert.deepEqual(DL.fieldFor("landscape"), { width: 672, height: 432 });
  for (const dir of ["portrait", "landscape"]) {
    const field = DL.fieldFor(dir);
    const meters = DL.viewMeters(field);
    assert.equal(meters.width * meters.height, 504, `${dir} 可见面积必须恒 504 m²`);
    assert.equal(Math.max(meters.width, meters.height), DL.VIEW.long);
    assert.equal(Math.min(meters.width, meters.height), DL.VIEW.short);
  }
  // 同朝向、容器差别悬殊的两档"可用空间"必须拿到完全一样的场地——这是与方块 fieldSize 的分水岭
  const phonePortrait = DL.computeLayout({ width: 390, height: 844 }, { width: 300, height: 420 });
  const tabletPortrait = DL.computeLayout({ width: 820, height: 1180 }, { width: 700, height: 900 });
  assert.deepEqual(phonePortrait.field, tabletPortrait.field);
  const tabletLandscape = DL.computeLayout({ width: 1180, height: 820 }, { width: 900, height: 400 });
  const desktopLandscape = DL.computeLayout({ width: 2560, height: 1440 }, { width: 2400, height: 1300 });
  assert.deepEqual(tabletLandscape.field, desktopLandscape.field);
  assert.deepEqual(tabletLandscape.field, { width: 672, height: 432 }, "横屏长边在横向");
  assert.deepEqual(DL.fieldSize({ width: 0, height: 0 }), DL.fieldFor("portrait"), "容器塌陷时按竖屏兜底，不能出 NaN");
  assert.ok(Number.isFinite(DL.canvasBox(phonePortrait, { width: 0, height: 0 }).width), "0×0 容器也不能返回 NaN");
});

test("delta 画布在三端等比内接，且看到的米数完全一致", () => {
  const cases = [
    { viewport: { width: 390, height: 844 }, available: { width: 366, height: 560 }, dir: "portrait" },
    { viewport: { width: 1180, height: 820 }, available: { width: 900, height: 400 }, dir: "landscape" },
    { viewport: { width: 1440, height: 900 }, available: { width: 1100, height: 700 }, dir: "landscape" },
    { viewport: { width: 820, height: 1180 }, available: { width: 700, height: 900 }, dir: "portrait" },
  ];
  for (const item of cases) {
    const layout = DL.computeLayout(item.viewport, item.available);
    assert.equal(layout.orientation, item.dir);
    const canvas = DL.canvasBox(layout, item.available);
    assert.ok(canvas.width <= item.available.width + 1, `${item.dir} 画布横向溢出容器`);
    assert.ok(canvas.height <= item.available.height + 1, `${item.dir} 画布纵向溢出容器`);
    assert.ok(Math.abs(canvas.width / canvas.height - layout.aspect) < 0.01, "画布必须等比内接，不能被拉扁");
    const meters = DL.viewMeters(layout.field);
    assert.deepEqual(
      { width: Math.max(meters.width, meters.height), height: Math.min(meters.width, meters.height) },
      { width: DL.VIEW.long, height: DL.VIEW.short },
      `${item.viewport.width}×${item.viewport.height} 看到的战场变了`
    );
  }
});

test("delta 手机全屏：画布每米像素地板，别让战场缩成看不清的一条", () => {
  // 反面案例（改之前的真实盒子）：.stage 只有 min-height:240px，竖屏 390 宽的手机上
  // 容器 358×240 → 画布 154×240 → 每米 8.6 px、人形 6 px，八个按钮整个盖在战场上，根本没法玩。
  // 现在局内是全屏层：画布格子 = 整屏 - 安全区 - 控制带，控制带高度按档位定死。
  const PAD_BAND = { portrait: 106, landscape: 56 };
  const cases = [
    { name: "iPhone 14 竖屏", viewport: { width: 390, height: 844 }, safe: { top: 47, bottom: 34, sides: 0 }, band: PAD_BAND.portrait },
    { name: "iPhone SE 竖屏", viewport: { width: 375, height: 667 }, safe: { top: 0, bottom: 0, sides: 0 }, band: PAD_BAND.portrait },
    { name: "iPhone 14 横屏", viewport: { width: 844, height: 390 }, safe: { top: 0, bottom: 0, sides: 47 }, band: PAD_BAND.landscape },
    { name: "iPad 竖屏", viewport: { width: 820, height: 1180 }, safe: { top: 24, bottom: 24, sides: 0 }, band: PAD_BAND.portrait },
  ];
  for (const item of cases) {
    const box = {
      width: item.viewport.width - item.safe.sides * 2,
      height: item.viewport.height - item.safe.top - item.safe.bottom - item.band,
    };
    const layout = DL.computeLayout(item.viewport, box);
    const canvas = DL.canvasBox(layout, box);
    const meters = DL.viewMeters(layout.field);
    const pxPerM = Math.min(canvas.width / meters.width, canvas.height / meters.height);
    assert.ok(pxPerM >= 18, `${item.name} 每米只有 ${pxPerM.toFixed(1)} px，人形只有 ${(2 * 0.36 * pxPerM).toFixed(1)} px`);
    // 人形直径 = radius 0.36 m × 2，13 px 是能看清朝向的下限（描边 2.4 px 之外还得留出躯干）
    assert.ok(2 * 0.36 * pxPerM >= 13, `${item.name} 玩家太小，读不出朝向`);
    // 控制带只准吃掉屏幕的一小条，否则"全屏"是假的
    assert.ok(item.band / item.viewport.height <= 0.28, `${item.name} 控制带吃掉 ${((item.band / item.viewport.height) * 100).toFixed(0)}% 屏幕`);
    assert.ok(canvas.width <= box.width + 1 && canvas.height <= box.height + 1, `${item.name} 画布溢出了格子`);
  }
});

test("delta 旋转抢跑：窗口朝向与容器打架时以容器为准，且视野面积仍是 504 m²", () => {
  // 反面案例（真机实测）：横屏容器 840×280，ResizeObserver 抢在 innerWidth 更新前回调，
  // 拿到旧窗口 390×844 → 场地排成竖屏 18×28 m → 画布 386×600，比容器高出 320 px，画面被裁、按钮压在画布上。
  const staleWindow = { width: 390, height: 844 };
  const landscapeBox = { width: 840, height: 280 };
  const vp = DL.resolveViewport(staleWindow, landscapeBox);
  assert.equal(DL.orientation(vp.width, vp.height), "landscape");
  const layout = DL.computeLayout(vp, landscapeBox);
  const canvas = DL.canvasBox(layout, landscapeBox);
  assert.ok(canvas.width <= landscapeBox.width + 1 && canvas.height <= landscapeBox.height + 1, "画布仍然溢出容器");
  assert.equal(DL.viewMeters(layout.field).width * DL.viewMeters(layout.field).height, 504);
  // 两者一致时不许改判：桌面竖窗不能被容器盒子带跑
  const agree = { width: 820, height: 1180 };
  assert.deepEqual(DL.resolveViewport(agree, { width: 816, height: 900 }), agree);
  // 藏身处里舞台 display:none，盒子恒 0×0：必须退回窗口判定，不许产出 NaN 场地
  assert.deepEqual(DL.resolveViewport(agree, { width: 0, height: 0 }), agree);
  assert.deepEqual(DL.resolveViewport(agree, null), agree);
});

test("delta 的 metricsFor 只给装饰量，玩法量一律不随设备变", () => {
  const decorative = new Set([
    "device", "field", "pxPerM", "viewMeters", "outlineWidth", "hairline", "fontSize", "hudFontSize",
    "padRadius", "padHandleRadius", "minimapSize", "minimapPadding", "glowWidth",
  ]);
  const perDevice = {};
  for (const device of ["phone", "tablet", "desktop"]) {
    const metrics = DL.metricsFor(DL.fieldFor("portrait"), device);
    perDevice[device] = metrics;
    for (const key of Object.keys(metrics)) {
      assert.ok(decorative.has(key), `metricsFor 里多出 ${key}：往这里塞米/秒/伤害就等于把难度按设备分档`);
    }
    assert.equal(metrics.pxPerM, DL.PX_PER_M);
    assert.deepEqual(metrics.viewMeters, DL.viewMeters(DL.fieldFor("portrait")));
  }
  assert.ok(
    perDevice.phone.outlineWidth > perDevice.desktop.outlineWidth,
    "手机每米像素更少，只能用更粗的描边补可读性（装饰路径）"
  );
  assert.ok(perDevice.phone.fontSize > perDevice.desktop.fontSize);
});

test("delta 相机夹在图内、bias 只挪相机不缩视野，裁剪窗口不越图", () => {
  const field = DL.fieldFor("landscape");
  assert.deepEqual(DL.cameraFor({ x: 0, y: 0 }, field, DL_WORLD), { x: 0, y: 0 }, "左上角不露出图外");
  assert.deepEqual(DL.cameraFor({ x: 44, y: 30 }, field, DL_WORLD), { x: 16, y: 12 }, "右下角夹在图边");
  assert.deepEqual(DL.cameraFor({ x: 22, y: 15 }, field, DL_WORLD), { x: 8, y: 6 });

  const plain = DL.cameraFor({ x: 22, y: 10 }, field, DL_WORLD);
  const biased = DL.cameraFor({ x: 22, y: 10 }, field, DL_WORLD, { biasM: DL.HUD_BIAS_M });
  assert.equal(biased.x, plain.x, "HUD 偏移不能横向挪相机");
  assert.equal(biased.y, plain.y + DL.HUD_BIAS_M, "偏移量以米计，且只改相机位置");
  assert.equal(DL.viewMeters(field).width * DL.viewMeters(field).height, 504, "带偏移后可见面积仍恒 504 m²");
  assert.ok(biased.y + DL.viewMeters(field).height <= DL_WORLD.height, "带偏移后仍不能露出图外");

  for (const target of [{ x: 1, y: 1 }, { x: 22, y: 15 }, { x: 43, y: 29 }]) {
    const camera = DL.cameraFor(target, field, DL_WORLD);
    const window = DL.visibleWindow(camera, field, DL_WORLD);
    assert.ok(window.x0 >= 0 && window.y0 >= 0 && window.x1 <= DL_WORLD.width - 1 && window.y1 <= DL_WORLD.height - 1);
    assert.ok((window.x1 - window.x0 + 1) * DL.PX_PER_M >= field.width, "裁剪窗口必须盖满视口，否则边上会缺画");
    assert.ok((window.y1 - window.y0 + 1) * DL.PX_PER_M >= field.height);
    const spot = DL.screenToWorld({ x: field.width / 2, y: field.height / 2 }, camera);
    assert.deepEqual(DL.worldToScreen(spot, camera), { x: field.width / 2, y: field.height / 2 }, "屏幕↔世界换算必须可逆");
  }

  // 单位契约：camera 以米为单位，米→像素只许在 worldToScreen 里乘一次 PX_PER_M。
  // 曾经写成 point.x * PX_PER_M - camera.x，两种单位混着减，越界一个像素都算渲染错位。
  const zero = { x: 0, y: 0 };
  assert.deepEqual(DL.worldToScreen({ x: 1, y: 2 }, zero), { x: DL.PX_PER_M, y: 2 * DL.PX_PER_M });
  assert.deepEqual(DL.screenToWorld({ x: DL.PX_PER_M, y: 2 * DL.PX_PER_M }, zero), { x: 1, y: 2 });
  const mid = DL.cameraFor({ x: 22, y: 15 }, field, DL_WORLD);
  assert.deepEqual(DL.worldToScreen({ x: mid.x, y: mid.y }, mid), zero, "相机原点必须落在画布左上角");
  assert.deepEqual(DL.worldToScreen({ x: mid.x + 2, y: mid.y + 1 }, mid), { x: 2 * DL.PX_PER_M, y: DL.PX_PER_M });
  const edge = DL.visibleWindow(DL.cameraFor({ x: 43, y: 29 }, field, DL_WORLD), field, DL_WORLD);
  assert.deepEqual(edge, { x0: 16, y0: 12, x1: 43, y1: 29 }, "裁剪窗口格号必须由米直接取整");
});
