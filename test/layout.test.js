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

/** 手机竖屏（390×844，去掉导航后舞台约 390×600） */
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
