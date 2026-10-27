/**
 * 「危险行动」渲染层：只读引擎状态往画布上画，绝不改状态、绝不用 Math.random。
 *
 * 两条纪律：
 * 1. **不许出现设备分支的难度量**。这里能读 metricsFor 的只有线宽/字号/小地图边长这类装饰量；
 *    任何"手机上画小一点所以更难看见"都不允许——可见范围由 layout.js 的恒定视口保证。
 * 2. **不许用 Math.random**。抖动一律从整数格号与 id 派生（hashJitter），
 *    这样同一帧画两次结果一致，截图对比与"渲染不改状态"的单测才成立。
 */

import { FIELD, PX_PER_M, cameraFor, visibleWindow } from "./layout.js";
import { TILES, WORLD } from "./map.js";
import { BLOCKS, EXFIL, FIGURE_TONE, GROUND_COLORS, cssHex } from "./scene3d.js";

/**
 * 俯视配色：从 scene3d.js 那一套 CIELAB 校过的色板派生，两个视图共用一个真实来源。
 * 约定：**俯视看到的是顶面**，所以容器 fill 用 3D 的亮顶盖色、描边用本体色；
 * 墙反过来——结构在俯视图里要压暗，才能让"能搜/能躲"的容器跳出来（旧版墙/货架/弹药同族同明度，玩家分不清）。
 */
const capOf = (ch) => cssHex(BLOCKS[ch].cap);
const bodyOf = (ch) => cssHex(BLOCKS[ch].color);

/** 按系数缩放 #rrggbb 的三个通道（k<1 压暗、k>1 提亮），俯视描边一贯比填充深一档 */
function tint(css, k) {
  const n = parseInt(css.slice(1), 16);
  const c = (v) => Math.max(0, Math.min(255, Math.round(v * k)));
  return `#${[(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => c(v).toString(16).padStart(2, "0")).join("")}`;
}

/** sRGB 相对亮度（0..1），只用来决定落笔墨色取深还是取浅 */
function luma(css) {
  const n = parseInt(css.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * 写在色块上的字，墨色跟着底色走：亮顶盖（弹药 #f0ff8c、保险柜 #f6dd7e、货架 #9fe4f7）
 * 上原来那支淡蓝白 #dbe4f2 直接和底色糊在一起，字等于没画。
 * 亮底用同色相压到近黑（保住"这个箱子是柠檬黄"的身份感），暗底才用淡蓝白。
 * 导出只为让色差断言进得了单测，渲染内部一律用本文件这个引用。
 */
export function inkOn(css) {
  return luma(css) > 0.45 ? tint(css, 0.16) : "#eaf1fb";
}

const groundDay = GROUND_COLORS.day;

const PAINT = {
  floor: { fill: cssHex(groundDay.base), edge: cssHex(groundDay.alt) },
  dirt: { fill: cssHex(groundDay.alt), edge: cssHex(groundDay.base) },
  wall: { fill: bodyOf("#"), edge: tint(bodyOf("#"), 0.5) },
  steel: { fill: capOf("#"), edge: bodyOf("#") },
  cover: { fill: capOf("x"), edge: bodyOf("x") },
  crate: { fill: capOf("c"), edge: bodyOf("c") },
  ammo: { fill: capOf("a"), edge: bodyOf("a") },
  med: { fill: capOf("m"), edge: bodyOf("m") },
  shelf: { fill: capOf("s"), edge: bodyOf("s") },
  safe: { fill: capOf("$"), edge: bodyOf("$") },
  exfil: { fill: cssHex(EXFIL.pad.color), edge: tint(cssHex(EXFIL.pad.color), 0.5) },
};

const CONTAINER_PAINT = { cover: "cover", crate: "crate", ammo: "ammo", med: "med", shelf: "shelf", safe: "safe" };

function hashJitter(x, y, salt = 0) {
  let h = (x * 73856093) ^ (y * 19349663) ^ (salt * 83492791);
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

export function setupCanvas(canvas, css) {
  const dpr = Math.max(1, Math.min(3, Math.round((window.devicePixelRatio ?? 1) * 2) / 2));
  canvas.width = Math.max(1, Math.round(css.width * dpr));
  canvas.height = Math.max(1, Math.round(css.height * dpr));
  canvas.style.width = `${css.width}px`;
  canvas.style.height = `${css.height}px`;
  const ctx = canvas.getContext("2d");
  const scale = css.width / FIELD.width;
  ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
  return ctx;
}

function circle(ctx, x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
}

function label(ctx, text, x, y, size, color = "#dbe4f2", align = "center", halo = null) {
  ctx.font = `${size}px "PingFang SC", system-ui, sans-serif`;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  if (halo !== null) {
    // 描一圈暗边再填色：字落在亮顶盖、雾里、别人身上都读得清，不用逐处挑底色
    ctx.lineWidth = Math.max(2, size * 0.22);
    ctx.strokeStyle = halo;
    ctx.lineJoin = "round";
    ctx.strokeText(text, x, y);
  }
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function ell(ctx, x, y, rx, ry, rot = 0) {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2);
}

/**
 * 人形配色：身份/状态只改颜色，不改尺寸——尺寸由恒定视口决定，难度与设备无关。
 * 活体三态直接取 scene3d.js 的 FIGURE_TONE（红=交火、橙=警戒、紫=未察觉），
 * 与环境的冷灰/木棕/金/青/柠檬都拉开 ΔE ≥ 24，隔着一片货架也不会把敌人看成箱子。
 */
const tone = (key, trimK = 1.35) => ({
  body: cssHex(FIGURE_TONE[key].body),
  limb: cssHex(FIGURE_TONE[key].legs),
  helmet: cssHex(FIGURE_TONE[key].head),
  trim: tint(cssHex(FIGURE_TONE[key].body), trimK),
  dark: tint(cssHex(FIGURE_TONE[key].legs), 0.35),
});

const SKIN = {
  player: { body: "#3d86b8", limb: "#2b6187", helmet: "#a9dcf5", trim: "#4ac1ff", dark: "#0e1622" },
  engage: tone("engage"),
  alert: tone("alert"),
  unseen: tone("unseen"),
  down: { body: "#6b7482", limb: "#4a5260", helmet: "#98a2b1", trim: "#8b95a5", dark: "#161c26" },
};

/** 步频（弧度/秒）。画的是"每步多快"，不是"每帧多少像素"，所以与设备档位无关 */
const WALK_CADENCE = 8.5;

/**
 * 腿摆量：区间 [-1,1]，0 表示站定。
 * 相位由全局 phase + 实体 id 派生（不许 Math.random），位移大小只用来调幅度，
 * 因此同一帧画两次逐像素一致，截图对拍仍然成立。
 */
function swingFor(id, phase, magnitude) {
  if (!(magnitude > 0.02)) return 0;
  const seed = hashJitter(id, 0, 11) * Math.PI * 2;
  return Math.sin(phase * WALK_CADENCE + seed) * Math.min(1, magnitude);
}

/**
 * 俯视角人形。局部 +x 是面朝方向，调用方负责 translate/rotate 之外的坐标换算。
 * 只有躯干与头盔描边：四肢在 r≈10 px 的人身上只有 4 px 宽，一律描边会被线宽整个吃掉，
 * 反而画不出手脚——所以描边走轮廓、四肢靠色块与躯干分层来读。
 */
function paintFigure(ctx, { x, y, angle, r, skin, swing = 0, outline = 1, down = false }) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  if (down) {
    ctx.scale(1.15, 0.55);
    ctx.globalAlpha = 0.8;
  }
  const line = Math.max(0.7, outline * 0.5);

  ctx.fillStyle = skin.limb;
  for (const side of [-1, 1]) {
    const lead = swing * side;
    ell(ctx, -r * 0.3 + lead * r * 0.42, side * r * 0.3, r * 0.4, r * 0.24, lead * 0.5);
    ctx.fill();
  }

  ell(ctx, -r * 0.52, 0, r * 0.28, r * 0.44);
  ctx.fill();

  ctx.fillStyle = skin.body;
  ell(ctx, 0, 0, r * 0.76, r * 0.6);
  ctx.fill();
  ctx.lineWidth = line;
  ctx.strokeStyle = skin.dark;
  ctx.stroke();

  ctx.fillStyle = skin.limb;
  for (const [arm, rot] of [[-0.34, 0.7], [0.34, -0.5]]) {
    ell(ctx, r * 0.3, r * arm, r * 0.4, r * 0.19, rot);
    ctx.fill();
  }

  ctx.fillStyle = "#1a2029";
  ell(ctx, r * 0.95, r * 0.05, r * 0.5, r * 0.11);
  ctx.fill();
  ctx.fillStyle = skin.trim;
  ell(ctx, r * 0.3, r * 0.07, r * 0.22, r * 0.14);
  ctx.fill();

  ctx.fillStyle = skin.helmet;
  ell(ctx, r * 0.24, 0, r * 0.35, r * 0.33);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = skin.dark;
  ell(ctx, r * 0.44, 0, r * 0.13, r * 0.22);
  ctx.fill();

  ctx.restore();
}

function paintGround(ctx, game, camera, win, m) {
  const map = game.map;
  const night = map.timeSlot === "night";
  for (let gy = win.y0; gy <= win.y1; gy += 1) {
    for (let gx = win.x0; gx <= win.x1; gx += 1) {
      const tile = TILES[map.grid[gy][gx]] ?? TILES["."];
      const screen = { x: (gx - camera.x) * PX_PER_M, y: (gy - camera.y) * PX_PER_M };
      const base = tile.solid
        ? tile.container
          ? PAINT[CONTAINER_PAINT[tile.container]] ?? PAINT.crate
          : PAINT.wall
        : tile.exfil
          ? PAINT.exfil
          : (gx + gy) % 2 === 0
            ? PAINT.floor
            : PAINT.dirt;
      ctx.fillStyle = base.fill;
      ctx.fillRect(screen.x, screen.y, PX_PER_M + 1, PX_PER_M + 1);
      if (tile.solid) {
        // 描边只在实体格上画，空格靠双色棋盘给出网格感
        ctx.strokeStyle = base.edge;
        ctx.lineWidth = m.hairline;
        ctx.strokeRect(screen.x + 0.5, screen.y + 0.5, PX_PER_M - 1, PX_PER_M - 1);
        const bump = hashJitter(gx, gy, tile.container ? 3 : 1);
        ctx.fillStyle = "rgba(255,255,255,0.05)";
        ctx.fillRect(screen.x + 3 + bump * 6, screen.y + 3 + bump * 4, PX_PER_M - 8, 3);
      }
      if (tile.container) {
        const spec = TILES[map.grid[gy][gx]];
        ctx.fillStyle = inkOn(base.fill);
        ctx.font = `${m.fontSize * 0.7}px "PingFang SC", system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText((CONTAINERS_LABEL[spec.container] ?? "箱")[0], screen.x + PX_PER_M / 2, screen.y + PX_PER_M / 2);
      }
      if (tile.exfil) {
        ctx.strokeStyle = "#7ee787";
        ctx.lineWidth = m.glowWidth;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(screen.x + 2, screen.y + 2, PX_PER_M - 4, PX_PER_M - 4);
        ctx.setLineDash([]);
      }
    }
  }
  if (night) {
    // 夜色压暗整体，但只压到 0.30：旧值 0.42 的深蓝罩层会把刚分开的色板重新洗成一片灰蓝
    ctx.fillStyle = "rgba(6,10,22,0.3)";
    ctx.fillRect(0, 0, FIELD.width, FIELD.height);
  }
}

const CONTAINERS_LABEL = { cover: "掩体", crate: "木箱", ammo: "弹药", med: "医疗", shelf: "货架", safe: "保险柜" };

function paintExfils(ctx, game, camera, m) {
  for (const point of game.map.exfils) {
    const screen = { x: (point.x - camera.x) * PX_PER_M, y: (point.y - camera.y) * PX_PER_M };
    ctx.strokeStyle = "rgba(126,231,135,0.85)";
    ctx.lineWidth = m.glowWidth;
    circle(ctx, screen.x, screen.y, WORLD.exfilRadius * PX_PER_M);
    ctx.stroke();
    label(ctx, "撤离点", screen.x, screen.y - WORLD.exfilRadius * PX_PER_M - m.fontSize, m.fontSize, "#7ee787", "center", "rgba(8,12,20,0.85)");
  }
}

function paintBags(ctx, game, camera) {
  for (const bag of game.groundBags) {
    const screen = { x: (bag.x - camera.x) * PX_PER_M, y: (bag.y - camera.y) * PX_PER_M };
    ctx.fillStyle = "#8b6f47";
    ctx.fillRect(screen.x - 7, screen.y - 6, 14, 12);
    ctx.strokeStyle = "#d9c9a3";
    ctx.lineWidth = 1;
    ctx.strokeRect(screen.x - 7, screen.y - 6, 14, 12);
  }
}

function paintSmokes(ctx, game, camera, phase) {
  for (const smoke of game.smokes) {
    if (smoke.ttl <= 0) continue;
    const screen = { x: (smoke.x - camera.x) * PX_PER_M, y: (smoke.y - camera.y) * PX_PER_M };
    const r = smoke.r * PX_PER_M * (0.75 + 0.25 * Math.min(1, smoke.ttl / 1.5));
    const alpha = 0.5 * Math.min(1, smoke.ttl / 2);
    const grad = ctx.createRadialGradient(screen.x, screen.y, r * 0.2, screen.x, screen.y, r);
    grad.addColorStop(0, `rgba(226,232,240,${alpha})`);
    grad.addColorStop(1, "rgba(203,213,225,0)");
    ctx.fillStyle = grad;
    // 漂移相位由格号派生，不用随机数：同一帧画两次必须完全一致
    const seed = hashJitter(Math.floor(smoke.x), Math.floor(smoke.y), 7) * Math.PI * 2;
    circle(ctx, screen.x + Math.sin(phase + seed) * 3, screen.y, r);
    ctx.fill();
  }
}

function paintAi(ctx, game, camera, m, phase) {
  for (const ai of game.ais) {
    if (!ai.alive || ai.isGhost) continue;
    const screen = { x: (ai.x - camera.x) * PX_PER_M, y: (ai.y - camera.y) * PX_PER_M };
    const r = ai.radius * PX_PER_M;
    const seen = ai.sees || game.pulse.ttl > 0;
    const skin = seen ? (ai.state === "engage" ? SKIN.engage : SKIN.alert) : SKIN.unseen;
    const intent = ai.intent ?? { moveX: 0, moveY: 0 };
    paintFigure(ctx, {
      x: screen.x,
      y: screen.y,
      angle: ai.angle,
      r,
      skin,
      swing: swingFor(ai.id, phase, Math.hypot(intent.moveX, intent.moveY)),
      outline: m.outlineWidth,
    });
    // 视线索：人形已经说明"它朝哪儿"，这条线只用来回答"它是不是正盯着我"
    if (ai.sees) {
      ctx.strokeStyle = "rgba(255,150,150,0.35)";
      ctx.lineWidth = m.hairline * 1.4;
      ctx.beginPath();
      ctx.moveTo(screen.x + Math.cos(ai.angle) * r * 1.5, screen.y + Math.sin(ai.angle) * r * 1.5);
      ctx.lineTo(screen.x + Math.cos(ai.angle) * r * 2.7, screen.y + Math.sin(ai.angle) * r * 2.7);
      ctx.stroke();
    }
    if (game.pulse.ttl > 0) {
      ctx.strokeStyle = "rgba(74,193,255,0.9)";
      ctx.lineWidth = m.glowWidth;
      circle(ctx, screen.x, screen.y, r + 6);
      ctx.stroke();
    }
    const hpRatio = ai.hpMax > 0 ? Math.max(0, ai.hp) / ai.hpMax : 0;
    if (hpRatio < 1) {
      ctx.fillStyle = "rgba(10,14,20,0.75)";
      ctx.fillRect(screen.x - r, screen.y - r - 7, r * 2, 3);
      ctx.fillStyle = "#f87171";
      ctx.fillRect(screen.x - r, screen.y - r - 7, r * 2 * hpRatio, 3);
    }
  }
}

function paintBullets(ctx, game, camera, m) {
  for (const bullet of game.bullets.items) {
    if (!bullet.alive) continue;
    const from = { x: (bullet.px - camera.x) * PX_PER_M, y: (bullet.py - camera.y) * PX_PER_M };
    const to = { x: (bullet.x - camera.x) * PX_PER_M, y: (bullet.y - camera.y) * PX_PER_M };
    ctx.strokeStyle = bullet.owner === 0 ? "rgba(255,236,180,0.95)" : "rgba(255,150,150,0.9)";
    ctx.lineWidth = m.hairline * 1.6;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  }
}

const PARTICLE_PAINT = { spark: "#ffd28a", blood: "#f87171", dust: "#94a3b8" };

function paintParticles(ctx, game, camera) {
  for (const p of game.particles.items) {
    if (!p.alive || p.ttl <= 0) continue;
    const screen = { x: (p.x - camera.x) * PX_PER_M, y: (p.y - camera.y) * PX_PER_M };
    const ratio = p.life > 0 ? Math.max(0, Math.min(1, p.ttl / p.life)) : 1;
    ctx.globalAlpha = ratio;
    ctx.fillStyle = PARTICLE_PAINT[p.kind] ?? PARTICLE_PAINT.spark;
    const size = 2 + ratio * 2;
    ctx.fillRect(screen.x - size / 2, screen.y - size / 2, size, size);
  }
  ctx.globalAlpha = 1;
}

function paintPlayer(ctx, game, camera, m, phase) {
  const p = game.player;
  const screen = { x: (p.x - camera.x) * PX_PER_M, y: (p.y - camera.y) * PX_PER_M };
  const r = p.radius * PX_PER_M;

  // 自动开火的锥形视野：让玩家明白"朝哪儿才打得着"
  if (game.fireEnabled && p.alive) {
    const grad = ctx.createRadialGradient(screen.x, screen.y, r, screen.x, screen.y, game.weapon.rangeM * PX_PER_M * 0.55);
    grad.addColorStop(0, "rgba(74,193,255,0.16)");
    grad.addColorStop(1, "rgba(74,193,255,0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(screen.x, screen.y);
    ctx.arc(screen.x, screen.y, game.weapon.rangeM * PX_PER_M * 0.55, p.angle - WORLD.fireConeRad, p.angle + WORLD.fireConeRad);
    ctx.closePath();
    ctx.fill();
  }

  paintFigure(ctx, {
    x: screen.x,
    y: screen.y,
    angle: p.angle,
    r,
    skin: p.alive ? SKIN.player : SKIN.down,
    swing: p.alive ? swingFor(0, phase, Math.hypot(game.stick.x, game.stick.y)) : 0,
    outline: m.outlineWidth,
    down: !p.alive,
  });

  if (game.reloading > 0) {
    ctx.strokeStyle = "#f0b072";
    ctx.lineWidth = m.glowWidth;
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, r + 8, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - game.reloading / game.weapon.reloadSec));
    ctx.stroke();
  } else if (game.searchTarget) {
    ctx.strokeStyle = "#a78bfa";
    ctx.lineWidth = m.glowWidth;
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, r + 8, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (game.searchProgress / game.searchTarget.searchSec));
    ctx.stroke();
  }

  for (const fx of [game.fx.muzzle]) {
    if (!fx || fx.ttl <= 0 || fx.owner !== 0) continue;
    const s = { x: (fx.x - camera.x) * PX_PER_M, y: (fx.y - camera.y) * PX_PER_M };
    ctx.fillStyle = "rgba(255,220,140,0.9)";
    circle(ctx, s.x, s.y, 5 + fx.ttl * 40);
    ctx.fill();
  }
}

/** 可搜刮提示：把"够得着哪个箱子"画在箱子上，而不是让玩家猜 */
function paintInteractHint(ctx, game, camera, m) {
  if (!game.player.alive) return;
  const target = game.searchTarget ?? game.nearestSearchable();
  if (!target) return;
  const screen = { x: (target.x - camera.x) * PX_PER_M, y: (target.y - camera.y) * PX_PER_M };
  ctx.strokeStyle = "rgba(167,139,250,0.9)";
  ctx.lineWidth = m.glowWidth;
  ctx.strokeRect(screen.x - PX_PER_M / 2 - 2, screen.y - PX_PER_M / 2 - 2, PX_PER_M + 4, PX_PER_M + 4);
  label(ctx, game.searchTarget ? `${Math.round((game.searchProgress / target.searchSec) * 100)}%` : "搜刮", screen.x, screen.y - PX_PER_M, m.fontSize, "#c4a8ff", "center", "rgba(8,12,20,0.85)");
}

function paintMinimap(ctx, game, camera, m) {
  const size = m.minimapSize;
  const pad = m.minimapPadding;
  const x0 = FIELD.width - size - pad;
  const y0 = FIELD.height - size - pad;
  const sx = size / game.map.cols;
  const sy = size / game.map.rows;
  ctx.fillStyle = "rgba(10,15,24,0.72)";
  ctx.fillRect(x0 - 3, y0 - 3, size + 6, size + 6);
  ctx.strokeStyle = "rgba(120,140,170,0.5)";
  ctx.lineWidth = 1;
  ctx.strokeRect(x0 - 3, y0 - 3, size + 6, size + 6);
  for (let gy = 0; gy < game.map.rows; gy += 1) {
    for (let gx = 0; gx < game.map.cols; gx += 1) {
      const tile = TILES[game.map.grid[gy][gx]] ?? TILES["."];
      if (!tile.solid && !tile.exfil) continue;
      // 小地图原来把容器统一涂 #6b7f9a、墙涂 #39445a：两块灰蓝在 3 px 格子上分不出"能搜"和"进不去"
      const paint = tile.exfil ? PAINT.exfil : (tile.container ? PAINT[CONTAINER_PAINT[tile.container]] : PAINT.wall) ?? PAINT.wall;
      ctx.fillStyle = tile.exfil ? "#7ee787" : paint.fill;
      ctx.fillRect(x0 + gx * sx, y0 + gy * sy, Math.max(1, sx), Math.max(1, sy));
    }
  }
  for (const bag of game.groundBags) {
    ctx.fillStyle = "#d9c9a3";
    ctx.fillRect(x0 + bag.x * sx - 1, y0 + bag.y * sy - 1, 2, 2);
  }
  for (const ai of game.ais) {
    if (!ai.alive || ai.isGhost) continue;
    if (!(ai.sees || game.pulse.ttl > 0)) continue;
    ctx.fillStyle = ai.state === "engage" ? "#f87171" : "#f0b072";
    ctx.fillRect(x0 + ai.x * sx - 1.5, y0 + ai.y * sy - 1.5, 3, 3);
  }
  if (game.player.alive) {
    ctx.fillStyle = "#4ac1ff";
    ctx.fillRect(x0 + game.player.x * sx - 2, y0 + game.player.y * sy - 2, 4, 4);
  }
  // 视口框：让玩家明白主画面是这张图的哪一块
  const viewW = FIELD.width / PX_PER_M;
  const viewH = FIELD.height / PX_PER_M;
  ctx.strokeStyle = "rgba(226,232,240,0.55)";
  ctx.strokeRect(x0 + camera.x * sx, y0 + camera.y * sy, viewW * sx, viewH * sy);
}

function paintDamageFlash(ctx, game, m) {
  if (game.fx.shake <= 0.01) return;
  ctx.fillStyle = `rgba(248,113,113,${Math.min(0.32, game.fx.shake * 0.3)})`;
  ctx.fillRect(0, 0, FIELD.width, FIELD.height);
  void m;
}

/**
 * 一帧全部绘制。camera 由这里统一算，保证裁剪窗口与实体绘制用的是同一个相机。
 * 返回值只用于调试断言（画了多少个实体），不影响任何状态。
 */
export function draw(ctx, game, { phase = 0, metrics } = {}) {
  const camera = cameraFor(game.player, FIELD, game.map, { biasM: 0 });
  // 装饰量一律由装配层（视图）传进来：引擎不认识设备，渲染层也不许自己按档位猜
  const m = metrics;
  const win = visibleWindow(camera, FIELD, game.map);

  ctx.save();
  if (game.fx.shake > 0.01) {
    const amp = Math.min(4, game.fx.shake * 4);
    ctx.translate(Math.sin(phase * 37) * amp, Math.cos(phase * 41) * amp);
  }
  ctx.fillStyle = "#141b25";
  ctx.fillRect(-8, -8, FIELD.width + 16, FIELD.height + 16);
  paintGround(ctx, game, camera, win, m);
  paintExfils(ctx, game, camera, m);
  paintBags(ctx, game, camera);
  paintInteractHint(ctx, game, camera, m);
  paintSmokes(ctx, game, camera, phase);
  paintBullets(ctx, game, camera, m);
  paintAi(ctx, game, camera, m, phase);
  paintPlayer(ctx, game, camera, m, phase);
  paintParticles(ctx, game, camera);
  ctx.restore();

  paintDamageFlash(ctx, game, m);
  if (game.fx.hitMarker && game.fx.hitMarker.ttl > 0) {
    const s = { x: (game.fx.hitMarker.x - camera.x) * PX_PER_M, y: (game.fx.hitMarker.y - camera.y) * PX_PER_M };
    ctx.strokeStyle = `rgba(255,255,255,${Math.min(1, game.fx.hitMarker.ttl * 4)})`;
    ctx.lineWidth = m.outlineWidth;
    ctx.beginPath();
    ctx.moveTo(s.x - 7, s.y - 7);
    ctx.lineTo(s.x + 7, s.y + 7);
    ctx.moveTo(s.x + 7, s.y - 7);
    ctx.lineTo(s.x - 7, s.y + 7);
    ctx.stroke();
  }
  paintMinimap(ctx, game, camera, m);
  return { camera, win };
}

/**
 * 第一人称下的 2D 叠加层：清空成透明，只保留小地图。
 * 俯视画布浮在 WebGL 画布之上，透明区透出 3D 画面——切视角不该把"全局感"整个丢掉。
 * 同样只读状态、只用装饰量，与 draw() 共用 paintMinimap。
 */
export function drawMinimapOverlay(ctx, game, { metrics }) {
  const camera = cameraFor(game.player, FIELD, game.map, { biasM: 0 });
  ctx.clearRect(0, 0, FIELD.width, FIELD.height);
  paintMinimap(ctx, game, camera, metrics);
  return { camera };
}

/** 结算/待命屏的低亮度静态帧：没有 game 也能画一张地图预览 */
export function drawPreview(ctx, map, metrics) {
  const camera = cameraFor(map.spawn, FIELD, map, { biasM: 0 });
  const win = visibleWindow(camera, FIELD, map);
  ctx.fillStyle = "#141b25";
  ctx.fillRect(0, 0, FIELD.width, FIELD.height);
  paintGround(ctx, { map, timeSec: 0, player: map.spawn, smokes: [], ais: [] }, camera, win, metrics);
}

