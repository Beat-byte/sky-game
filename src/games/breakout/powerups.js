export const POWERUPS = {
  wide: { label: "宽", color: "#7ee787", seconds: 20, good: true },
  multi: { label: "分", color: "#4ac1ff", seconds: 0, good: true },
  slow: { label: "慢", color: "#d2a8ff", seconds: 14, good: true },
  shield: { label: "盾", color: "#f0b072", seconds: 0, good: true },
  life: { label: "命", color: "#ff7b72", seconds: 0, good: true },
  narrow: { label: "窄", color: "#8892a0", seconds: 10, good: false },
};

export const POWERUP_KEYS = Object.keys(POWERUPS);
const WEIGHTS = POWERUP_KEYS.map((k) => (POWERUPS[k].good ? 3 : 1));

function weightedPick(rng, keys, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = rng() * total;
  for (let i = 0; i < keys.length; i += 1) {
    roll -= weights[i];
    if (roll <= 0) return keys[i];
  }
  return keys[keys.length - 1];
}

/** 砖块被击碎时是否掉落道具 */
export function rollDrop(rng = Math.random, chance = 0.22) {
  return rng() < chance ? weightedPick(rng, POWERUP_KEYS, WEIGHTS) : null;
}

/** 尺寸来自当前场地度量，保证小屏上触摸/观看都够大 */
export function makePowerup(type, x, y, metrics, fallSpeed = 130) {
  return {
    type,
    x,
    y,
    w: metrics.powerupW,
    h: metrics.powerupH,
    vy: fallSpeed,
    label: POWERUPS[type].label,
    color: POWERUPS[type].color,
    good: POWERUPS[type].good,
  };
}

/** 持续型道具的生效秒数，瞬发道具返回 0 */
export function powerupDuration(type) {
  return POWERUPS[type].seconds;
}
