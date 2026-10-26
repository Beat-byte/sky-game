import { FIELD, metricsFor } from "./layout.js";
import { LEVELS, buildBricks, brickScore } from "./levels.js";
import {
  bounceAgainstRect,
  bounceOffWalls,
  clamp,
  comboMultiplier,
  enforceMinVerticalAngle,
  normalizeSpeed,
  overlaps,
  paddleBounce,
  paddleOffsetRatio,
  stepScale,
} from "./physics.js";
import { makePowerup, powerupDuration, rollDrop } from "./powerups.js";

function makeBall(metrics, x, y) {
  const size = metrics.ball;
  return { x, y, w: size, h: size, vx: 0, vy: 0, stuck: true, offset: 0 };
}

export class Game {
  constructor({ rng = Math.random, onSound = () => {} } = {}) {
    this.rng = rng;
    this.onSound = onSound;
    this.best = 0;
    this.metrics = metricsFor(FIELD);
    this.reset();
  }

  reset() {
    this.levelIndex = 0;
    this.score = 0;
    this.lives = 3;
    this.status = "ready";
    this.combo = 1;
    this.shake = 0;
    this.loadLevel(0);
  }

  /** 场地顶部空白：HUD 之下到第一行砖块之间 */
  spawnBallX() {
    return this.paddle.x + this.paddle.w / 2;
  }

  loadLevel(index) {
    const level = LEVELS[index];
    this.level = level;
    this.levelIndex = index;
    this.baseSpeed = level.speed;
    this.metrics = metricsFor(FIELD);
    this.fieldWidth = FIELD.width;
    this.fieldHeight = FIELD.height;
    this.bricks = buildBricks(level);
    this.paddle = {
      x: (FIELD.width - this.metrics.paddleW) / 2,
      y: FIELD.height - this.metrics.paddleLift,
      w: this.metrics.paddleW,
      h: this.metrics.paddleH,
    };
    this.resetBall();
    this.powerups = [];
    this.particles = [];
    this.effects = {};
    this.combo = 1;
  }

  resetBall() {
    const m = this.metrics;
    this.balls = [makeBall(m, this.spawnBallX() - m.ball / 2, this.paddle.y - m.ball - 2)];
  }

  /**
   * 视口/档位变化后按新场地重排：保留砖块已受损状态，只重算几何。
   * 小球位置按比例映射，避免旋转后卡进砖块。
   */
  relayout() {
    // FIELD 已被 applyField 就地改成新尺寸，所以要拿上次记录的旧尺寸算缩放比例
    const prev = {
      width: this.fieldWidth || FIELD.width,
      height: this.fieldHeight || FIELD.height,
    };
    this.metrics = metricsFor(FIELD);
    const hp = new Map(this.bricks.map((b) => [b.id, b.hp]));
    this.bricks = buildBricks(this.level).map((b) => ({
      ...b,
      hp: hp.has(b.id) ? hp.get(b.id) : b.hp,
    }));
    const ratioY = prev.height > 0 ? FIELD.height / prev.height : 1;
    const ratioX = prev.width > 0 ? FIELD.width / prev.width : 1;
    this.fieldWidth = FIELD.width;
    this.fieldHeight = FIELD.height;
    this.paddle.y = FIELD.height - this.metrics.paddleLift;
    this.paddle.h = this.metrics.paddleH;
    this.paddle.w = this.paddleWidth();
    this.paddle.x = clamp(this.paddle.x * ratioX, 0, FIELD.width - this.paddle.w);
    const size = this.metrics.ball;
    for (const ball of this.balls) {
      ball.w = size;
      ball.h = size;
      ball.y = clamp(ball.y * ratioY, this.metrics.brickTop - size, FIELD.height - size);
      ball.x = clamp(ball.x * ratioX, 0, FIELD.width - size);
      if (ball.stuck) {
        ball.y = this.paddle.y - size - 2;
        ball.x = clamp(this.paddle.x + this.paddle.w / 2 - size / 2 + ball.offset, 0, FIELD.width - size);
      }
    }
    for (const item of this.powerups) {
      item.w = this.metrics.powerupW;
      item.h = this.metrics.powerupH;
      item.y = clamp(item.y * ratioY, 0, FIELD.height - item.h);
      item.x = clamp(item.x * ratioX, 0, FIELD.width - item.w);
    }
  }

  get targets() {
    return this.bricks.filter((b) => b.hp > 0);
  }

  start() {
    if (this.status === "over" || this.status === "won") this.reset();
    this.status = "playing";
  }

  togglePause() {
    if (this.status === "playing") this.status = "paused";
    else if (this.status === "paused") this.status = "playing";
  }

  movePaddleTo(centerX) {
    const half = this.paddle.w / 2;
    this.paddle.x = clamp(centerX - half, 0, FIELD.width - this.paddle.w);
    for (const ball of this.balls) {
      if (ball.stuck) ball.x = this.paddle.x + half - ball.w / 2 + ball.offset;
    }
  }

  /** 空格/点击/触摸：把吸附的小球发射出去 */
  launch() {
    if (this.status !== "playing") return;
    const angle = (this.rng() * 40 - 20) * (Math.PI / 180) - Math.PI / 2;
    for (const ball of this.balls) {
      if (!ball.stuck) continue;
      ball.stuck = false;
      const speed = this.currentSpeed();
      ball.vx = Math.cos(angle) * speed;
      ball.vy = Math.sin(angle) * speed;
      this.onSound("launch");
    }
  }

  /** 剩余砖块越少时球越快，避免关末为一两块砖反复磨 */
  currentSpeed() {
    const total = Math.max(1, this.bricks.length);
    const left = this.targets.filter((b) => !b.steel).length;
    const ramp = 1 + 0.3 * (1 - left / total);
    return this.baseSpeed * this.metrics.speedScale * ramp * (this.effects.slow ? 0.65 : 1);
  }

  paddleWidth() {
    const scale = this.effects.wide ? 1.55 : this.effects.narrow ? 0.68 : 1;
    return this.metrics.paddleW * scale;
  }

  update(deltaSeconds) {
    if (this.status !== "playing") return;
    const scale = stepScale(deltaSeconds);

    this.paddle.h = this.metrics.paddleH;
    this.paddle.w = clamp(this.paddleWidth(), 40, FIELD.width);
    this.paddle.x = clamp(this.paddle.x, 0, FIELD.width - this.paddle.w);

    this.tickEffects(scale);
    this.stepBalls(scale);
    this.stepPowerups(scale);
    this.stepParticles(scale);
    if (this.shake > 0) this.shake = Math.max(0, this.shake - scale * 0.6);
    this.checkProgress();
  }

  tickEffects(scale) {
    for (const [key, value] of Object.entries(this.effects)) {
      // 护盾等瞬发效果存的是 true，只有一段时间型效果需要倒数
      if (typeof value !== "number") continue;
      const left = value - scale / 60;
      if (left <= 0) delete this.effects[key];
      else this.effects[key] = left;
    }
  }

  stepBalls(scale) {
    for (const ball of [...this.balls]) {
      if (ball.stuck) {
        ball.x = this.paddle.x + this.paddle.w / 2 - ball.w / 2 + ball.offset;
        ball.y = this.paddle.y - ball.h - 2;
        continue;
      }
      const sub = Math.max(1, Math.ceil(scale));
      for (let i = 0; i < sub; i += 1) {
        // scale 是“60 帧制”的步长，速度单位是像素/秒，因此还要除以 60
        ball.x += (ball.vx * scale) / (60 * sub);
        ball.y += (ball.vy * scale) / (60 * sub);
        this.resolveBall(ball);
      }
      const fixed = enforceMinVerticalAngle(ball, 0.22);
      ball.vx = fixed.vx;
      ball.vy = fixed.vy;
      if (ball.y > FIELD.height) this.loseBall(ball);
    }
  }

  /** 处理小球与墙、砖块、挡板的碰撞 */
  resolveBall(ball) {
    const walls = bounceOffWalls(ball, FIELD.width, FIELD.height);
    ball.vx = walls.vx;
    ball.vy = walls.vy;
    if (walls.hit) this.onSound("wall");

    for (const brick of this.targets) {
      const hit = bounceAgainstRect(ball, brick);
      if (!hit) continue;
      ball.vx = hit.vx;
      ball.vy = hit.vy;
      const locked = normalizeSpeed(ball, this.currentSpeed());
      ball.vx = locked.vx;
      ball.vy = locked.vy;
      if (!brick.steel) {
        brick.hp -= 1;
        this.combo += 1;
        this.onSound(brick.hp <= 0 ? "break" : "hit");
        if (brick.hp <= 0) this.destroyBrick(brick);
        else this.spark(brick.x + brick.w / 2, brick.y + brick.h / 2, 4, "#ffffff");
      } else {
        this.onSound("hit");
      }
      this.shake = 0.5;
      return;
    }

    if (overlaps(ball, this.paddle) && ball.vy > 0) {
      const v = paddleBounce(paddleOffsetRatio(ball, this.paddle), this.currentSpeed());
      ball.vx = v.vx;
      ball.vy = v.vy;
      ball.y = this.paddle.y - ball.h - 0.5;
      this.combo = 1;
      this.onSound("paddle");
    }
  }

  destroyBrick(brick) {
    this.score += Math.round(brickScore(brick) * comboMultiplier(this.combo));
    this.best = Math.max(this.best, this.score);
    this.spark(brick.x + brick.w / 2, brick.y + brick.h / 2, 12, "#4ac1ff");
    const drop = rollDrop(this.rng);
    if (drop) {
      const m = this.metrics;
      this.powerups.push(
        makePowerup(drop, brick.x + brick.w / 2 - m.powerupW / 2, brick.y, m),
      );
    }
  }

  loseBall(ball) {
    this.balls = this.balls.filter((b) => b !== ball);
    if (this.balls.length > 0) return;

    if (this.effects.shield) {
      delete this.effects.shield;
      this.resetBall();
      this.onSound("shield");
      return;
    }

    this.lives -= 1;
    this.onSound("lost");
    if (this.lives <= 0) {
      this.status = "over";
      return;
    }
    this.effects = {};
    this.combo = 1;
    this.resetBall();
  }

  stepPowerups(scale) {
    for (const item of [...this.powerups]) {
      item.y += (item.vy * scale) / 60;
      if (item.y > FIELD.height) {
        this.powerups = this.powerups.filter((p) => p !== item);
        continue;
      }
      if (overlaps(item, this.paddle)) {
        this.applyPowerup(item);
        this.powerups = this.powerups.filter((p) => p !== item);
      }
    }
  }

  applyPowerup(item) {
    this.onSound(item.good ? "good" : "bad");
    if (item.type === "multi") {
      const source = this.balls[0];
      if (source) {
        const speed = this.currentSpeed();
        const base = source.stuck ? -Math.PI / 2 : Math.atan2(source.vy, source.vx);
        for (const spread of [-0.4, 0.4]) {
          this.balls.push({
            ...source,
            stuck: false,
            vx: Math.cos(base + spread) * speed,
            vy: Math.sin(base + spread) * speed,
          });
        }
      }
      return;
    }
    if (item.type === "shield") {
      this.effects.shield = true;
      return;
    }
    if (item.type === "life") {
      this.lives = Math.min(6, this.lives + 1);
      return;
    }
    this.effects[item.type] = powerupDuration(item.type);
  }

  stepParticles(scale) {
    for (const p of this.particles) {
      p.x += p.vx * scale * 0.02;
      p.y += p.vy * scale * 0.02;
      p.vy += 0.35 * scale;
      p.life -= scale;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
  }

  spark(x, y, count, color) {
    for (let i = 0; i < count; i += 1) {
      const angle = this.rng() * Math.PI * 2;
      const speed = 40 + this.rng() * 160;
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 18 + this.rng() * 14,
        color,
      });
    }
    if (this.particles.length > 400) {
      this.particles.splice(0, this.particles.length - 400);
    }
  }

  checkProgress() {
    // 钢块不可摧毁，过关条件只看可破坏砖块
    if (this.targets.some((b) => !b.steel)) return;
    this.onSound("clear");
    if (this.levelIndex + 1 >= LEVELS.length) {
      this.status = "won";
      return;
    }
    this.score += 200;
    this.loadLevel(this.levelIndex + 1);
    this.status = "cleared";
  }

  /** 关卡通过后由玩家确认进入下一关 */
  nextLevel() {
    if (this.status !== "cleared") return;
    this.status = "playing";
  }

  hud() {
    return {
      score: this.score,
      best: this.best,
      lives: this.lives,
      level: this.levelIndex + 1,
      levelName: this.level.name,
      combo: this.combo,
      effects: Object.keys(this.effects),
      bricksLeft: this.targets.filter((b) => !b.steel).length,
    };
  }
}
