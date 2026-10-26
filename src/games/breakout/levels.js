import { FIELD, metricsFor } from "./layout.js";

export { FIELD };

export const COLS = 12;
export const ROWS = 8;
export const BRICK_COLORS = {
  1: "#4ac1ff",
  2: "#7ee787",
  3: "#f778ba",
  4: "#f0b072",
};

/** 砖块宽度随逻辑场地宽度与间距计算（场地宽度固定 800，因此三端一致） */
export function brickWidth() {
  const m = metricsFor(FIELD);
  return (FIELD.width - m.brickMarginX * 2 - m.brickGap * (COLS - 1)) / COLS;
}

/**
 * 关卡用字符网格描述：
 * `.` 空 · `1`-`4` 砖块耐久 · `#` 不可摧毁的钢块
 * 每关命中预算（耐久总量）写在 budget 上，由单元测试校验，保证单关节奏。
 */
export const LEVELS = [
  {
    name: "入门",
    speed: 380,
    budget: 32,
    grid: [
      "............",
      "..11111111..",
      "..22222222..",
      "..11111111..",
      "............",
      "............",
      "............",
      "............",
    ],
  },
  {
    name: "金字塔",
    speed: 410,
    budget: 38,
    grid: [
      ".....11.....",
      "....1221....",
      "...12##21...",
      "..12222221..",
      ".1111111111.",
      "............",
      "............",
      "............",
    ],
  },
  {
    name: "棋盘",
    speed: 440,
    budget: 36,
    grid: [
      "1.2.1.2.1.2.",
      ".2.1.2.1.2.1",
      "1.2.1.2.1.2.",
      ".2.1.2.1.2.1",
      "............",
      "............",
      "............",
      "............",
    ],
  },
  {
    name: "要塞",
    speed: 470,
    budget: 34,
    grid: [
      "111111111111",
      "1..........1",
      "1.22222222.1",
      "1..#....#..1",
      "............",
      "............",
      "............",
      "............",
    ],
  },
  {
    name: "终局",
    speed: 500,
    budget: 50,
    grid: [
      "222222222222",
      "11##11##11##",
      "111111111111",
      "............",
      "2..2..2..2..",
      "............",
      "............",
      "............",
    ],
  },
];

/** 把字符网格转换成带坐标与耐久的砖块对象（按当前场地尺寸布局） */
export function buildBricks(level) {
  const m = metricsFor(FIELD);
  const width = brickWidth();
  const bricks = [];
  level.grid.forEach((row, r) => {
    [...row].forEach((char, c) => {
      if (char === "." || char === " ") return;
      bricks.push({
        id: `${r}-${c}`,
        x: m.brickMarginX + c * (width + m.brickGap),
        y: m.brickTop + r * (m.brickHeight + m.brickGap),
        w: width,
        h: m.brickHeight,
        hp: char === "#" ? Infinity : Number(char),
        maxHp: char === "#" ? Infinity : Number(char),
        steel: char === "#",
      });
    });
  });
  return bricks;
}

export function brickColor(brick) {
  if (brick.steel) return "#8892a0";
  return BRICK_COLORS[Math.min(4, brick.hp)] ?? BRICK_COLORS[4];
}

export function brickScore(brick) {
  return brick.steel ? 0 : brick.maxHp * 10;
}
