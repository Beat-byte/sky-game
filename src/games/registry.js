/**
 * 游戏注册表：首页列表、路由可达性、卡片元数据来源。
 * 新增一个游戏 = 往 games/ 下加一个目录 + 在这里加一条记录，首页自动出现入口。
 */

export const GAMES = [
  {
    id: "breakout",
    name: "像素弹球",
    subtitle: "拖动挡板反弹小球，五色砖块逐层加固，五关难度递增。",
    tags: ["街机", "单指操作", "5 关卡"],
    mark: "弹",
    accent: "#4ac1ff",
    status: "ready",
    // v1 遗留的裸数字键，仅用于首次读取时迁移进 sky-games:game:breakout
    bestKey: "pixel-breakout-best",
    load: () => import("./breakout/BreakoutView.vue"),
  },
  {
    id: "tetris",
    name: "方块堆叠",
    subtitle: "七种方块 7 袋随机，恒定 10×20 棋盘，消行计分逐关提速。",
    tags: ["街机", "单指操作", "无限关卡"],
    mark: "方",
    accent: "#a78bfa",
    status: "ready",
    load: () => import("./tetris/TetrisView.vue"),
  },
  {
    id: "snake",
    name: "像素贪吃蛇",
    subtitle: "四向滑动或方向键转向，260 格恒定棋盘，三端手感一致。",
    tags: ["街机", "单指操作", "8 档提速"],
    mark: "蛇",
    accent: "#34d399",
    status: "ready",
    load: () => import("./snake/SnakeView.vue"),
  },
  {
    id: "delta",
    name: "危险行动",
    subtitle: "搜刮—交火—撤离：恒定 28×18 米视野，阵亡丢掉身上的一切，只有保险箱留得住。",
    tags: ["战术撤离", "搜打撤", "跨局成长"],
    mark: "危",
    accent: "#f0b072",
    status: "ready",
    load: () => import("./delta/DeltaView.vue"),
  },
  {
    id: "birds",
    name: "愤怒的小鸟",
    subtitle: "拉弓—抛物—拆结构：六关手写战场，弹弓物理三端共用同一套米制。",
    tags: ["弹射", "物理拆塔", "6 关卡"],
    mark: "鸟",
    accent: "#e6483c",
    status: "ready",
    load: () => import("./birds/BirdsView.vue"),
  },
];

export function findGame(id) {
  return GAMES.find((game) => game.id === id) ?? null;
}

export function playableGames() {
  return GAMES.filter((game) => game.status === "ready");
}
