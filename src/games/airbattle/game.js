/**
 * 「飞机大战」状态机：全部跑在 9×16 的逻辑单位里，不含任何 DOM / Canvas / 框架依赖。
 *
 * 三条设计约束（踩过坑的都在注释里）：
 * 1. **确定性**：不读 Math.random、不读 Date、不读 performance。刷怪计划来自 waves.js 的
 *    手写编成，机动相位与掉落来自整数序号经 hashJitter 派生 —— 喂同样的帧必然得到同样的局，
 *    单测可以把"第几秒出现什么"钉成断言。
 * 2. **设备无关**：速度一律"单位/秒"。resize() 只登记档位，不参与任何判定，
 *    所以手机旋转/切窗口不会改变一关的难度。
 * 3. **单一时间源**：一切推进都走 update(dt)，视图里 rAF / Worker / 看门狗三条驱动源
 *    共用同一条 pump，谁先到都只按真实流逝推进（见 docs/rules/game-module.md）。
 */

import {
  BOMB,
  COMBO,
  ENEMIES,
  ENEMY_SHOT,
  FIELD,
  ITEMS,
  MAX_WEAPON,
  RAM,
  SHIP,
  SHOT,
  WEAPONS,
  clamp,
  hashJitter,
} from "./field.js";
import { LEVELS, planFor } from "./waves.js";

const clampDt = (dt) => Math.max(0, Math.min(0.05, Number(dt) || 0));

export class Airbattle {
  constructor({ onSound = () => {}, device = "desktop", orientation = "portrait" } = {}) {
    this.onSound = onSound;
    this.device = device;
    this.orientation = orientation;
    this.reset();
  }

  reset() {
    this.status = "ready";
    this.seq = 1;
    this.timeSec = 0;
    this.level = 0;
    this.plan = planFor(0);
    this.cursor = 0;
    this.waveTime = 0;
    this.score = 0;
    this.kills = 0;
    this.bonus = 0;
    this.combo = 0;
    this.comboTimer = 0;
    this.maxCombo = 0;
    this.banner = null;
    this.flash = 0;
    this.death = null;
    this.axis = { x: 0, y: 0 };
    this.ship = {
      x: FIELD.w / 2,
      y: SHIP.startY,
      hp: SHIP.hpStart,
      bombs: SHIP.bombsStart,
      weapon: 1,
      invuln: 0,
      fireTimer: 0.35,
    };
    this.target = { x: this.ship.x, y: this.ship.y };
    this.shots = [];
    this.eshots = [];
    this.enemies = [];
    this.items = [];
    this.fx = [];
    return this;
  }

  start() {
    if (this.status === "ready") this.status = "playing";
    return this.status;
  }

  togglePause() {
    if (this.status === "playing") this.status = "paused";
    else if (this.status === "paused") this.status = "playing";
    return this.status;
  }

  /**
   * 档位变化只登记，不改判定：逻辑场地三端恒 9×16。
   * 视图在 ResizeObserver 里调用它，与另外几款同名 API 对齐。
   */
  resize({ device = this.device, orientation = this.orientation } = {}) {
    this.device = device;
    this.orientation = orientation;
    return this;
  }

  /** 拖动：输入层已经把像素换算成单位，这里只挪目标点并夹在场内 */
  drag(dxUnits, dyUnits) {
    if (this.status !== "playing") return false;
    this.clampTarget(this.target.x + dxUnits, this.target.y + dyUnits);
    return true;
  }

  /** 键盘轴：-1..1 的连续量，视图卸载前必须再喂一次 (0,0) 归零 */
  setAxis(x, y) {
    this.axis.x = clamp(Number(x) || 0, -1, 1);
    this.axis.y = clamp(Number(y) || 0, -1, 1);
  }

  clampTarget(x, y) {
    this.target.x = clamp(x, SHIP.r, FIELD.w - SHIP.r);
    this.target.y = clamp(y, FIELD.h * 0.42, FIELD.h - SHIP.r);
  }

  /** 投弹：全屏伤害 + 清空敌弹 + 短无敌。没有炸弹或不在游戏中一律不放 */
  bomb() {
    if (this.status !== "playing" || this.ship.bombs <= 0) return false;
    this.ship.bombs -= 1;
    this.ship.invuln = Math.max(this.ship.invuln, BOMB.invuln);
    this.flash = BOMB.flash;
    this.eshots.length = 0;
    for (const enemy of [...this.enemies]) this.damage(enemy, BOMB.dmg);
    this.onSound("bomb");
    return true;
  }

  /**
   * 直接跳到某一关（单测与 DEV 验收用）：打满六关要喂几分钟的帧，
   * 不该靠自然推进去验证 boss 与通关结算。清空在场实体，其余状态不动。
   */
  jumpTo(index) {
    const target = clamp(Math.floor(Number(index) || 0), 0, LEVELS.length - 1);
    this.level = target;
    this.plan = planFor(target);
    this.cursor = 0;
    this.waveTime = 0;
    this.enemies.length = 0;
    this.eshots.length = 0;
    this.items.length = 0;
    this.banner = { text: `第 ${target + 1} 关 · ${LEVELS[target].name}`, t: 2 };
    return this.status;
  }

  update(deltaSeconds) {
    if (this.status !== "playing") return;
    const dt = clampDt(deltaSeconds);
    if (dt === 0) return;
    this.timeSec += dt;
    this.waveTime += dt;
    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt);
    if (this.banner) {
      this.banner.t -= dt;
      if (this.banner.t <= 0) this.banner = null;
    }
    this.release();
    this.stepShip(dt);
    this.stepShots(dt);
    this.stepEnemies(dt);
    this.stepEnemyShots(dt);
    this.stepItems(dt);
    this.stepFx(dt);
    this.collide();
    this.ageCombo(dt);
    this.checkProgress();
  }

  /** 到点的编成逐架进场 */
  release() {
    while (this.cursor < this.plan.length && this.plan[this.cursor].at <= this.waveTime) {
      this.spawn(this.plan[this.cursor]);
      this.cursor += 1;
    }
  }

  spawn(entry) {
    const spec = ENEMIES[entry.kind];
    this.enemies.push({
      id: this.seq++,
      kind: entry.kind,
      home: entry.x,
      x: entry.x,
      y: -spec.r,
      vy: spec.vy,
      hp: spec.hp,
      r: spec.r,
      score: spec.score,
      t: 0,
      amp: entry.amp,
      period: entry.period,
      phase: entry.phase,
      stopped: false,
      // 首发射击错开，避免整组同时开火形成一堵墙；错位量由编成序号派生
      fire: spec.fire ? spec.fire * (0.55 + hashJitter(entry.index, 5) * 0.6) : 0,
    });
  }

  stepShip(dt) {
    const ship = this.ship;
    if (ship.invuln > 0) ship.invuln = Math.max(0, ship.invuln - dt);
    if (this.axis.x || this.axis.y) {
      this.clampTarget(
        this.target.x + this.axis.x * SHIP.speed * dt,
        this.target.y + this.axis.y * SHIP.speed * dt
      );
    }
    // 机身向目标点靠拢，单帧最多走 speed*dt：这样拖动再快也不会瞬移穿弹
    const maxStep = SHIP.speed * dt;
    ship.x += clamp(this.target.x - ship.x, -maxStep, maxStep);
    ship.y += clamp(this.target.y - ship.y, -maxStep, maxStep);

    ship.fireTimer -= dt;
    while (ship.fireTimer <= 0) {
      this.shoot();
      ship.fireTimer += this.fireGap();
    }
  }

  fireGap() {
    return SHIP.fireBase * WEAPONS[this.ship.weapon - 1].gap;
  }

  shoot() {
    const weapon = WEAPONS[this.ship.weapon - 1];
    for (const stream of weapon.streams) {
      this.shots.push({
        id: this.seq++,
        x: clamp(this.ship.x + stream.dx, 0.1, FIELD.w - 0.1),
        y: this.ship.y - 0.55,
        vx: stream.vx,
        vy: -SHOT.speed,
        dmg: SHOT.dmg,
      });
    }
  }

  stepShots(dt) {
    for (const s of this.shots) {
      s.x += s.vx * dt;
      s.y += s.vy * dt;
    }
    this.shots = this.shots.filter((s) => s.y > -1 && s.x > -0.5 && s.x < FIELD.w + 0.5);
  }

  stepEnemies(dt) {
    for (const e of this.enemies) {
      e.t += dt;
      const spec = ENEMIES[e.kind];
      if (spec.stop && !e.stopped) {
        e.y += e.vy * dt;
        if (e.y >= spec.stop) {
          e.y = spec.stop;
          e.stopped = true;
        }
      }
      const swing = Math.sin((e.t / e.period) * Math.PI * 2 + e.phase) * e.amp;
      e.x = clamp(e.home + swing, e.r, FIELD.w - e.r);
      // 只有真的落到停止线之后才做悬停起伏，否则这里会把下降途中的 y 直接按回停止线（瞬移 bug）
      if (e.stopped && spec.stop) {
        e.y = spec.stop + Math.sin(e.t * 0.9 + e.phase) * 0.3;
      }
      if (spec.fire) {
        e.fire -= dt;
        if (e.fire <= 0 && e.y > 0) {
          this.enemyFire(e);
          e.fire = spec.fire;
        }
      }
    }
    // 飞出下沿的敌机直接离场：不扣分，但会白白放走掉落机会
    this.enemies = this.enemies.filter((e) => !e.dead && e.y < FIELD.h + e.r + 0.6);
  }

  enemyFire(e) {
    const spec = ENEMIES[e.kind];
    const push = (angle) => {
      this.eshots.push({
        id: this.seq++,
        x: clamp(e.x, e.r, FIELD.w - e.r),
        y: e.y + e.r * 0.6,
        vx: Math.sin(angle) * ENEMY_SHOT.speed,
        vy: Math.cos(angle) * ENEMY_SHOT.speed,
      });
    };
    // 瞄准角：正下方为 0，向右为正
    const aim = Math.atan2(this.ship.x - e.x, Math.max(0.3, this.ship.y - e.y));
    if (e.kind === "bomber") {
      push(aim * 0.35 - 0.18);
      push(aim * 0.35 + 0.18);
    } else if (e.kind === "boss") {
      push(aim - 0.32);
      push(aim);
      push(aim + 0.32);
    } else {
      push(aim);
    }
    this.onSound(spec === ENEMIES.boss ? "boom" : "click");
  }

  stepEnemyShots(dt) {
    for (const s of this.eshots) {
      s.x += s.vx * dt;
      s.y += s.vy * dt;
    }
    this.eshots = this.eshots.filter(
      (s) => s.y < FIELD.h + 1 && s.y > -1 && s.x > -0.6 && s.x < FIELD.w + 0.6
    );
  }

  stepItems(dt) {
    for (const item of this.items) {
      item.t += dt;
      item.y += ITEMS[item.kind].vy * dt;
    }
    this.items = this.items.filter((i) => i.y < FIELD.h + 1 && !i.taken);
  }

  stepFx(dt) {
    for (const f of this.fx) f.t += dt;
    this.fx = this.fx.filter((f) => f.t < f.life);
  }

  boom(x, y, big, seed) {
    // r 由引擎带进特效：渲染层不许为了算半径回头查实体
    this.fx.push({ kind: big ? "bigboom" : "boom", x, y, t: 0, life: big ? 0.7 : 0.42, seed, r: big ? 1.1 : 0.62 });
  }

  collide() {
    for (const shot of this.shots) {
      if (shot.dead) continue;
      for (const enemy of this.enemies) {
        if (enemy.dead) continue;
        if (Math.hypot(shot.x - enemy.x, shot.y - enemy.y) <= enemy.r + SHOT.r) {
          shot.dead = true;
          this.damage(enemy, shot.dmg);
          break;
        }
      }
    }
    this.shots = this.shots.filter((s) => !s.dead);

    for (const s of this.eshots) {
      if (Math.hypot(s.x - this.ship.x, s.y - this.ship.y) <= SHIP.r + ENEMY_SHOT.r) {
        s.dead = true;
        this.hurt(RAM.shipDamage, "shot");
      }
    }
    this.eshots = this.eshots.filter((s) => !s.dead);

    for (const enemy of this.enemies) {
      if (enemy.dead) continue;
      if (Math.hypot(enemy.x - this.ship.x, enemy.y - this.ship.y) <= enemy.r + SHIP.r) {
        this.hurt(RAM.shipDamage, "ram");
        this.damage(enemy, RAM.enemyDamage);
      }
    }

    for (const item of this.items) {
      if (item.taken) continue;
      if (Math.hypot(item.x - this.ship.x, item.y - this.ship.y) <= item.r + SHIP.r + 0.15) {
        item.taken = true;
        this.pickup(item);
      }
    }
    this.items = this.items.filter((i) => !i.taken);
    this.enemies = this.enemies.filter((e) => !e.dead);
  }

  damage(enemy, dmg) {
    if (!enemy || enemy.dead) return false;
    enemy.hp -= dmg;
    if (enemy.hp > 0) {
      this.onSound("hit");
      return false;
    }
    enemy.dead = true;
    this.kills += 1;
    this.combo += 1;
    this.comboTimer = COMBO.hold;
    this.maxCombo = Math.max(this.maxCombo, this.combo);
    this.score += this.award(enemy.score);
    this.boom(enemy.x, enemy.y, enemy.kind === "boss" || enemy.kind === "bomber", enemy.id);
    this.drop(enemy);
    this.onSound(enemy.kind === "boss" ? "bigboom" : "boom");
    return true;
  }

  /** 连击加成：每阶 +2%，封顶 20 阶，取整保证分数永远是整数 */
  award(base) {
    const step = Math.min(this.combo, COMBO.max) * COMBO.step;
    return Math.round(base * (1 + step));
  }

  ageCombo(dt) {
    if (this.comboTimer > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) this.combo = 0;
    }
  }

  /** 掉落完全由"这是本场第几架被击坠"派生，不读随机 */
  drop(enemy) {
    const spec = ENEMIES[enemy.kind];
    if (enemy.kind !== "boss" && hashJitter(this.kills, 17) > spec.drop) return;
    const kinds = Object.keys(ITEMS);
    if (enemy.kind === "boss") {
      this.spawnItem("power", enemy.x - 0.6);
      this.spawnItem("bomb", enemy.x + 0.6);
      return;
    }
    const roll = hashJitter(this.kills, 23);
    const kind = roll < 0.5 ? kinds[0] : roll < 0.8 ? kinds[1] : kinds[2];
    this.spawnItem(kind, enemy.x);
  }

  spawnItem(kind, x) {
    const spec = ITEMS[kind];
    this.items.push({
      id: this.seq++,
      kind,
      x: clamp(x, spec.r, FIELD.w - spec.r),
      y: 0,
      r: spec.r,
      t: 0,
      taken: false,
    });
  }

  pickup(item) {
    const spec = ITEMS[item.kind];
    if (item.kind === "power") {
      if (this.ship.weapon < MAX_WEAPON) {
        this.ship.weapon += 1;
        this.banner = { text: `火力 ${this.ship.weapon} 档`, t: 1.1 };
        this.onSound("power");
        return;
      }
    } else if (item.kind === "repair") {
      if (this.ship.hp < SHIP.hpMax) {
        this.ship.hp += 1;
        this.onSound("power");
        return;
      }
    } else if (item.kind === "bomb") {
      if (this.ship.bombs < SHIP.bombsMax) {
        this.ship.bombs += 1;
        this.onSound("power");
        return;
      }
    }
    // 已满级时折算成分数，掉落不吃亏
    this.score += spec.score;
    this.onSound("click");
  }

  hurt(amount, reason) {
    if (this.status !== "playing" || this.ship.invuln > 0) return false;
    this.ship.hp -= amount;
    this.ship.invuln = SHIP.invuln;
    this.combo = 0;
    this.fx.push({ kind: "spark", x: this.ship.x, y: this.ship.y, t: 0, life: 0.3, seed: this.seq++, r: SHIP.r });
    if (this.ship.hp <= 0) {
      this.ship.hp = 0;
      this.death = reason;
      this.status = "over";
      this.boom(this.ship.x, this.ship.y, true, this.seq++);
      this.onSound("over");
    } else {
      this.onSound("hurt");
    }
    return true;
  }

  checkProgress() {
    if (this.status !== "playing") return;
    if (this.cursor < this.plan.length || this.enemies.length) return;
    if (this.level + 1 >= LEVELS.length) {
      this.bonus = this.ship.hp * 800 + this.ship.bombs * 400;
      this.score += this.bonus;
      this.status = "won";
      this.onSound("win");
      return;
    }
    this.level += 1;
    this.plan = planFor(this.level);
    this.cursor = 0;
    this.waveTime = 0;
    this.banner = { text: `第 ${this.level + 1} 关 · ${LEVELS[this.level].name}`, t: 2 };
    this.onSound("wave");
  }

  /** 本关还剩几架（未进场 + 在场） */
  remaining() {
    return this.plan.length - this.cursor + this.enemies.length;
  }

  hud() {
    return {
      score: this.score,
      level: this.level + 1,
      levels: LEVELS.length,
      levelName: LEVELS[this.level].name,
      hp: this.ship.hp,
      hpMax: SHIP.hpMax,
      bombs: this.ship.bombs,
      bombsMax: SHIP.bombsMax,
      weapon: this.ship.weapon,
      weaponMax: MAX_WEAPON,
      combo: this.combo,
      kills: this.kills,
      remaining: this.remaining(),
      banner: this.banner ? this.banner.text : null,
      seconds: Math.floor(this.timeSec),
    };
  }
}
