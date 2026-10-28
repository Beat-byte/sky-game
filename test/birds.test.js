/**
 * 「愤怒的小鸟」回归基线。
 *
 * 这个游戏的 bug 大多不在"算错一格"，而在"这关根本打不过"或"手机拖同样距离功率变小"，
 * 所以断言分三类钉住：
 * 1. 物理与关卡 —— 材质门槛、TNT 连锁、六关几何合法且预沉降后自稳、同输入两遍指纹一致；
 * 2. 三端同一套米制 —— 视宽恒 ≥15 米、视野高恒 ≥12 米、功率按屏幕行程归一（手指距离可换算）；
 * 3. 通关路径 —— 第一关一发入魂的分数与星数、鸟用光判负、省下鸟折 5000 分。
 *
 * 引擎文件里不许出现 Math.random（铁律 6），最后一例直接扫源码。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BOUNCE_SPEED,
  MATERIALS,
  PIG,
  World,
  makeBox,
  makeCircle,
  makePig,
  resetIds,
} from "../src/games/birds/physics.js";
import {
  BIRDS,
  BOMB,
  DASH_MULTIPLIER,
  LEVEL_CEIL,
  LEVELS,
  LEVEL_WIDTH,
  MAX_LAUNCH_SPEED,
  MIN_LAUNCH_SPEED,
  SLING,
  STRUCTURE_MIN_X,
  clampIndex,
  levelAt,
  validateLevel,
} from "../src/games/birds/levels.js";
import { Birds, starsFor } from "../src/games/birds/game.js";
import {
  MIN_VIEW_HEIGHT,
  VIEW_WIDTH,
  aimFromPull,
  backingSize,
  birdsLayout,
  cameraFor,
  screenToWorld,
  worldToScreen,
} from "../src/games/birds/layout.js";
import { draw } from "../src/games/birds/renderer.js";

const FRAME = 1 / 60;

/** 用固定帧长手动泵时间：1/60 与真 rAF 同量级，累加器会拆成 1/120 的子步 */
function pump(game, seconds) {
  const frames = Math.round(seconds / FRAME);
  for (let i = 0; i < frames; i += 1) game.update(FRAME);
  return game;
}

/** resetIds 是跨文件的：实体 id 进了指纹与碎屑相位，不重置就没法比较两局 */
function fresh(level = 0) {
  resetIds(1);
  return new Birds({ level });
}

/** 悬空的木块当靶子：睡着（视为不可移动）+ 鸟水平飞来，避开地面摩擦这个额外变量 */
function shotInto(material, vx) {
  resetIds(1);
  const world = new World({ width: LEVEL_WIDTH });
  const block = world.add(makeBox({ x: 10, y: 6, w: 1.2, h: 0.4, material }));
  block.asleep = true;
  block.sleepTimer = 1;
  const bird = world.add(makeCircle({ x: 8.6, y: 6.2, r: BIRDS.red.r, kind: "bird", mass: BIRDS.red.mass }));
  bird.vx = vx;
  const events = [];
  for (let i = 0; i < 12; i += 1) events.push(...world.step());
  return { block, bird, events, types: events.map((e) => e.type) };
}

/** 记录型 2D 上下文：只留下调用序列，用来对拍"渲染是不是纯函数" */
function fakeContext() {
  const log = [];
  const line = (name) =>
    (...args) => {
      log.push(`${name}(${args.map((a) => (typeof a === "number" ? a.toFixed(2) : typeof a === "object" ? "<obj>" : String(a))).join("|")})`);
      return paint;
    };
  const paint = new Proxy(
    {},
    {
      get: (target, key) => (typeof key === "string" ? line(`#${key}`) : undefined),
      set: () => true,
    }
  );
  const ctx = new Proxy(
    {},
    {
      get: (target, key) => (typeof key === "string" ? line(key) : undefined),
      set: (target, key, value) => {
        const shown = typeof value === "number" ? value.toFixed(2) : typeof value === "object" ? "<obj>" : String(value);
        log.push(`${String(key)}=${shown}`);
        return true;
      },
    }
  );
  return { ctx, log, paint };
}

test("材质表：石头最沉最硬、冰最脆、TNT 一碰就点引线", () => {
  assert.ok(MATERIALS.stone.density > MATERIALS.glass.density, "石头应比冰沉");
  assert.ok(MATERIALS.stone.hp > MATERIALS.wood.hp, "石头应比木头硬");
  assert.ok(MATERIALS.glass.hp < MATERIALS.wood.hp, "冰应比木头脆");
  assert.ok(MATERIALS.tnt.hp < MATERIALS.glass.hp, "TNT 最脆");
  assert.ok(MATERIALS.tnt.toughness < MATERIALS.glass.toughness, "TNT 引线门槛最低");
  assert.ok(PIG.hp < MATERIALS.wood.hp, "猪比木头脆弱，开阔地一发可杀");
  assert.ok(MATERIALS.stone.score > MATERIALS.wood.score, "越硬的砖块拆掉越值钱");
});

test("六关几何自检全部合法：不伸进弹弓区、不重叠、不出界", () => {
  assert.equal(LEVELS.length, 6);
  for (const level of LEVELS) {
    assert.deepEqual(validateLevel(level), [], `${level.id} 应无几何问题`);
    assert.ok(level.birds.length >= 3, `${level.id} 至少三发`);
    for (const name of level.birds) assert.ok(BIRDS[name], `${level.id} 的 ${name} 应有定义`);
    for (const block of level.blocks) {
      assert.ok(block.x - block.w / 2 >= STRUCTURE_MIN_X, `${level.id} 不许伸进弹弓区`);
      assert.ok(block.y + block.h / 2 <= LEVEL_CEIL, `${level.id} 结构不许顶到天顶`);
    }
  }
});

test("预沉降后六关都自稳：全员入睡、无实体被开局撞死", () => {
  for (let i = 0; i < LEVELS.length; i += 1) {
    const game = fresh(i);
    const live = game.world.bodies;
    assert.equal(game.world.isQuiet(), true, `${LEVELS[i].id} 预沉降后应安静`);
    assert.ok(live.every((b) => b.asleep), `${LEVELS[i].id} 应全员入睡`);
    // TNT 的 kind 是 "tnt" 不是 "block"，漏算它就像开局凭空掉一块砖
    const solids = live.filter((b) => b.kind === "block" || b.kind === "tnt").length;
    assert.equal(solids, LEVELS[i].blocks.length, `${LEVELS[i].id} 开局不许掉砖`);
    assert.equal(game.world.count("pig"), LEVELS[i].pigs.length, `${LEVELS[i].id} 开局不许死猪`);
    assert.equal(game.status, "ready");
  }
});

test("物理确定性：同一串输入跑两遍，整局指纹完全一致", () => {
  const play = () => {
    const game = fresh(3);
    game.start();
    game.setAim(0.5, (28 * Math.PI) / 180);
    game.launch();
    pump(game, 6);
    return game.fingerprint();
  };
  const first = play();
  const second = play();
  assert.equal(first, second, "两遍模拟必须逐位一致");
  assert.ok(first.length > 100, "指纹应包含整局实体状态");
});

test("伤害门槛：轻碰无事、中速开裂、高速碎裂，睡着的方块照吃全额冲量", () => {
  const soft = shotInto("wood", 2);
  assert.deepEqual(soft.types, [], "低于门槛的接触不该掉血");
  assert.equal(soft.block.hp, MATERIALS.wood.hp);

  const crack = shotInto("wood", 6);
  assert.deepEqual(crack.types, ["crack"], "中等速度只开裂");
  assert.ok(crack.block.hp < MATERIALS.wood.hp && crack.block.hp > 0, "开裂应掉血但不碎");

  const smash = shotInto("wood", 25);
  assert.deepEqual(smash.types, ["break"], "高速直接碎");
  assert.equal(smash.block.alive, false);

  assert.deepEqual(shotInto("stone", 25).types, ["crack"], "石头吃满速度也只是一道裂纹");
  assert.deepEqual(shotInto("glass", 6).types, ["crack"], "冰一碰就裂");
  assert.deepEqual(shotInto("tnt", 6).types, ["fuse"], "TNT 过门槛报引线，不当普通砖处理");
});

test("猪：擦碰不掉血，一发重击可杀", () => {
  resetIds(1);
  const world = new World({ width: LEVEL_WIDTH });
  const pig = world.add(makePig(10, 6));
  pig.asleep = true;
  const graze = makeCircle({ x: 8.6, y: 6.2, r: BIRDS.red.r, kind: "bird", mass: BIRDS.red.mass });
  graze.vx = 3;
  world.add(graze);
  for (let i = 0; i < 12; i += 1) world.step();
  assert.equal(pig.hp, PIG.hp, "3 米/秒的擦碰不该见血");

  resetIds(1);
  const world2 = new World({ width: LEVEL_WIDTH });
  const pig2 = world2.add(makePig(10, 6));
  pig2.asleep = true;
  const heavy = makeCircle({ x: 8.6, y: 6.2, r: BIRDS.black.r, kind: "bird", mass: BIRDS.black.mass });
  heavy.vx = 20;
  world2.add(heavy);
  const types = [];
  for (let i = 0; i < 12; i += 1) types.push(...world2.step().map((e) => e.type));
  assert.ok(types.includes("pig"), "黑鸟一撞就该送走一头猪");
  assert.equal(pig2.alive, false);
});

test("TNT 连锁：范围内的同类一起炸，范围外的石头毫发无伤", () => {
  resetIds(1);
  const world = new World({ width: LEVEL_WIDTH });
  const near = world.add(makeBox({ x: 10, y: 1, w: 0.8, h: 0.6, material: "tnt" }));
  const chained = world.add(makeBox({ x: 11.2, y: 1, w: 0.8, h: 0.6, material: "tnt" }));
  const far = world.add(makeBox({ x: 20, y: 1, w: 0.8, h: 0.6, material: "stone" }));
  const events = world.explode(near.x, near.y, BOMB.radius, BOMB.power);
  const types = events.map((e) => e.type);
  assert.equal(types[0], "boom", "第一个事件必须是爆炸本身");
  assert.equal(chained.alive, false, "相邻 TNT 应被连锁点掉");
  assert.ok(types.filter((t) => t === "boom").length >= 2, "连锁要产生第二次爆炸事件");
  assert.equal(far.hp, MATERIALS.stone.hp, "8.8 米外的石头不该掉血");
  assert.equal(near.alive, false);
});

test("爆炸返回独立事件数组，不会把上一帧的引线重新引爆", () => {
  resetIds(1);
  const game = fresh(3);
  game.queue = ["black"];
  game.shotIndex = 0;
  game.start();
  game.setAim(0.6, 1.0);
  game.launch();
  pump(game, 0.4);
  assert.equal(game.ability(), true, "黑鸟技能应触发");
  assert.equal(game.bird, null, "引爆后鸟自身消失");
  assert.equal(game.phase, "settle", "引爆即进入落定判定");
  assert.ok(game.score >= 120, "引爆本身计分");
  pump(game, 6);
  assert.ok(["won", "over", "playing"].includes(game.status), "引爆不应把状态机打崩");
});

test("发射速度落在功率区间，瞄准量被夹在合法范围", () => {
  const game = fresh(0);
  game.start();

  game.setAim(-1, 0);
  assert.equal(game.aim.power, 0, "功率下限 0");
  assert.ok(game.aim.angle >= 0.06, "仰角有下限，不许水平打");
  game.launch();
  assert.ok(Math.abs(Math.hypot(game.bird.vx, game.bird.vy) - MIN_LAUNCH_SPEED) < 1e-9, "空功率应是哑弹速度");
  pump(game, 4);

  const full = fresh(0);
  full.start();
  full.setAim(2, 3);
  assert.equal(full.aim.power, 1, "功率上限 1");
  assert.ok(full.aim.angle <= 1.45, "仰角上限约 83°，不许往正上方打");
  full.launch();
  assert.ok(Math.abs(Math.hypot(full.bird.vx, full.bird.vy) - MAX_LAUNCH_SPEED) < 1e-9);
});

test("功率按屏幕行程归一：拖满参考半径就是满功率，三端一致", () => {
  const phone = birdsLayout({ width: 390, height: 844 }, { width: 370, height: 644 });
  const desktop = birdsLayout({ width: 1440, height: 900 }, { width: 1100, height: 700 });
  assert.ok(phone.pullRef < desktop.pullRef, "手机的参考行程应更短");
  assert.equal(aimFromPull(phone, -phone.pullRef, 0).power, 1, "手机拖满 = 满功率");
  assert.equal(aimFromPull(desktop, -desktop.pullRef, 0).power, 1, "桌面拖满 = 满功率");
  assert.equal(aimFromPull(phone, -phone.pullRef / 2, 0).power, 0.5);
  // 45° 斜拖：往左下拖 = 往右上射
  const diag = aimFromPull(phone, -phone.pullRef * 0.7, phone.pullRef * 0.7);
  assert.ok(Math.abs(diag.angle - Math.PI / 4) < 1e-6, "左下 45° 拖拽应对应 45° 仰角");
  assert.ok(diag.vx > 0 && diag.vy > 0, "发射方向应落在右上方");
  // 再短的画布也留得住 28 px 行程，否则小屏玩家必须用毫米级手指位移表达功率
  assert.equal(birdsLayout({ width: 320, height: 240 }, { width: 200, height: 120 }).pullRef, 28);
});

test("三端视野下限：横向至少 15 米、纵向至少 12 米，画布吃满舞台盒子", () => {
  const cases = [
    [{ width: 390, height: 844 }, { width: 370, height: 644 }],
    [{ width: 844, height: 390 }, { width: 672, height: 390 }],
    [{ width: 820, height: 1180 }, { width: 780, height: 900 }],
    [{ width: 1440, height: 900 }, { width: 1100, height: 700 }],
    [{ width: 2560, height: 1080 }, { width: 2200, height: 640 }],
  ];
  for (const [viewport, box] of cases) {
    const layout = birdsLayout(viewport, box);
    assert.equal(layout.css.width, Math.floor(box.width), "画布宽应吃满舞台");
    assert.equal(layout.css.height, Math.floor(box.height), "画布高应吃满舞台");
    assert.ok(layout.view.width >= VIEW_WIDTH - 1e-9, `${viewport.width}×${viewport.height} 横向至少 ${VIEW_WIDTH} 米`);
    assert.ok(layout.view.height >= MIN_VIEW_HEIGHT - 1e-9, `${viewport.width}×${viewport.height} 纵向至少 ${MIN_VIEW_HEIGHT} 米`);
    assert.ok(layout.ppm > 0 && Number.isFinite(layout.ppm));
  }
  const phone = birdsLayout({ width: 390, height: 844 }, { width: 370, height: 644 });
  assert.ok(phone.ppm >= 24, "手机竖屏每米至少 24 px，砖块纹理才看得清");
  assert.equal(backingSize({ width: 370, height: 644 }).dpr, 1, "Node 里没有 window，DPR 退回 1");
});

test("坐标换算互逆，相机只平移不缩放", () => {
  const layout = birdsLayout({ width: 390, height: 844 }, { width: 370, height: 644 });
  const cam = cameraFor(layout, { x: 20, y: 8 });
  const back = screenToWorld(layout, cam, ...Object.values(worldToScreen(layout, cam, 12.34, 5.6)));
  assert.ok(Math.abs(back.x - 12.34) < 1e-9 && Math.abs(back.y - 5.6) < 1e-9, "屏幕↔世界必须互逆");

  const left = cameraFor(layout, { x: -50, y: 0 });
  assert.equal(left.x, 0, "相机不许越过关卡左端");
  const right = cameraFor(layout, { x: 500, y: 0 });
  assert.equal(right.x, Math.max(0, LEVEL_WIDTH - layout.view.width), "相机不许越过关卡右端");

  // 手机竖屏视野有 26 米高，抬到顶也在画面里；只有矮视野（桌面/横屏）才需要上抬相机
  const wide = birdsLayout({ width: 1440, height: 900 }, { width: 1100, height: 700 });
  assert.ok(wide.view.height <= 12.0001, "矮窗口应把纵向顶在 12 米下限");
  const low = cameraFor(wide, { x: 10, y: 0 });
  const high = cameraFor(wide, { x: 10, y: 12 });
  assert.equal(low.y, 0, "平射时地面贴画布底边");
  assert.ok(high.y > low.y, "高抛时相机应上抬");
  assert.equal(high.x, low.x, "上抬只改纵向，不改横向");
  assert.equal(wide.view.width, birdsLayout({ width: 1440, height: 900 }, { width: 1100, height: 700 }).view.width, "视野米数与相机无关");
});

test("技能：黄鸟急冲放大速度且每发只一次，红鸟没有技能", () => {
  const dash = fresh(2);
  dash.queue = ["yellow"];
  dash.shotIndex = 0;
  dash.start();
  dash.setAim(0.7, 1.1);
  dash.launch();
  const before = Math.hypot(dash.bird.vx, dash.bird.vy);
  assert.equal(dash.ability(), true);
  const after = Math.hypot(dash.bird.vx, dash.bird.vy);
  assert.ok(Math.abs(after / before - DASH_MULTIPLIER) < 1e-9, "急冲后速度应恰好放大 1.85 倍");
  assert.equal(dash.ability(), false, "同一发不许连放两次");

  const red = fresh(0);
  red.queue = ["red"];
  red.shotIndex = 0;
  red.start();
  red.setAim(0.6, 0.9);
  red.launch();
  assert.equal(red.ability(), false, "红鸟无技能");
  assert.equal(red.abilityReady, false);
});

test("第一关一发入魂：功率 0.5、仰角 28° 拿下 3 星与 11500 分", () => {
  const game = fresh(0);
  game.start();
  game.setAim(0.5, (28 * Math.PI) / 180);
  game.launch();
  pump(game, 12);
  assert.equal(game.status, "won");
  assert.equal(game.pigsLeft(), 0);
  assert.equal(game.birdsLeft(), 2, "三发只用了发出一发");
  assert.equal(game.stars, 3);
  assert.equal(game.score, 11500, "碎木 500 + 猪 1000 + 剩下两只鸟各 5000");
});

test("通关结算：省下的鸟折 5000 分，星数按剩余只数阶梯给", () => {
  assert.equal(starsFor(2), 3);
  assert.equal(starsFor(1), 2);
  assert.equal(starsFor(0), 1);
  assert.equal(starsFor(-1), 1, "负数兜底成 1 星");

  const game = fresh(1);
  game.start();
  game.setAim(0.5, 0.6);
  game.launch();
  for (const body of game.world.bodies) if (body.kind === "pig") game.world.kill(body);
  pump(game, 12);
  assert.equal(game.status, "won");
  assert.equal(game.birdsLeft(), 2, "三发只用一发，剩下两只折 10000 分");
  assert.equal(game.stars, 3);
  assert.ok(game.score >= 2 * 5000, "通关分至少含剩下两只鸟的折算");
});

test("鸟用光但猪还活着 → 判负且零星", () => {
  const game = fresh(LEVELS.length - 1);
  game.start();
  for (let i = 0; i < game.queue.length; i += 1) {
    game.setAim(0, 0.2); // 哑弹：落在弹弓区里，碰不到任何结构
    game.launch();
    pump(game, 9);
  }
  assert.equal(game.status, "over");
  assert.equal(game.stars, 0);
  assert.ok(game.pigsLeft() > 0, "判负时场上必须还有猪");
  assert.match(game.message, /鸟用完了/);
});

test("落定判定：鸟停在屋顶也算这一发用完，不会永远卡住", () => {
  const game = fresh(2);
  game.start();
  game.setAim(0.35, 1.3);
  game.launch();
  pump(game, 20);
  assert.notEqual(game.phase, "flight", "20 秒后仍停在 flight 就是收工条件漏了");
  assert.ok(["playing", "won", "over"].includes(game.status));
});

test("轨迹预演只按重力积分，落地或出界即截断", () => {
  const game = fresh(0);
  game.start();
  game.setAim(0.5, (28 * Math.PI) / 180);
  const points = game.trajectory(3);
  assert.ok(points.length > 5, "预演至少要给出六七个点");
  const speed = MIN_LAUNCH_SPEED + (MAX_LAUNCH_SPEED - MIN_LAUNCH_SPEED) * game.aim.power;
  const start = game.pouchWorld();
  const dt = 0.075;
  const first = points[0];
  assert.ok(Math.abs(first.x - (start.x + Math.cos(game.aim.angle) * speed * dt)) < 1e-6, "预演第一点应严格等于抛物线");
  assert.ok(Math.abs(first.y - (start.y + Math.sin(game.aim.angle) * speed * dt - 0.5 * 22 * dt * dt)) < 1e-6);
  assert.ok(points.every((p) => p.y >= 0.05 && p.x <= LEVEL_WIDTH), "预演不许画到地下或关卡外");
  // 弹兜在锚点左下：拖得越远，起点越往右下偏移
  const pulled = game.pouchWorld();
  assert.ok(pulled.x < SLING.x && pulled.y < SLING.y, "待发的小鸟应摆在弹弓锚点左下方");
});

test("HUD 口径：鸟队状态、剩余只数与猪数随发射变化", () => {
  const game = fresh(0);
  assert.deepEqual(game.hud().birds.map((b) => b.state), ["next", "wait", "wait"]);
  assert.equal(game.hud().left, 3);
  assert.equal(game.hud().level, 1);
  assert.equal(game.hud().levelTotal, LEVELS.length);
  assert.equal(game.hud().levelName, LEVELS[0].name);

  game.start();
  game.setAim(0.4, 0.5);
  game.launch();
  const mid = game.hud();
  assert.deepEqual(mid.birds.map((b) => b.state), ["used", "wait", "wait"], "飞行中的鸟算已消耗");
  assert.equal(mid.left, 1, "待发那只想算进剩余");
  assert.equal(mid.pigs, 1);
  assert.equal(mid.power, 40);
  assert.equal(mid.angle, Math.round((0.5 * 180) / Math.PI));
});

test("渲染是纯函数：不改游戏状态，同一帧两次绘制指令完全一致", () => {
  const game = fresh(4);
  game.start();
  game.setAim(0.62, 0.9);
  game.launch();
  pump(game, 1.2);
  const layout = birdsLayout({ width: 1440, height: 900 }, { width: 1100, height: 700 });
  const cam = cameraFor(layout, game.focus());
  const before = game.fingerprint();

  const a = fakeContext();
  draw(a.ctx, game, layout, cam, 1234);
  const b = fakeContext();
  draw(b.ctx, game, layout, cam, 1234);

  assert.deepEqual(b.log, a.log, "同参数两次绘制的指令序列必须逐条相同");
  assert.ok(a.log.length > 60, "至少要有几十条绘制指令，否则等于没测");
  assert.equal(game.fingerprint(), before, "渲染不许回头改状态");
});

test("关卡索引夹在合法区间，越界请求退回边界", () => {
  assert.equal(clampIndex(-3), 0);
  assert.equal(clampIndex(99), LEVELS.length - 1);
  assert.equal(clampIndex("2"), 2);
  assert.equal(clampIndex(Number.NaN), 0);
  assert.equal(levelAt(99).id, LEVELS[LEVELS.length - 1].id);

  const game = fresh(99);
  assert.equal(game.index, LEVELS.length - 1);
  assert.equal(game.nextLevel(), false, "最后一关没有下一关");

  const first = fresh(0);
  assert.equal(first.nextLevel(), true);
  assert.equal(first.index, 1);
  first.restartLevel();
  assert.equal(first.index, 1, "重开应留在本关");
  assert.equal(first.status, "playing");
});

test("暂停只冻结推进，事件与音效通道正常；引擎源码不许出现 Math.random", () => {
  const game = fresh(0);
  const sounds = [];
  game.onSound = (name) => sounds.push(name);
  game.start();
  game.togglePause();
  assert.equal(game.status, "paused");
  const frozen = game.fingerprint();
  pump(game, 5);
  assert.equal(game.fingerprint(), frozen, "暂停期间世界不许推进");
  game.togglePause();
  assert.equal(game.status, "playing");

  game.setAim(0.5, (28 * Math.PI) / 180);
  game.launch();
  pump(game, 12);
  assert.ok(sounds.includes("launch"), "发射要有音效事件");
  assert.ok(sounds.includes("win"), "通关要有音效事件");

  for (const file of ["physics.js", "levels.js", "layout.js", "game.js", "renderer.js", "input.js"]) {
    const source = readFileSync(new URL(`../src/games/birds/${file}`, import.meta.url), "utf8");
    // 带括号才算调用：注释里"不许 Math.random"这句话不该把自己抓出来
    assert.ok(!source.includes("Math.random("), `${file} 不许调用 Math.random`);
    assert.ok(!/localStorage\s*[.[]/.test(source), `${file} 不许直接读写 localStorage`);
    assert.ok(!/from ["']vue["']/.test(source), `${file} 属于引擎层，不许依赖 Vue`);
  }
  assert.ok(BOUNCE_SPEED > 0, "静止接触的反弹下限必须存在，否则静物会一直颤");
});
