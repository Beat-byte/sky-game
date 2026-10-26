export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function overlaps(a, b) {
  return (
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  );
}

/** 以 60 帧为基准把秒换算成离散步长，保证不同刷新率下手感和帧率无关 */
export function stepScale(deltaSeconds, targetFps = 60) {
  return clamp(deltaSeconds * targetFps, 0, 3);
}

/**
 * 圆（以包围盒近似）与矩形的穿透深度，用于判定反弹轴向。
 * 返回 null 表示未接触。
 */
export function penetration(circle, rect) {
  const left = circle.x + circle.w - rect.x;
  const right = rect.x + rect.w - circle.x;
  const top = circle.y + circle.h - rect.y;
  const bottom = rect.y + rect.h - circle.y;
  if (Math.min(left, right, top, bottom) <= 0) return null;
  return {
    left: Math.min(left, right),
    vertical: Math.min(top, bottom),
  };
}

/**
 * 小球与砖块/挡板的轴对齐反弹：沿穿透更浅的轴翻转速度。
 * normal 指向小球被推开的方向，供粒子与音效使用。
 */
export function bounceAgainstRect(ball, rect) {
  const p = penetration(ball, rect);
  if (!p) return null;
  if (p.left < p.vertical) {
    const fromLeft = ball.x + ball.w / 2 < rect.x + rect.w / 2;
    return {
      vx: fromLeft ? -Math.abs(ball.vx) : Math.abs(ball.vx),
      vy: ball.vy,
      normal: fromLeft ? "left" : "right",
    };
  }
  const fromTop = ball.y + ball.h / 2 < rect.y + rect.h / 2;
  return {
    vx: ball.vx,
    vy: fromTop ? -Math.abs(ball.vy) : Math.abs(ball.vy),
    normal: fromTop ? "top" : "bottom",
  };
}

/** 侧墙反弹 */
export function bounceOffWalls(ball, fieldWidth, fieldHeight, ceiling = true) {
  const next = { vx: ball.vx, vy: ball.vy, hit: null };
  if (ball.x <= 0 && ball.vx < 0) {
    next.vx = -ball.vx;
    next.hit = "wall";
  } else if (ball.x + ball.w >= fieldWidth && ball.vx > 0) {
    next.vx = -ball.vx;
    next.hit = "wall";
  }
  if (ceiling && ball.y <= 0 && ball.vy < 0) {
    next.vy = -next.vy;
    next.hit = "wall";
  }
  return next;
}

/**
 * 挡板反弹：命中点越靠边缘，出射角越平；始终向上。
 * 保留最小出射角（12°），否则正中反弹会变成纯竖直轨迹，
 * 小球在同一列上来回、再也打不到砖块。
 */
export function paddleBounce(offsetRatio, speed, minAngleDeg = 12, maxAngleDeg = 62) {
  const ratio = clamp(offsetRatio, -1, 1);
  const sign = ratio === 0 ? 1 : Math.sign(ratio);
  const deg = minAngleDeg + Math.abs(ratio) * (maxAngleDeg - minAngleDeg);
  const angle = (deg * Math.PI) / 180;
  return {
    vx: sign * speed * Math.sin(angle),
    vy: -speed * Math.cos(angle),
  };
}

/** 命中点相对挡板中心的比例，范围 -1..1 */
export function paddleOffsetRatio(ball, paddle) {
  const ballCenter = ball.x + ball.w / 2;
  const paddleCenter = paddle.x + paddle.w / 2;
  const half = Math.max(paddle.w / 2, 1);
  return clamp((ballCenter - paddleCenter) / half, -1, 1);
}

/** 归一化速度并保持给定速率，防止多次反弹后速度漂移 */
export function normalizeSpeed(ball, speed) {
  const len = Math.hypot(ball.vx, ball.vy) || 1;
  return { vx: (ball.vx / len) * speed, vy: (ball.vy / len) * speed };
}

/** 避免小球以近乎水平的角度长时间卡在两侧 */
export function enforceMinVerticalAngle(ball, minSlope = 0.25) {
  const speed = Math.hypot(ball.vx, ball.vy) || 1;
  const vertical = Math.abs(ball.vy);
  if (vertical >= speed * minSlope) return { vx: ball.vx, vy: ball.vy };
  const signX = ball.vx === 0 ? 1 : Math.sign(ball.vx);
  const signY = ball.vy === 0 ? 1 : Math.sign(ball.vy);
  const vx = speed * Math.sqrt(1 - minSlope ** 2) * signX;
  const vy = speed * minSlope * signY;
  return { vx, vy };
}

/** 连击倍率：同一次触板期间击破的砖块数越多，得分倍率越高 */
export function comboMultiplier(bricksSincePaddleTouch) {
  if (bricksSincePaddleTouch < 2) return 1;
  return clamp(1 + (bricksSincePaddleTouch - 1) * 0.25, 1, 4);
}
