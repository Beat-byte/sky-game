# 项目规则（入口）

本文件只是索引，细则按主题拆在 `docs/rules/` 下。**按需读对应那一份，不要一次全读。**
改代码前先对照下面的表找到文件再动手。

## 常驻铁律（任何任务都生效，无须查文件）

1. **语言**：与用户的所有回复、文档、注释一律中文，禁止生成英文内容（代码标识符与第三方命令名除外）。
2. **风险动作先确认**：`git push`、删/重置分支、force、改远端或其他共享状态，默认先征得用户同意。
3. **不碰密钥**：不提交可能含密钥的文件（`.env`、credentials 等）；`~/.ssh/id_ed25519` 只读公钥与指纹，绝不读私钥内容。
4. **引擎框架无关**：`src/games/**` 不许 `import vue`；只有 `*.vue` 装配层可依赖 Vue。
5. **持久化只走 `src/services/store.js`**：游戏模块与组件不得直接调用 `localStorage`。
6. **不许 `Math.random`**：视觉抖动、花纹、相位一律由整数格号 / 实体 id / 传入的 `phase` 派生。
7. **难度与设备无关**：速度按"格/秒"或"秒/格"定义，格子类行列三端恒定，不许按像素或设备档位调难度。
8. **交付要在真实环境实测**：`npm test` 绿不等于能玩，必须用可观测信号在页面里复验。
9. **新增依赖只用 npm，且拆两条命令**：一条命令同时装多个依赖会撞 npm 10.8.2 的 arborist 缺陷，
   且都要 `--save-exact`。

## 任务场景 → 读哪份

| 你要做的事 | 读这个 |
| --- | --- |
| 确认 Node/npm/git 版本、哪些命令可用 | [docs/rules/environment.md](docs/rules/environment.md) |
| 装依赖、动技术栈、起本地 dev/preview 服务 | [docs/rules/stack-and-deps.md](docs/rules/stack-and-deps.md) |
| 新增一款游戏、改模块分工、改主循环与卸载清理 | [docs/rules/game-module.md](docs/rules/game-module.md) |
| 改战绩、偏好、跨局存档、`localStorage` 结构 | [docs/rules/store.md](docs/rules/store.md) |
| 改手机端全屏层（`src/styles/playfield.css`）、四款手机档位与出口按钮 | [docs/rules/mobile-playfield.md](docs/rules/mobile-playfield.md) |
| 改「危险行动」的任何文件（双视图、色板、相机、人形） | [docs/rules/delta.md](docs/rules/delta.md) |
| 改「愤怒的小鸟」的任何文件（求解器、材质、关卡、几何地板） | [docs/rules/birds.md](docs/rules/birds.md) |
| 改 vite `base`、路由、404 回退、站点图标、Pages workflow | [docs/rules/ghpages.md](docs/rules/ghpages.md) |
| 加/改测试、改几何档位、查用例分布与"改 X 要同步 Y" | [docs/rules/testing.md](docs/rules/testing.md) |
| 在浏览器里验收、手动泵帧、读画布像素 | [docs/rules/browser-verify.md](docs/rules/browser-verify.md) |

## 代码地图

- `src/games/<id>/` —— 五款游戏互相独立：弹球 `breakout`、贪吃蛇 `snake`、方块堆叠 `tetris`、危险行动 `delta`、愤怒的小鸟 `birds`
- `src/games/registry.js` —— 新增游戏只改这里加一条记录，**不改路由文件**
- `src/services/store.js` / `src/composables/useStore.js` —— 唯一的持久化入口与组件侧封装
- `src/games/delta/scene3d.js` / `three-view.js` —— 3D 数学与色板的真实来源 / 只做 three 绑定
- `src/games/birds/physics.js` / `levels.js` —— 求解器与材质表、六关手写数据的真实来源（`renderer.js` 从这两处取数值）
- `scripts/dev.mjs`、`scripts/gen-icons.mjs` —— 本地服务托管、站点图标生成器
- `test/*.test.js` —— 回归基线 178 例

## 维护说明

- 新增主题的细则**只加文件、不往本文件堆内容**；本文件保持在"索引 + 常驻铁律"的体量。
- 环境类事实会过期：更新 [docs/rules/environment.md](docs/rules/environment.md) 前先重新执行
  `node -v`、`npm -v`、`which node`、`uname -m`、`sw_vers -productVersion`。
