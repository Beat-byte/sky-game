/**
 * 「飞机大战」回归基线。
 *
 * 这款游戏的 bug 不会长在"算错一格"，而会长在三个地方，所以断言按这三类钉：
 * 1. 三端同一 —— 空域恒 9×16 单位（换档只换每单位像素）、手机画布有尺寸地板；
 * 2. 确定性 —— 六关编成可展开、可复算、同一帧逐笔一致，引擎与渲染都不许出现 Math.random；
 * 3. 通关路径 —— 火力/炸弹/道具的上下限、连击封顶、坠机判负、母舰清空判胜与结算奖励。
 *
 * 输入层用假 emitter 桩（临时挂 globalThis.window），与 delta-input.test.js 同一套办法。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BOMB,
  COMBO,
  ENEMIES,
  FIELD,
  LEVEL_COUNT_FLOOR,
  MAX_WEAPON,
  SHIP,
  WEAPONS,
  hashJitter,
} from "../src/games/airbattle/field.js";
import { BOSS_LEVEL, LEVELS, planFor, planSize, validateGroups } from "../src/games/airbattle/waves.js";
import { Airbattle } from "../src/games/airbattle/game.js";
import {
  airbattleLayout,
  backingSize,
  fitBoard,
  metricsFor,
  screenToWorld,
  worldToScreen,
} from "../src/games/airbattle/layout.js";
import { draw } from "../src/games/airbattle/renderer.js";
import { bindInput } from "../src/games/airbattle/input.js";

const FRAME = 1 / 60;

/**
 * 真视口配真舞台：手机竖屏那档是 2026-10-28 实测过的 388×676（全屏层扣掉控制带 168），
 * 其余按同口径估。几何地板必须钉在真实容器上，随便给个数测了等于没测。
 */
const STAGES = [
  { name: "手机竖屏", viewport: { width: 390, height: 844 }, box: { width: 388, height: 676 }, device: "phone", orientation: "portrait" },
  { name: "手机横屏", viewport: { width: 844, height: 390 }, box: { width: 670, height: 388 }, device: "phone", orientation: "landscape" },
  { name: "平板", viewport: { width: 1024, height: 768 }, box: { width: 1004, height: 600 }, device: "tablet", orientation: "landscape" },
  { name: "桌面", viewport: { width: 1440, height: 900 }, box: { width: 1100, height: 700 }, device: "desktop", orientation: "landscape" },
];

function pump(game, seconds) {
  const frames = Math.round(seconds / FRAME);
  for (let i = 0; i < frames; i += 1) game.update(FRAME);
  return game;
}

function fresh() {
  return new Airbattle({});
}

function started() {
  const game = fresh();
  game.start();
  return game;
}

function desktopLayout() {
  return airbattleLayout(STAGES[3].viewport, STAGES[3].box);
}

/** 渲染对拍用的记录型 ctx：只认 renderer.js 实际用到的手段，新增 canvas API 要同步补这里 */
function makeCtx() {
  const log = [];
  const num = (v) => (typeof v === "number" ? v.toFixed(2) : String(v));
  const method = (name) => (...args) => log.push(`${name}(${args.map(num).join(",")})`);
  const ctx = {
    setTransform: method("setTransform"),
    clearRect: method("clearRect"),
    fillRect: method("fillRect"),
    beginPath: method("beginPath"),
    moveTo: method("moveTo"),
    lineTo: method("lineTo"),
    closePath: method("closePath"),
    fill: method("fill"),
    stroke: method("stroke"),
    arc: method("arc"),
    save: method("save"),
    restore: method("restore"),
  };
  for (const key of ["fillStyle", "strokeStyle", "lineWidth", "globalAlpha", "shadowColor", "shadowBlur", "lineCap", "lineJoin"]) {
    let value = null;
    Object.defineProperty(ctx, key, {
      get: () => value,
      set: (next) => {
        value = next;
        log.push(`${key}=${num(next)}`);
      },
    });
  }
  /** setupCanvas 会往 ctx 上挂装饰量，桩也要接得住 */
  ctx.metrics = null;
  return { ctx, log };
}

/** 铺满整画布的那一笔：底色一笔 + 暗幕一笔，数它就知道有没有盖遮罩 */
const fullCover = (log) => log.filter((line) => line.startsWith("fillRect(0.00,0.00,")).length;

// —— 编成表 ——

test("六关编成表全部自检通过", () => {
  assert.ok(LEVELS.length >= LEVEL_COUNT_FLOOR, "关卡数不得低于地板");
  for (let i = 0; i < LEVELS.length; i += 1) {
    assert.deepEqual(validateGroups(i), [], `第 ${i + 1} 关编成有非法项`);
  }
});

test("boss 只在最后一关，且只有一架", () => {
  for (let i = 0; i < LEVELS.length; i += 1) {
    const bosses = planFor(i).filter((entry) => entry.kind === "boss");
    assert.equal(bosses.length, i + 1 === BOSS_LEVEL ? 1 : 0, `第 ${i + 1} 关的 boss 数量不对`);
  }
  assert.equal(ENEMIES.boss.hp, 64);
  assert.deepEqual(validateGroups(LEVELS.length), [`缺少第 ${LEVELS.length + 1} 关`]);
});

test("展开计划确定且按入场时间升序", () => {
  for (let i = 0; i < LEVELS.length; i += 1) {
    assert.equal(JSON.stringify(planFor(i)), JSON.stringify(planFor(i)), `第 ${i + 1} 关两次展开结果不同`);
    const plan = planFor(i);
    for (let k = 1; k < plan.length; k += 1) assert.ok(plan[k].at >= plan[k - 1].at, "计划没有按时间排序");
  }
});

test("入场点与横向机动都不会把敌机甩出场外", () => {
  for (let i = 0; i < LEVELS.length; i += 1) {
    for (const entry of planFor(i)) {
      const spec = ENEMIES[entry.kind];
      assert.ok(entry.x >= spec.r - 1e-9 && entry.x <= FIELD.w - spec.r + 1e-9, `x 出界：${entry.kind}`);
      assert.ok(entry.x - entry.amp >= spec.r - 1e-9, `左摆出界：${entry.kind}`);
      assert.ok(entry.x + entry.amp <= FIELD.w - spec.r + 1e-9, `右摆出界：${entry.kind}`);
      assert.ok(entry.at >= 0 && Number.isFinite(entry.period) && entry.period > 0);
    }
  }
});

test("每关架数地板与递增", () => {
  const sizes = LEVELS.map((_, i) => planSize(i));
  for (const size of sizes) assert.ok(size >= 12, `某关只有 ${size} 架，太薄`);
  assert.ok(sizes[4] > sizes[0], "第 5 关应当比第 1 关更密");
  assert.equal(sizes[0], 12);
});

test("hashJitter 落在 0..1 且同输入同值", () => {
  for (let n = 0; n < 60; n += 1) {
    const v = hashJitter(n, 3);
    assert.ok(v >= 0 && v < 1, `抖动越界：${v}`);
    assert.equal(v, hashJitter(n, 3));
  }
  assert.notEqual(hashJitter(1, 1), hashJitter(2, 1));
  assert.notEqual(hashJitter(7, 1), hashJitter(7, 2));
});

// —— 三端几何 ——

test("空域三端恒 9×16，只有每单位像素不同", () => {
  const units = [];
  for (const stage of STAGES) {
    const layout = airbattleLayout(stage.viewport, stage.box);
    assert.equal(layout.device, stage.device, `${stage.name} 档位判错`);
    assert.equal(layout.orientation, stage.orientation, `${stage.name} 朝向判错`);
    assert.deepEqual(layout.view, { width: FIELD.w, height: FIELD.h }, `${stage.name} 空域被改了`);
    const ratio = layout.css.width / layout.css.height;
    assert.ok(Math.abs(ratio - FIELD.w / FIELD.h) < 0.02, `${stage.name} 长宽比跑偏：${ratio}`);
    units.push(layout.unit);
  }
  assert.equal(new Set(units.map((u) => u.toFixed(1))).size, STAGES.length, "各档每单位像素不该全同");
  assert.ok(Math.min(...units) > 20 && Math.max(...units) < 70, `unit 跨度异常：${units}`);
});

test("手机全屏舞台的画布与每单位像素地板", () => {
  const phone = STAGES[0];
  const layout = airbattleLayout(phone.viewport, phone.box);
  assert.ok(layout.css.width >= 375, `手机画布太窄：${layout.css.width}`);
  assert.ok(layout.css.height >= 640, `手机画布太矮：${layout.css.height}`);
  assert.ok(layout.unit >= 40, `手机每单位像素地板失守：${layout.unit}`);
  // 机身与 boss 在手机上都要看得见：至少 45 px 与 100 px
  assert.ok(layout.unit * SHIP.r * 2 >= 45);
  assert.ok(layout.unit * ENEMIES.boss.r * 2 >= 100);
});

test("横屏只缩小像素，不改变判定尺寸", () => {
  const portrait = airbattleLayout(STAGES[0].viewport, STAGES[0].box);
  const landscape = airbattleLayout(STAGES[1].viewport, STAGES[1].box);
  assert.deepEqual(landscape.view, portrait.view);
  assert.ok(landscape.unit < portrait.unit);
  assert.ok(landscape.unit >= 22, `横屏画布小到来不了手感：${landscape.unit}`);
  assert.ok(landscape.css.height >= 380, `横屏画布高度该吃满容器：${landscape.css.height}`);
});

test("背衬像素把 DPR 夹在 1..3", () => {
  assert.deepEqual(backingSize({ width: 100, height: 200 }), { width: 100, height: 200, dpr: 1 });
  globalThis.window = { devicePixelRatio: 7 };
  try {
    assert.equal(backingSize({ width: 100, height: 200 }).dpr, 3);
  } finally {
    delete globalThis.window;
  }
});

test("fitBoard 遇到 0 或极端容器不炸 NaN", () => {
  for (const box of [{ width: 0, height: 0 }, { width: 10, height: 4000 }, { width: 4000, height: 10 }]) {
    const css = fitBoard(box);
    assert.ok(Number.isFinite(css.width) && Number.isFinite(css.height));
    assert.ok(css.width >= 1 && css.height >= 1);
  }
  // 真实容器才谈长宽比：内接不许溢出，且比例钉死在 9:16
  for (const stage of STAGES) {
    const css = fitBoard(stage.box);
    assert.ok(css.width <= stage.box.width && css.height <= stage.box.height, `${stage.name} 画布溢出容器`);
    assert.ok(Math.abs(css.width / css.height - FIELD.w / FIELD.h) < 0.02, `${stage.name} 长宽比跑偏`);
  }
});

test("metricsFor 只给装饰量，且随 unit 单调夹取", () => {
  const small = metricsFor({ unit: 24.2, device: "phone" }, "phone");
  const large = metricsFor({ unit: 42.3, device: "desktop" }, "desktop");
  assert.ok(small.outline >= 1 && small.outline <= 2.4);
  assert.ok(large.outline <= 2.4);
  assert.ok(large.star >= small.star);
  assert.ok(large.glow >= small.glow);
  assert.ok(large.label >= 10 && large.label <= 18);
});

test("世界与屏幕坐标互逆", () => {
  const layout = desktopLayout();
  const at = worldToScreen(layout, 4.5, 9.25);
  const back = screenToWorld(layout, at.x, at.y);
  assert.ok(Math.abs(back.x - 4.5) < 1e-9);
  assert.ok(Math.abs(back.y - 9.25) < 1e-9);
  assert.equal(at.x, 4.5 * layout.unit);
});

// —— 引擎 ——

test("未开始的局不吃帧", () => {
  const game = fresh();
  assert.equal(game.status, "ready");
  game.update(FRAME);
  assert.equal(game.timeSec, 0);
  assert.equal(game.enemies.length, 0);
  game.start();
  game.update(FRAME);
  assert.ok(game.timeSec > 0);
});

test("第 1 关按编成把 12 架逐架放进场，位置全程在场内", () => {
  const game = started();
  game.shoot = () => {}; // 只验刷怪，不让子弹参战
  const spawned = [];
  const realSpawn = game.spawn.bind(game);
  game.spawn = (entry) => {
    spawned.push(entry.kind);
    return realSpawn(entry);
  };
  const plan = planFor(0);
  pump(game, 5);
  assert.equal(spawned.length, plan.filter((entry) => entry.at <= 5).length);
  pump(game, 7);
  assert.deepEqual(spawned, plan.map((entry) => entry.kind), "刷怪顺序与编成表不一致");
  for (const e of game.enemies) {
    assert.ok(e.x >= e.r - 1e-9 && e.x <= FIELD.w - e.r + 1e-9, `敌机横向出界：${e.kind} ${e.x}`);
    assert.ok(e.y > -e.r - 0.1 && e.y < FIELD.h + e.r + 0.6, `敌机纵向出界：${e.kind} ${e.y}`);
  }
});

test("悬停机不会瞬移到停止线（下降途中必须逐帧推进）", () => {
  const game = started();
  const entry = planFor(2).find((item) => item.kind === "gunner");
  game.jumpTo(2);
  game.spawn(entry);
  const gunner = game.enemies[0];
  assert.equal(gunner.y, -gunner.r, "进场必须在画面上沿之外");
  pump(game, 0.5);
  assert.ok(gunner.y > -gunner.r && gunner.y < ENEMIES.gunner.stop, `下降途中被按回了停止线：${gunner.y}`);
  pump(game, 4);
  assert.ok(gunner.stopped);
  assert.ok(Math.abs(gunner.y - ENEMIES.gunner.stop) <= 0.3, "悬停后只允许小幅起伏");
});

test("击坠计分：首杀带 1 阶连击，之后逐阶累加", () => {
  const game = started();
  const makeScout = (id) => ({ id, kind: "scout", home: 2, x: 2, y: 6, vy: 0, hp: 1, r: 0.5, score: 100, t: 0, amp: 0, period: 4, phase: 0, stopped: false, fire: 0 });
  game.damage(makeScout(1), 1);
  assert.equal(game.kills, 1);
  assert.equal(game.combo, 1);
  assert.equal(game.score, 102, "100 分 ×（1 + 2%）");
  game.damage(makeScout(2), 1);
  assert.equal(game.combo, 2);
  assert.equal(game.score, 102 + Math.round(100 * 1.04));
  assert.equal(game.maxCombo, 2);
});

test("连击加成封顶 20 阶，超时清零", () => {
  const game = started();
  game.combo = 40;
  assert.equal(game.award(100), Math.round(100 * (1 + COMBO.max * COMBO.step)));
  game.combo = 8;
  game.comboTimer = COMBO.hold;
  pump(game, COMBO.hold + 0.1);
  assert.equal(game.combo, 0);
});

test("火力档数越多打得越快越宽，但弹道不出空域", () => {
  const game = started();
  const gaps = [];
  for (let level = 1; level <= MAX_WEAPON; level += 1) {
    game.ship.weapon = level;
    gaps.push(game.fireGap());
    for (const stream of WEAPONS[level - 1].streams) {
      assert.ok(Math.abs(stream.dx) < FIELD.w / 2, `偏移量超出空域半宽：${stream.dx}`);
    }
  }
  assert.equal(gaps[0], SHIP.fireBase);
  for (let i = 1; i < gaps.length; i += 1) assert.ok(gaps[i] < gaps[i - 1], "高档火力必须更快");
  assert.equal(WEAPONS[0].streams.length, 1);
  assert.ok(WEAPONS[MAX_WEAPON - 1].streams.length >= 4);
  // 满档射击：子弹出场位置全部夹在场内
  game.ship.weapon = MAX_WEAPON;
  game.ship.x = FIELD.w - 0.2;
  game.shoot();
  for (const s of game.shots) assert.ok(s.x > 0 && s.x < FIELD.w);
});

test("火力升到上限后封顶，多余强化折算分数", () => {
  const game = started();
  const before = game.score;
  for (let i = 0; i < MAX_WEAPON + 2; i += 1) {
    game.spawnItem("power", 4.5);
    const item = game.items[game.items.length - 1];
    item.x = game.ship.x;
    item.y = game.ship.y;
    game.collide();
  }
  assert.equal(game.ship.weapon, MAX_WEAPON);
  assert.ok(game.score > before, "满档后强化道具要折算成分数");
});

test("维修补到上限，炸弹补到上限，满员时折算分数", () => {
  const game = started();
  const before = game.score;
  game.ship.hp = 1;
  for (let i = 0; i < SHIP.hpMax + 1; i += 1) {
    game.spawnItem("repair", game.ship.x);
    game.items[game.items.length - 1].y = game.ship.y;
    game.collide();
  }
  assert.equal(game.ship.hp, SHIP.hpMax);
  for (let i = 0; i < SHIP.bombsMax + 1; i += 1) {
    game.spawnItem("bomb", game.ship.x);
    game.items[game.items.length - 1].y = game.ship.y;
    game.collide();
  }
  assert.equal(game.ship.bombs, SHIP.bombsMax);
  assert.ok(game.score > before);
});

test("中弹掉血并在无敌期内免疫，无敌结束后再中再掉", () => {
  const game = started();
  const hp = game.ship.hp;
  assert.equal(game.hurt(1, "shot"), true);
  assert.equal(game.ship.hp, hp - 1);
  assert.equal(game.hurt(1, "shot"), false, "无敌期内不该再掉血");
  game.ship.invuln = 0;
  game.hurt(1, "shot");
  assert.equal(game.ship.hp, hp - 2);
  assert.equal(game.combo, 0, "挨打要断连击");
});

test("生命归零判负并记下坠毁原因", () => {
  const game = started();
  game.ship.hp = 1;
  game.ship.invuln = 0;
  pump(game, 1);
  const time = game.timeSec;
  game.hurt(1, "ram");
  assert.equal(game.status, "over");
  assert.equal(game.death, "ram");
  assert.equal(game.ship.hp, 0);
  pump(game, 1);
  assert.equal(game.timeSec, time, "坠机后不再推进");
});

test("撞击不是白撞：撞机身敌机自己也掉 3 点血", () => {
  const game = started();
  game.ship.invuln = 0;
  const enemy = { id: 9, kind: "scout", home: 4, x: game.ship.x, y: game.ship.y, vy: 0, hp: ENEMIES.scout.hp, r: ENEMIES.scout.r, score: 100, t: 0, amp: 0, period: 4, phase: 0, stopped: true, fire: 0 };
  game.enemies.push(enemy);
  game.collide();
  assert.equal(game.ship.hp, SHIP.hpStart - 1);
  assert.equal(enemy.hp, ENEMIES.scout.hp - 3);
  assert.equal(game.enemies.length, 0, "撞完的侦察机该被清场");
});

test("炸弹：清空敌弹、全场受伤、次数递减，没弹不许放", () => {
  const game = started();
  game.eshots.push({ id: 1, x: 3, y: 8, vx: 0, vy: 5 });
  game.enemies.push({ id: 2, kind: "gunner", home: 4, x: 4, y: 8, vy: 0, hp: 99, r: 0.78, score: 320, t: 0, amp: 0, period: 4, phase: 0, stopped: true, fire: 0 });
  const before = game.ship.bombs;
  assert.equal(game.bomb(), true);
  assert.equal(game.eshots.length, 0);
  assert.equal(game.enemies[0].hp, 99 - BOMB.dmg);
  assert.equal(game.ship.bombs, before - 1);
  assert.ok(game.ship.invuln >= BOMB.invuln);
  assert.ok(game.flash > 0);
  game.ship.bombs = 0;
  assert.equal(game.bomb(), false, "没有炸弹不许放");
  game.ship.bombs = 1;
  game.status = "paused";
  assert.equal(game.bomb(), false, "暂停中不许放");
});

test("掉落只由击坠序号派生：同序号同结果", () => {
  const drops = [];
  const game = started();
  for (let i = 0; i < 40; i += 1) {
    const enemy = { id: i + 1, kind: "fighter", x: 4, y: 4, hp: 1, r: 0.62, score: 220, dead: false };
    game.damage(enemy, 1);
    drops.push(game.items.length ? game.items[game.items.length - 1].kind : null);
    game.items.length = 0;
  }
  const again = [];
  const game2 = started();
  for (let i = 0; i < 40; i += 1) {
    game2.damage({ id: i + 1, kind: "fighter", x: 4, y: 4, hp: 1, r: 0.62, score: 220, dead: false }, 1);
    again.push(game2.items.length ? game2.items[game2.items.length - 1].kind : null);
    game2.items.length = 0;
  }
  assert.deepEqual(drops, again);
  assert.ok(drops.some((kind) => kind !== null), "40 架一个道具都不掉，掉落逻辑没生效");
  assert.ok(drops.filter((kind) => kind === null).length > drops.filter((kind) => kind !== null).length, "掉落太密就不是捡东西了");
});

test("暂停冻结状态，恢复后继续推进", () => {
  const game = started();
  pump(game, 2);
  const snapshot = JSON.stringify({ score: game.score, enemies: game.enemies, time: game.timeSec });
  game.togglePause();
  assert.equal(game.status, "paused");
  pump(game, 3);
  assert.equal(JSON.stringify({ score: game.score, enemies: game.enemies, time: game.timeSec }), snapshot);
  game.togglePause();
  pump(game, 1);
  assert.notEqual(JSON.stringify({ score: game.score, enemies: game.enemies, time: game.timeSec }), snapshot);
});

test("拖拽目标点夹在空域内，且只有下半屏可以飞", () => {
  const game = started();
  game.drag(-99, -99);
  assert.equal(game.target.x, SHIP.r);
  assert.equal(game.target.y, FIELD.h * 0.42);
  game.drag(999, 999);
  assert.equal(game.target.x, FIELD.w - SHIP.r);
  assert.equal(game.target.y, FIELD.h - SHIP.r);
  pump(game, 1.2);
  assert.ok(game.ship.x >= SHIP.r - 1e-9 && game.ship.x <= FIELD.w - SHIP.r + 1e-9);
  assert.ok(game.ship.y <= FIELD.h - SHIP.r + 1e-9);
});

test("键盘轴归零后飞机停住，输入夹在 -1..1", () => {
  const game = started();
  game.setAxis(-1, 0);
  pump(game, 0.5);
  assert.ok(game.ship.x < FIELD.w / 2);
  game.setAxis(0, 0);
  const stopped = game.ship.x;
  pump(game, 0.5);
  assert.equal(game.ship.x, stopped);
  game.setAxis(9, 9);
  assert.equal(game.axis.x, 1);
  assert.equal(game.axis.y, 1);
});

test("过关推进：清空本关进下一关", () => {
  const game = started();
  assert.equal(game.level, 0);
  game.cursor = game.plan.length;
  game.enemies.length = 0;
  game.update(FRAME);
  assert.equal(game.level, 1);
  assert.equal(game.cursor, 0);
  assert.equal(game.waveTime, 0);
  assert.equal(game.banner.text, `第 2 关 · ${LEVELS[1].name}`);
});

test("母舰清空即通关，并按剩余生命与炸弹结算奖励", () => {
  const game = started();
  game.jumpTo(LEVELS.length - 1);
  game.ship.invuln = Infinity; // 通关判定不该被最后一发流弹打断
  game.waveTime = 1e4;
  game.release();
  assert.equal(game.cursor, game.plan.length);
  assert.ok(game.enemies.some((e) => e.kind === "boss"), "最后一关必须真的刷出母舰");
  for (const enemy of [...game.enemies]) game.damage(enemy, 9999);
  game.update(FRAME);
  assert.equal(game.status, "won");
  assert.equal(game.bonus, game.ship.hp * 800 + game.ship.bombs * 400);
  assert.ok(game.score > game.bonus);
});

test("jumpTo 换关会清场、带横幅并夹住越界索引", () => {
  const game = started();
  game.enemies.push({ id: 3, kind: "scout", home: 1, x: 1, y: 3, vy: 1, hp: 1, r: 0.5, score: 100, t: 0, amp: 0, period: 4, phase: 0, stopped: false, fire: 0 });
  game.jumpTo(2);
  assert.equal(game.level, 2);
  assert.equal(game.enemies.length, 0);
  assert.equal(game.eshots.length, 0);
  assert.equal(game.waveTime, 0);
  assert.ok(game.banner.text.includes(LEVELS[2].name));
  game.jumpTo(99);
  assert.equal(game.level, LEVELS.length - 1);
  game.jumpTo(-5);
  assert.equal(game.level, 0);
});

test("连打 60 秒不出 NaN，实体池有上界", () => {
  const game = started();
  let peakShots = 0;
  let peakFx = 0;
  for (let i = 0; i < 60 * 60; i += 1) {
    if (i % 90 === 0) game.drag((hashJitter(i, 2) - 0.5) * 2, (hashJitter(i, 4) - 0.5) * 0.4);
    if (i % 600 === 0) game.bomb();
    game.update(FRAME);
    peakShots = Math.max(peakShots, game.shots.length);
    peakFx = Math.max(peakFx, game.fx.length);
    if (game.status === "over" || game.status === "won") break;
  }
  assert.ok(Number.isFinite(game.ship.x) && Number.isFinite(game.ship.y));
  for (const e of game.enemies) assert.ok(Number.isFinite(e.x) && Number.isFinite(e.y) && e.x >= 0);
  for (const s of game.shots) assert.ok(Number.isFinite(s.x) && Number.isFinite(s.y));
  assert.ok(peakShots < 80, `子弹池失控：${peakShots}`);
  assert.ok(peakFx < 60, `特效池失控：${peakFx}`);
});

test("hud 报出关卡、剩余架数与上下限", () => {
  const game = started();
  pump(game, 3);
  const hud = game.hud();
  assert.equal(hud.level, 1);
  assert.equal(hud.levels, LEVELS.length);
  assert.equal(hud.hpMax, SHIP.hpMax);
  assert.equal(hud.weaponMax, MAX_WEAPON);
  assert.equal(hud.bombsMax, SHIP.bombsMax);
  assert.equal(hud.remaining, game.remaining());
  assert.ok(hud.remaining > 0);
  assert.equal(hud.levelName, LEVELS[0].name);
});

// —— 渲染 ——

test("同一帧画两次逐笔一致，且渲染不写状态", () => {
  const game = started();
  game.ship.invuln = 0.5;
  game.flash = 0.4;
  pump(game, 6);
  game.spawnItem("power", 3);
  game.spawnItem("repair", 5);
  game.bomb();
  const layout = desktopLayout();
  const state = JSON.stringify(game);
  const a = makeCtx();
  const b = makeCtx();
  draw(a.ctx, game, layout, 1234);
  draw(b.ctx, game, layout, 1234);
  assert.deepEqual(a.log, b.log);
  assert.ok(a.log.length > 120, `这一帧只画了 ${a.log.length} 笔，多半漏了实体`);
  assert.equal(JSON.stringify(game), state, "渲染层写状态了");
});

test("四种停局状态都压一层暗幕，局内不压，坠机后不再画机身", () => {
  const layout = desktopLayout();
  const game = started();
  pump(game, 4);
  game.flash = 0;
  const playing = makeCtx();
  draw(playing.ctx, game, layout, 100);
  assert.equal(fullCover(playing.log), 1, "局内不该有暗幕");
  for (const state of ["ready", "paused", "over", "won"]) {
    const probe = makeCtx();
    game.status = state;
    draw(probe.ctx, game, layout, 100);
    assert.equal(fullCover(probe.log), 2, `${state} 没有盖暗幕`);
  }
  const afterDeath = makeCtx();
  game.status = "over";
  draw(afterDeath.ctx, game, layout, 100);
  assert.ok(!afterDeath.log.includes("fillStyle=#dff2ff"), "坠机后不该再画机身");
});

// —— 输入层 ——

function makeTarget(name) {
  const handlers = new Map();
  return {
    name,
    addEventListener(type, handler) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(handler);
    },
    removeEventListener(type, handler) {
      handlers.set(type, (handlers.get(type) ?? []).filter((fn) => fn !== handler));
    },
    emit(type, event = {}) {
      for (const fn of [...(handlers.get(type) ?? [])]) {
        fn({ type, preventDefault: () => {}, ...event });
      }
    },
    listenerCount: (type) => (handlers.get(type) ?? []).length,
  };
}

function inputHarness() {
  const canvas = Object.assign(makeTarget("canvas"), {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 380, height: 676 }),
  });
  const win = makeTarget("window");
  const calls = { drags: [], axes: [], actions: [] };
  globalThis.window = win;
  const input = bindInput({
    canvas,
    getUnit: () => 40,
    onDrag: (dx, dy) => calls.drags.push([Number(dx.toFixed(3)), Number(dy.toFixed(3))]),
    onAxis: (x, y) => calls.axes.push([x, y]),
    onAction: (name) => calls.actions.push(name),
  });
  return { canvas, win, calls, input, dispose: () => delete globalThis.window };
}

test("输入层：拖动只报单位增量，越过阈值才开始跟手", () => {
  const h = inputHarness();
  try {
    h.canvas.emit("pointerdown", { pointerId: 1, pointerType: "touch", clientX: 100, clientY: 100 });
    h.canvas.emit("pointermove", { pointerId: 1, pointerType: "touch", clientX: 110, clientY: 100 });
    assert.equal(h.calls.drags.length, 0, "10 px 还在轻点容差内，不该算拖动");
    h.canvas.emit("pointermove", { pointerId: 1, pointerType: "touch", clientX: 140, clientY: 110 });
    assert.deepEqual(h.calls.drags, [[1, 0.25]], "40 px / unit 40 = 1 单位");
    h.canvas.emit("pointermove", { pointerId: 2, clientX: 300, clientY: 300 });
    assert.equal(h.calls.drags.length, 1, "别的指针不该插进来");
    h.win.emit("pointerup", { pointerId: 1, clientX: 140, clientY: 110 });
    assert.equal(h.calls.actions.length, 0, "拖动过的抬手不是轻点");
    h.canvas.emit("pointermove", { pointerId: 1, clientX: 200, clientY: 200 });
    assert.equal(h.calls.drags.length, 1, "抬手后再动不该继续跟手");
  } finally {
    h.dispose();
  }
});

test("输入层：轻点给 primary，键盘轴按下合成、抬起与失焦归零", () => {
  const h = inputHarness();
  try {
    h.canvas.emit("pointerdown", { pointerId: 5, pointerType: "mouse", clientX: 60, clientY: 60 });
    h.win.emit("pointerup", { pointerId: 5, pointerType: "mouse", clientX: 61, clientY: 60 });
    assert.deepEqual(h.calls.actions, ["primary"]);
    h.win.emit("keydown", { key: "ArrowLeft" });
    h.win.emit("keydown", { key: "d" });
    assert.deepEqual(h.calls.axes.slice(-2), [[-1, 0], [0, 0]]);
    h.win.emit("keyup", { key: "ArrowLeft" });
    assert.deepEqual(h.calls.axes[h.calls.axes.length - 1], [1, 0]);
    h.win.emit("keyup", { key: "d" });
    assert.deepEqual(h.calls.axes[h.calls.axes.length - 1], [0, 0]);
    h.win.emit("keydown", { key: "s" });
    h.win.emit("blur", {});
    assert.deepEqual(h.calls.axes[h.calls.axes.length - 1], [0, 0], "失焦必须归零");
    h.win.emit("keydown", { key: "b" });
    h.win.emit("keydown", { key: "Shift" });
    h.win.emit("keydown", { key: "p" });
    h.win.emit("keydown", { key: "r" });
    h.win.emit("keydown", { key: "m" });
    assert.deepEqual(h.calls.actions.slice(-5), ["bomb", "bomb", "pause", "restart", "mute"]);
    h.win.emit("keydown", { key: "k" });
    assert.equal(h.calls.actions.length, 6, "无关按键不该产出动作");
  } finally {
    h.dispose();
  }
});

test("输入层返回 { unbind }，解绑后监听清空且不再回调", () => {
  const h = inputHarness();
  try {
    assert.equal(typeof h.input.unbind, "function");
    assert.ok(h.canvas.listenerCount("pointerdown") > 0);
    h.input.unbind();
    assert.equal(h.canvas.listenerCount("pointerdown"), 0);
    assert.equal(h.win.listenerCount("keydown"), 0);
    assert.equal(h.win.listenerCount("keyup"), 0);
    assert.equal(h.win.listenerCount("blur"), 0);
    h.canvas.emit("pointerdown", { pointerId: 1, clientX: 10, clientY: 10 });
    h.canvas.emit("pointermove", { pointerId: 1, clientX: 200, clientY: 300 });
    assert.equal(h.calls.drags.length, 0);
  } finally {
    h.dispose();
  }
});

test("输入层：pointercancel 立即停手，不留下半个拖动", () => {
  const h = inputHarness();
  try {
    h.canvas.emit("pointerdown", { pointerId: 3, pointerType: "touch", clientX: 100, clientY: 100 });
    h.canvas.emit("pointermove", { pointerId: 3, pointerType: "touch", clientX: 160, clientY: 100 });
    h.win.emit("pointercancel", { pointerId: 3 });
    h.canvas.emit("pointermove", { pointerId: 3, pointerX: 300, clientY: 300 });
    assert.equal(h.calls.drags.length, 1);
    h.win.emit("pointerup", { pointerId: 3, clientX: 300, clientY: 300 });
    assert.equal(h.calls.actions.length, 0, "取消之后的抬手不该算轻点");
  } finally {
    h.dispose();
  }
});

// —— 源码扫描 ——

test("引擎与几何不许调用 Math.random，game.js 不许读时钟", () => {
  const dir = "src/games/airbattle/";
  for (const file of ["field.js", "waves.js", "layout.js", "game.js", "renderer.js", "input.js", "audio.js"]) {
    const src = readFileSync(new URL(`../${dir}${file}`, import.meta.url), "utf8");
    // 带括号才算调用：注释里"不许 Math.random"这句话不该把自己抓出来
    assert.ok(!src.includes("Math.random("), `${file} 里调用了 Math.random`);
    assert.ok(!src.includes("requestAnimationFrame("), `${file} 不该自己挂主循环`);
    assert.ok(!/localStorage\s*[.[]/.test(src), `${file} 不许直接读写 localStorage`);
    assert.ok(!/from ["']vue["']/.test(src), `${file} 属于引擎层，不许依赖 Vue`);
  }
  const engine = readFileSync(new URL(`../${dir}game.js`, import.meta.url), "utf8");
  assert.ok(!engine.includes("Date.now("), "引擎只认传入的 dt，不许读墙钟");
  assert.ok(!engine.includes("performance."), "同上：跨上下文比时间会算出负 dt");
});
