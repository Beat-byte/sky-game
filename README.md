# 像素游戏厅 · 多游戏合集

Vue 3 + Vite 的单页应用：首页汇总所有游戏，点卡片进入对应游戏页。当前上线三款游戏——
「像素弹球」（HTML5 Canvas 打砖块：5 个手工关卡、6 种道具、连击计分、粒子与震屏反馈）、
「像素贪吃蛇」（260 格恒定棋盘、8 档提速、横竖屏互为转置）与
「方块堆叠」（七种方块 7 袋随机、锁定宽限期、踢墙、暂存、无限关卡）。
三个游戏都是"纯逻辑引擎 + 一个 Vue 装配层"，加进首页只靠注册表的一条记录。

## 项目信息

| 项目 | 值 |
| --- | --- |
| 名称 | `qoder-sky-games` v2.0.0 |
| 框架 | Vue 3.5.13（Composition API + `<script setup>`）+ vue-router 4.4.5 |
| 构建 | Vite 5.4.11 + @vitejs/plugin-vue 5.2.1 |
| 运行时 | Node ≥ 20（实测系统 `/usr/local/bin/node` 为 v20.19.5），包管理只用 npm |
| 开发服务 | **5173** → http://localhost:5173（`npm run dev`；被占用自动顺延端口） |
| 预览服务 | **4173** → http://localhost:4173（`npm run build && npm run preview`，同样被占用则顺延） |
| 运行记录 | `.dev-server.json`（模式、进程号、端口、地址），日志 `.dev-logs/server.log` |
| 单元测试 | `npm test`（Node 内置 `node --test`，87 个用例：三款游戏的引擎层 + 存储层 + 站点图标生成器，全部与框架无关） |
| 生产体积 | 首页入口 `index.js` gzip 38.41 kB（含 vue + vue-router）；三款游戏各自独立分包：弹球 9.29 kB、贪吃蛇 6.88 kB、方块堆叠 9.45 kB |
| 玩家数据 | 浏览器本地 `localStorage`（键前缀 `sky-games:`）：最高分、累计局数、最近 20 局战绩、静音等偏好 |
| 静态托管 | GitHub Pages（`actions/deploy-pages`）；站点前缀由 `VITE_BASE` 注入，`dist/404.html` 充当 SPA 回退。见「静态托管到 GitHub Pages」 |

## 为什么选 Vue 而不是 React

结论：**这个项目选 Vue 3**。理由是需求形态决定的，不是偏好——下面每条都对应仓库里的实际代码。

1. **60 fps 主循环与 React 的渲染模型天然冲突。** 游戏每帧都要更新小球、挡板、砖块，但只有
   6 个 HUD 数字需要进 DOM。Vue 3 的细粒度响应式让 `hud.score` 变化只替换那一个文本节点，
   主循环里的 `game` 对象完全游离在渲染体系之外（`src/games/breakout/game.js` 是纯 ES Module，
   不 import 任何 Vue）。换成 React，函数组件要么每帧重渲染整棵组件树，要么必须把循环塞进
   `useRef`/`useEffect` 并长期和 stale closure、依赖数组搏斗——这正是 React 做游戏最容易写错的地方。

2. **UI 结构是"一个 canvas + 少量外壳"，JSX 的优势用不上。** 需要表达的元素是静态的：
   侧栏标签、四个按钮、道具说明。Vue 模板编译器会把它们提成渲染函数外的静态块，diff 成本更低；
   React 的表达式组件能力在这里没有回报，只多出 key、memo、引用相等的心智负担。

3. **移动端体积敏感。** 首屏要能加载的字节数直接决定手机上的进入速度。实测当前入口
   （Vue + vue-router + 外壳）gzip 38.41 kB；React 18/19 仅 `react-dom` 就约 40–45 kB gzip，
   再加路由，首页体积翻倍，而且这些字节对游戏本身没有任何贡献。

4. **三端适配需要大量条件样式，Vue 的 SFC 更省事。** 设备档位写在
   `<html data-device data-orientation>` 上，各组件用 `<style scoped>` 里的属性选择器响应
   （按钮最小 48px、侧栏宽度、横竖屏列数），零运行时。React 侧等价做法要么引 CSS-in-JS
   （styled-components/Emotion 再加 10–20 kB 运行时），要么 CSS Modules + 全局选择器拼装，
   样式与组件的关联被拆散。

5. **"进入某个游戏才下载那个游戏"的语义，`defineAsyncComponent` 更贴合。** 注册表里
   `load: () => import("./breakout/BreakoutView.vue")` 天然产生一个 chunk；Vue 的
   `defineAsyncComponent` 自带 loading/error/延迟与重试选项，不需要额外包 Suspense 边界。
   React 的 `lazy` 必须搭配 `<Suspense>`，且配合路由时边界处理至今仍偏繁琐。

6. **生态收敛，决策成本低。** 路由是官方 vue-router，样式是原生 CSS，状态用 `ref/reactive`
   就够（本项目没有服务端派生数据），不需要在 Redux/Zustand/React Query/`useMemo` 之间做一轮选型。

诚实标注两点边界：
- 第 4、5 条属于"Vue 更省力"，不是"React 做不到"；React 同样能把引擎留在框架外。
- 若需求变成**服务端渲染 + 数据密集的管理后台**，或团队已有大量 React 资产，
  答案会翻向 React（Next.js 生态明显更成熟）。本项目是纯前端、交互密集、单屏无 SEO，
  所以这些翻盘条件都不成立。

## 快速开始

```bash
npm install        # 首次；若 npm 10.8.2 报 arborist "edgesOut" 空指针，改用下面两条分步安装
npm install --save-exact vue@3.5.13 vue-router@4.4.5
npm install --save-dev --save-exact vite@5.4.11 @vitejs/plugin-vue@5.2.1

npm run dev        # 后台启动开发服务，打印地址/进程号/日志路径
npm run build      # 产出 dist/
npm run preview    # 后台预览 dist/（未构建会直接提示）
npm run stop       # 关闭
npm run restart    # 重启
npm run status     # 地址、端口、进程号、模式
npm run logs       # 最近 30 行日志
npm test           # node --test test/，87 个用例（三款游戏引擎层 + 存储层 + 图标生成器）
npm run icons      # 改了 scripts/gen-icons.mjs 的像素矩阵后，重新生成 public/ 里三个图标
```

底层等价命令：`node scripts/dev.mjs <start|stop|restart|status|logs|preview> [--port 5173]`。

启停可靠性做法（`scripts/dev.mjs`）：
- 只解析**本次启动新增**的 Vite 日志（按启动前日志字节偏移切片），不会被上一次运行留下的 URL 误导。
- Vite 在 `vite.config.js` 里对 dev/preview 都注入 `X-Sky-Games: <进程号>` 响应头，脚本启动后回读首页
  校验该头与 PID 一致，因此不会被别的程序占用同名端口骗出"假成功"（此时打印抢占来源并以退出码 1 结束）。
- 只有校验通过才写 `.dev-server.json`；`stop` 前用 `ps -p <pid> -o args=` 确认命令行确实是 vite。
- 端口占用时 Vite 以 `strictPort: false` 自动顺延，脚本按真实 URL 记录，并提示"默认端口已被占用"。

## 三端适配（手机 / 平板 / PC）

档位判定只有一个来源：`src/utils/device.js`

| 条件 | 档位 |
| --- | --- |
| 短边 < 500 | `phone` |
| 长边 ≤ 1400 且短边 < 1000 | `tablet` |
| 其余 | `desktop` |

`orientation()` 由宽高关系给出 `portrait`/`landscape`，两者都写进 `<html data-device data-orientation>`，
CSS 与游戏度量共用同一份判定，不会出现"界面按平板排、手感按手机算"的分裂。

核心思路：**逻辑场地随容器长宽比伸缩，速度按高度同比放大**（`src/games/breakout/layout.js`）。

```
aspect = clamp(容器宽 / 容器高, 0.55, 3.4)
height = clamp(round(800 / aspect), 420, 1200)
width  = clamp(round(aspect * height), 800, 1600)
speedScale = height / 600        → 垂直穿越时间恒定
```

- 竖屏拿到瘦高场地、横屏拿到宽扁场地，画布不再两侧留大片空白。
- 实测 6 档视口（手机竖/横、平板竖/横、桌面窄/宽）画布填充率 97%–100%，
  垂直穿越场地耗时三端一致约 **1.58 秒**。
- 度量全部由场地推导：挡板宽度占比手机 0.19 / 平板 0.16 / 桌面 0.14，
  小球直径、砖块高度、HUD 高度同理随场地缩放，触控目标在手机上最大。
- 布局差异：桌面右侧 300px 侧栏；平板横屏 240px 侧栏 + 按钮两列，平板竖屏改为上下堆叠 +
  6 列统计；手机全部堆叠、按钮最小高度 48px、横屏收起道具说明以保住画布高度。
- 输入统一走 Pointer Events：触屏单指拖动挡板（`preventDefault` 防页面滚动）、轻点发射；
  桌面另有 `←→`/`AD`、`空格`、`P`、`R`、`M`。旋转、分屏、窗口缩放由 `ResizeObserver` 触发
  `game.relayout()`：**按砖块 id 保留已受损耐久**，小球位置按新旧场地宽高比映射并 clamp 回场内，
  吸附中的小球重新贴回挡板。

### 每款游戏各自的"恒定"口径

弹球的场地是连续量，只能保证"垂直穿越时间"一致；贪吃蛇与方块堆叠是格子游戏，可以把恒定做得更强——
**可见行列数与速度单位（格/秒）在三端完全相同**，屏幕大小只改变格子的像素边长。

| 游戏 | 恒定量 | 随档位变化的量 | 旋转屏幕的代价 |
| --- | --- | --- | --- |
| 像素弹球 | 垂直穿越场地 1.58 s（`speedScale = 场地高 / 600`） | 场地长宽比、挡板占比、球直径 | 位置按宽高比映射，砖块耐久按 id 保留 |
| 像素贪吃蛇 | 格子总数 260：竖屏 13×20、横屏 20×13，8 档速度 4.2–14 格/秒 | 格子边长（`fitBoard` 内接容器） | 整条蛇做一次 90° 双射（正/逆变换互逆），长度、自身相交、与墙的距离全保持 |
| 方块堆叠 | 场地恒定 10×20，16 档重力 0.9→0.1 s/格 | 格子边长与画布内两侧预览面板的可见性（`showPanels`） | 无需搬运局面（行列不变），只重算度量并 clamp 当前块 |

- 蛇的转置是**可逆**的：竖→横用 `(x,y)→(旧行数-1-y, x)`、方向 `(dx,dy)→(-dy,dx)`；横→竖用它们的逆变换，
  所以横竖屏来回切三次也不会把蛇拧成 180°（`test/snake.test.js` 对这条有专门用例）。
- 三端触控目标：手机上所有按钮最小高度 48 px、方向盘 52 px；方块堆叠在触屏档位额外给出
  ←/→/旋转/软降/硬降/暂存六个按钮，纯键盘的 PC 默认收起。
- 手机竖屏优先把屏高留给画布，因此战绩列表与玩法说明在手机上隐藏（`html[data-device="phone"]`），
  平板竖屏则把它们折到画布下方排成一行。

## 玩家数据怎么存

存储层是框架无关的 [src/services/store.js](src/services/store.js)，Vue 侧只在
[src/composables/useStore.js](src/composables/useStore.js) 里包一层响应式，游戏模块不直接碰 `localStorage`。

| 键 | 内容 | 写入时机 |
| --- | --- | --- |
| `sky-games:game:<id>` | `{ v, best, plays, records[] }`，`records` 每条含时间戳、分数、到达关卡（蛇记速度档）、用时、结局（`over`/`won`/`quit`） | **一局结束时一次写入**：弹球生命用尽、蛇撞墙或占满棋盘、方块堆到顶，以及任何游戏中途点返回或点「重开」 |
| `sky-games:global` | `{ v, prefs }`，目前记 `muted` | 点「静音」时 |
| `pixel-breakout-best` | v1 的裸数字最高分 | 只读，首次读到就迁移进新结构（迁移出来的那条战绩标 `legacy`） |

设计约束：

- **不再每帧写盘**。v1 是每次分数变化都同步 `setItem`，改成一局一次；局中 HUD 的「最高」用
  `max(已存最高分, 当前分)` 现算，所以刷新纪录时界面无延迟。
- **读写全程包 try/catch**：JSON 损坏、`v` 版本不符、配额写满、隐私模式抛错，一律当空档处理并退回
  内存副本，游戏继续可玩；同时把"存储不可用"广播出去，游戏页侧栏会出现
  「本地存储写不进去…本局成绩不会保存」的提示，而不是静默丢数据或抛到主循环里。
- **战绩有条带上限**（`RECORD_LIMIT = 20`），超出只淘汰最旧明细，`plays` 仍继续累计，
  所以不会因为玩得久而把 localStorage 的 5 MB 撑爆。
- **响应式**：store 内部不是 Vue 状态，写盘后自增一个 `tick` ref，首页卡片的
  「最高 X 分 · 累计 N 局」与游戏页战绩列表因此无需刷新页面即可更新。
- 新增游戏只要决定要不要 `bestKey`（v1 遗留键，用于迁移）；不传就没有迁移步骤，
  数据从第一局开始记录在 `sky-games:game:<id>`。

边界：这些数据**只在当前设备的当前浏览器 profile 内**存在，清站点数据、换浏览器、换设备都会归零，
也没有联网排行榜。要做跨设备需要接后端存储，属于下一步（存储接口已按可替换的形态写好，
换实现时只动 `createStore` 的注入项）。

## 静态托管到 GitHub Pages

纯前端 + 纯静态，没有后端，所以 Pages 完全够用。要解决两件事，都已做好：

| 障碍 | 表现 | 解法 |
| --- | --- | --- |
| 项目站挂在 `https://<用户>/<仓库>/` 子路径 | 产物里写 `/assets/xxx.js` → 打到域名根 → **白屏** | `vite.config.js` 读 `VITE_BASE` 决定 `base`；`createWebHistory(import.meta.env.BASE_URL)` |
| Pages 没有服务端 SPA 回退 | 刷新或分享 `.../game/tetris` → **404** | 构建时额外产出 `dist/404.html`，把原始路径塞进 `?r=` 跳回站点根，路由在建 history 前还原 |

发布走 `.github/workflows/deploy.yml`：`npm ci` → `npm test`（87 例） → `npm run build` →
`actions/upload-pages-artifact` + `actions/deploy-pages`。站点前缀按仓库名自动推导
（`${{ github.event.repository.name }}`），**改仓库名或换托管位置都不用改代码**：

- 项目站（默认）：仓库名即前缀，什么都不用配。
- 用户根站点 `https://<用户>.github.io`：在仓库 Settings → Secrets and variables → Actions →
  Variables 里加 `SITE_BASE` = `/` 即可。

上手三步（本机没有 `gh` CLI，第一步要在网页上做）：

1. 在 GitHub 新建仓库并记下仓库名，`git remote add origin <地址>` 后 `git push -u origin main`。
2. 仓库 Settings → Pages → Build and deployment 的 Source 选 **GitHub Actions**（不用建 `gh-pages` 分支）。
3. 之后每次 push 到 `main` 自动发布；地址是 `https://<用户>.github.io/<仓库>/`。

验证要点（本地用一个无回退的静态服务器复现过 Pages 行为）：子路径首页 200、深链接返回 404 页并
最终渲染出对应游戏、`RouterLink` 生成的 href 自动带前缀、懒加载的游戏分包 chunk 200、
`localStorage` 在新域名下正常读写；`?r=/game/未知id` 会被注册表守卫带回首页。

两个已知代价：**成绩按 origin 隔离**，从 `localhost` 换到 Pages 域名等于从零开始（本地数据不会跟过去）；
以及托管地址是 `github.io`，国内访问不稳定，要稳定得自备域名或换国内托管。

## 站点图标

标签页、书签、iOS 主屏那颗手柄图标来自**一张 16×16 像素矩阵**（写在 `scripts/gen-icons.mjs` 里），
`public/` 下三个文件全是它的生成物：改图案只改矩阵，然后 `npm run icons`，不要直接编辑产物
（`test/icons.test.js` 有一例专门把已提交产物和当前矩阵对拍，忘了重新生成就会红）。

| 产物 | 尺寸 | 背景 | 给谁用 |
| --- | --- | --- | --- |
| `favicon.svg` | 16 格 viewBox，同行同色游程合并成 48 个 `<rect>`，`shape-rendering="crispEdges"` | 透明 | Chrome / Firefox / Edge / Safari 标签页 |
| `favicon.png` | 48×48（×3） | 透明 | 不支持 SVG favicon 的浏览器兜底 |
| `apple-touch-icon.png` | 192×192（×12） | **实心** `#0b1220` | iOS「添加到主屏幕」——Apple 不吃 SVG，透明区还会填黑 |

取色全部对齐 `src/styles/base.css`：描边 `--text-muted`、机身 `--panel`、握把 `--bg-soft`、
十字键 `--accent`、两枚按键 `--accent-2` 与 `--warn`。上下各留两行、左右各留一列空白，
所以任何圆形或圆角遮罩都切不到轮廓。

两处实现要点：
- PNG 用 Node 内置 `zlib` 手写编码（8-bit RGBA、非隔行、每扫描线 filter 0 + 自带 CRC32），**没装任何图像依赖**；
  尺寸取 16 的整数倍，最近邻放大不会半像素抖动。`sips -g pixelWidth` 能读出 48 与 192，是这台机器上唯一可用的独立校验。
- HTML 里写的是根相对路径 `/favicon.svg`。子路径托管**不会 404**：Vite 在构建时按 `base` 重写 `link[href]`
  指向 public 资源（`404.html` 作为第二个入口同样生效）。所以不要手写 `%BASE_URL%`，那是 404 页里
  `%GHPAGES_BASE_URL%`（给 JS 常量用的）的另一套机制。

诚实清单：**没有 `.ico`**（只有 legacy IE 需要，而本机无任何 ICO 校验手段，手搓容器属于无法验证的风险）；
**没有 `mask-icon`**（Safari 固定标签页的老机制）；**没有 PWA manifest**。标签页上的实际观感需要人眼确认——
内置浏览器 `visibilityState` 为 hidden，截不了图。

## 目录结构

```
index.html                       Vue 入口外壳（含 data-device 初值、安全区 meta、三条图标 link）
404.html                         GitHub Pages 的 SPA 回退页（第二个 HTML 入口，构建时注入站点前缀）
public/.nojekyll                 关掉 Pages 的 Jekyll 处理，避免产物被误过滤
public/favicon.svg               标签页图标（矢量，由脚本生成，不要手改）
public/favicon.png               标签页图标位图兜底（48×48，透明背景，生成物）
public/apple-touch-icon.png      iOS 主屏图标（192×192，实心深色底，生成物）
vite.config.js                   plugin-vue + 站点 base + 身份响应头 + 端口策略
.github/workflows/deploy.yml     push main → 测试 + 构建 + 发布到 Pages
scripts/dev.mjs                  一键启停/状态/日志（dev 与 preview 两种模式）
scripts/gen-icons.mjs            16×16 像素手柄矩阵 → 上面三个图标（图案的唯一真实来源）
src/main.js                      装配 App 与路由
src/App.vue                      外壳：顶栏 + 设备徽标 + <router-view>
src/styles/base.css              色板 token、reset、.btn/.chip/kbd 等通用件
src/router/index.js              / → 首页，/game/:id → 游戏页（未登记 id 回首页），标题同步
src/views/HomeView.vue           首页：hero + 操作提示 + 游戏卡片网格（1/2/3 列随档位）
src/views/GameView.vue           游戏页：返回 + 标题 + defineAsyncComponent 装载具体游戏
src/components/GameCard.vue      卡片（ready 可点、soon 只展示）
src/components/DeviceBadge.vue   实时档位/朝向/视口尺寸
src/composables/useStore.js      存储层的响应式外壳（单例 store + tick 广播）
src/composables/useDevice.js     模块级单例：视口响应式状态 + 一次性监听
src/services/store.js            成绩与偏好的本地存储层（框架无关，可在 Node 里注入 storage 单测）
src/games/registry.js            游戏注册表（首页列表、路由可达性、分包入口的唯一来源）
src/games/breakout/              游戏一「像素弹球」：BreakoutView.vue + game/physics/layout/levels/powerups/renderer/input/audio
src/games/snake/                 游戏二「像素贪吃蛇」：SnakeView.vue + game/grid/layout/renderer/input/audio
src/games/tetris/                游戏三「方块堆叠」：TetrisView.vue + game/pieces/layout/renderer/input/audio
src/utils/device.js              设备档位/朝向/视口测量
test/                            单元测试（game / physics / layout / snake / tetris / store / icons）
dist/                            构建产物（可删，接入版本库请 gitignore）
```

## 如何新增一个游戏

1. 建目录 `src/games/<id>/`，把框架无关的引擎模块放进去，再写一个 `<Id>View.vue` 作为装配层。
   三款游戏的分工都一样：`game.js` 只碰状态（不 import vue、不碰 DOM/WebAudio/localStorage），
   `layout.js` 只算几何，`renderer.js` 只画，`input.js` 只翻译事件并返回 `{ unbind }`，
   `audio.js` 只合成音色，View 负责把主循环、HUD、战绩与生命周期清理串起来。
2. 在 `src/games/registry.js` 增加一条记录：`id`、`name`、`subtitle`、`tags`、`mark`、`accent`、
   `status: "ready"`、`load: () => import("./<id>/<Id>View.vue")`。只有从 v1 裸数字键继承数据时才需要
   额外的 `bestKey`（贪吃蛇与方块堆叠就没有，战绩从第一局开始记）。
3. 在 `test/<id>.test.js` 给引擎层加用例——`node --test` 只跑得动纯逻辑，这也是"引擎必须框架无关"的回报。
4. 完成。首页自动出现卡片，路由自动接受 `/game/<id>`，构建自动多出一个独立 chunk
   （实测三款分别 gzip 9.29 / 6.88 / 9.45 kB，互不牵连）。

`/game/:id` 的 `beforeEnter` 会拦截未登记 id 并重定向首页，所以加记录即可访问，不需要改路由文件。
`status: "soon"` 是留给"先占位、后实现"的：卡片会显示「敬请期待」且不可点，也不会被打包。

## 玩法

### 像素弹球

| 目标 | 操作 |
| --- | --- |
| 移动挡板 | 鼠标 / 单指拖动 / `←` `→` / `A` `D` |
| 发射小球、确认菜单 | 轻点 / 空格 / `Enter` |
| 暂停与继续 | `P` 或 `Esc` |
| 重新开始 | `R` |
| 静音开关 | `M` |

击破全部可破坏砖块即过关（钢块 `#` 打不碎，只改变弹道）；同一次触板之间连续击破越多，
连击倍率越高（封顶 4 倍）；砖块 1–4 级耐久，耐久越高分数越高。
道具：宽板、分裂三球、缓速、护盾、加命，以及唯一的负面道具「窄板」。

### 像素贪吃蛇

| 目标 | 操作 |
| --- | --- |
| 转向 | 棋盘四向滑动 / 方向盘 ↑←→↓ / `←↑↓→` 或 `WASD` |
| 开始、继续、再来一次 | 轻点棋盘 / 空格 / `Enter` / 方向盘中心键 |
| 暂停与继续 | `P` 或 `Esc` |
| 重新开始、静音 | `R` / `M` |

每吃一个食物 10 分起步，每吃 4 个升一档、基础分再加 5，速度从 4.2 格/秒升到 14 格/秒（共 8 档）。
输入最多排队两步且拒绝反向，快速连按不会把蛇送进自己身体；撞墙或咬到自己即结束，
260 格被占满则判通关。蛇尾即将让位的那一格允许进入，所以绕圈追尾是合法操作。

### 方块堆叠

| 目标 | 操作 |
| --- | --- |
| 左右移动、软降 | 拖动（逐格）/ `←` `→` `A` `D` / `↓` `S` |
| 旋转、反向旋转 | 轻点 / `↑` `X` `W` / `Z` `Ctrl` |
| 硬降 | 快速下甩 / 空格（每格 2 分，软降每格 1 分） |
| 暂存交换 | `C` / `Shift` / 触屏「暂存」键（每块一次） |
| 暂停、重开、静音 | `P` `Esc` / `R` / `M`；触屏另有六个动作按钮 |

七种方块走 **7 袋随机**（一袋内不重复，不会连续五个头也不来长条）。消 1/2/3/4 行得
100/300/500/800 再乘以当前关卡，每累计 10 行升一关，重力从 0.9 s/格递减到 0.1 s/格（16 档后封顶）。
贴地后有 0.5 秒锁定宽限期，期间滑动或旋转可重置倒计时（最多 8 次），旋转带左右各一格、上移一格的踢墙。
新方块出生位被占才判负——堆到第 3 行不算输。

## 设计与已知限制

三款游戏共用的约定：

- **逻辑与渲染分离**：`game.js` 不引用 DOM/WebAudio/localStorage/框架，因此单测与浏览器跑的是同一份代码，
  无头模拟可直接用于平衡性检查（87 个用例全在 Node 里跑）。
- **帧率无关**：主循环只把 `deltaSeconds` 交给引擎，由引擎内部换算——弹球用 `stepScale` 折算成 60 帧
  基准步长并封顶 3；贪吃蛇与方块堆叠用时间累加器，并对单帧 delta 设上限（蛇 0.2 s、方块 0.05 s），
  所以切后台再回来不会一帧扣掉半张棋盘。
- **输入契约**：`input.js` 一律返回 `{ unbind }`，装配层 `onBeforeUnmount` 里 `input?.unbind()`。
  这个形状必须统一——蛇曾经返回裸函数，导致离开页面时 `input.unbind is not a function` 抛错、
  视图卡在卸载中间，重复进出后监听翻倍。
- **SPA 生命周期**：进入游戏才绑定输入与 rAF，离开页面时解绑输入、断开 `ResizeObserver`、取消 rAF、
  移除窗口监听、关闭 AudioContext、结算本局成绩，重复进出不会叠加监听或泄漏循环。
- **音频**由浏览器自动播放策略控制，需要首次点击或按键才解锁（静音偏好本身会记住，见上一节）。
- 成绩与偏好都存在浏览器本地，**没有联网排行榜、没有跨设备同步、没有局内进度存档**：
  关掉页面即回到开局，换浏览器即从零开始。
- 后台标签页会被浏览器冻结 `requestAnimationFrame`，这是平台行为，不是引擎回归。

弹球专属：

- **反弹按穿透深度选轴**：`bounceAgainstRect` 比较水平/竖直穿透量决定翻转哪个分量，避免小球卡进砖块。
- **两个反直觉的角度约束**：正中挡板反弹强制保留 12° 横向分量（否则小球纯竖直往返、再也打不到砖块）；
  同时限制最小竖直分量（避免近乎水平地长期贴地来回）。

贪吃蛇与方块堆叠专属：

- **格子游戏的恒定口径**：可见行列数与速度单位在三端完全一致（见上一节表格），
  新增设备档位不需要重新调难度，只影响格子画多大。
- **方块堆叠只读渲染**：`renderer.js` 不改状态，落点预览（幽灵）与堆叠警告线都在绘制时由
  `ghostY()`/`topRow()` 现算；`FIELD` 是模块级共享几何，重排时先 `applyField()` 再 `game.relayout()`，
  顺序颠倒会按旧尺寸 clamp。
