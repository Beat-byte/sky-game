# 项目规则

## 环境信息（2026-10-26 实测）

### 运行时
- 系统：macOS 15.7.7，arm64（Apple 芯片）
- 终端：`/bin/zsh`；当前目录 `/Users/skyf/Documents/program/sky/qoder/game`（非 git 仓库）
- **系统 Node：v20.19.5**，路径 `/usr/local/bin/node`（Bash 工具里 `node` 实际解析到的版本）
- **Qoder 智能体自带 Node：v24.18.0**（与应用内运行时一致，与终端 `node` 不同）
- npm 10.8.2 / npx 10.8.2
- 未安装版本管理器（无 nvm、volta、fnm、asdf）
- 无 pnpm、yarn、bun，也无全局 tsc
- git 2.50.1（Apple Git）、Python 3.12.10

### 对本项目的影响
- 代码按 Node v20 的 API 和语法编写，不要假设 v22/v24 独有特性在运行时可用。
- 依赖只用 `npm` 安装；`pnpm`、`yarn`、`bun` 命令视为不可用，除非用户自行安装。
- 类型检查通过本地安装的 typescript 执行（`npx tsc`），不要直接调用全局 `tsc`。
- 若任务确实需要更新的 Node 版本，需明确说明，而不是隐性依赖智能体的 v24。

## 沟通与产出约定
- 与用户的所有回复、文档、注释均使用中文，禁止生成英文内容（代码标识符与第三方命令名除外）。

## 工程约定（v2.0.0，Vue + Vite 之后）
- 技术栈固定：Vue 3.5.13 + vue-router 4.4.5 + Vite 5.4.11 + @vitejs/plugin-vue 5.2.1，全部 `--save-exact` 精确锁版本。
- **`npm install vue vue-router vite @vitejs/plugin-vue` 一条命令会触发 npm 10.8.2 的 arborist 缺陷**
  （`Cannot read properties of null (reading 'edgesOut')`，与网络无关）。绕法：拆成"运行时依赖"和
  "开发依赖"两条命令、并带 `--save-exact`。后续新增依赖沿用这个拆法。
- 游戏引擎模块必须保持框架无关（纯 ES Module，不 import vue）；只有 `*.vue` 装配层允许依赖 Vue。
  新增游戏 = 加 `src/games/<id>/` 目录 + 在 `src/games/registry.js` 加一条记录，不要改路由文件，
  也不要改别的游戏的目录或公共组件（三款游戏互不引用）。
- 每款游戏内部的分工固定：`game.js` 状态、`layout.js` 几何、`renderer.js` 只画不改状态、
  `input.js` 只翻译事件、`audio.js` 只合成音色、`<Id>View.vue` 装配主循环/HUD/战绩/卸载清理。
  **`input.js` 必须返回 `{ unbind }`**（贪吃蛇曾返回裸函数，卸载时抛错，视图卡在半个卸载过程）；
  View 的 `onBeforeUnmount` 里要依次 `endSession("quit")`、取消 rAF、断开 `ResizeObserver`、
  移除窗口监听、`input?.unbind()`、`audio?.dispose()`、删掉 DEV 调试全局。
- 格子类游戏（贪吃蛇、方块堆叠）的**行列数在三端恒定**：蛇竖屏 13×20 / 横屏 20×13（总数恒 260，
  旋转用互逆的 90° 双射），方块恒定 10×20。速度一律按"格/秒"或"秒/格"定义，
  不许按像素或设备档位分档调难度；弹球因为是连续场地才用 `speedScale` 保证穿越时间恒定。
- **持久化只走 `src/services/store.js`**（框架无关，注入 `storage` 即可在 Node 里测）：
  键前缀 `sky-games:`，每游戏一份 `{v,best,plays,records[]}`、全局一份 `{v,prefs}`，schema 版本号为 1。
  游戏模块与组件**不得直接调用 `localStorage`**；组件侧只用 `src/composables/useStore.js` 暴露的
  `useGameStats/usePrefs/useStorageAvailable/useStore`。写入时机是"一局结束"（over/won/quit），
  不要在帧循环里落盘；读写必须 try/catch 并退回内存副本，不能把异常抛进主循环。
  战绩上限 `RECORD_LIMIT = 20`。v1 的裸键 `pixel-breakout-best` 由注册表 `bestKey` 驱动一次性迁移，勿删。
- 服务与端口：`npm run dev` → Vite dev（默认 5173）；`npm run build && npm run preview` → 预览 dist
  （默认 4173）。两者都由 `scripts/dev.mjs` 托管，`stop/status/logs` 同样走它；模式记录在
  `.dev-server.json`。Vite 响应头 `X-Sky-Games: <pid>` 用于启停脚本自检，勿删。
- **静态托管（GitHub Pages）的四个耦合点，改动前先看这里**：
  1. `vite.config.js` 用 `VITE_BASE` 算 `base`（本地不注入即 `/`），路由必须
     `createWebHistory(import.meta.env.BASE_URL)`；页面与组件里**不得出现 `/assets/...`、
     `href="/..."` 这类根绝对路径**，跳转一律 `<RouterLink :to="{ name: ... }">`。
     **唯一例外**是 HTML 里指向 `public/` 的资源（站点图标）：那种 `href="/favicon.svg"` 必须写根相对路径，
     Vite 构建时按 `base` 重写（已实测 `dist/index.html` 与 `dist/404.html` 都变成 `/前缀/favicon.svg`），
     手写 `%BASE_URL%` 或挪进 `src/` 反而是错的。
  2. `404.html` 是**第二个 rollup 入口**（`build.rollupOptions.input.fallback`），靠同名插件的
     `transformIndexHtml` 把 `%GHPAGES_BASE_URL%` 换成真实前缀。删掉这个 input 或改占位符名，
     发布产物就没有 SPA 回退。别把 404.html 放进 `public/`——那里头的文件不会被 Vite 处理，
     占位符会原样留在线上。
  3. 深链接回退约定是 `?r=<站内路径>`：404 页把原始路径塞进查询参数跳回站点根，
     `src/router/index.js` 必须在 **`createRouter` 之前**用 `history.replaceState` 还原地址栏
     （`createWebHistory` 在创建的那一瞬间就读走了 `window.location`，晚了就来不及）；
     还原时要校验路径以单个 `/` 开头且只含 `[\w\-./]`，防开放重定向。
  4. 站点图标是**生成物**：`scripts/gen-icons.mjs` 里那张 16×16 像素矩阵是唯一真实来源，
     `public/favicon.svg`、`public/favicon.png`(48)、`public/apple-touch-icon.png`(192) 由它产出并提交进仓库。
     改图案只改矩阵再跑 `npm run icons`，**不要手改产物**（`test/icons.test.js` 会把已提交产物与矩阵对拍）。
     PNG 是 Node 内置 `zlib` 手写编码的（本机只有 `sips`，不能栅格化 SVG 也不能出 ICO，所以不做 `.ico`）；
     尺寸必须是 16 的整数倍，`apple-touch-icon` 必须是实心背景（iOS 把透明填黑）。
  - `.github/workflows/deploy.yml` 按 `github.event.repository.name` 推导前缀，托管到用户根站点时
    改用仓库变量 `SITE_BASE=/`。`npm ci` 已实测可用（lockfile 根条目仍写着 v1 的
    `qoder-breakout` 名字，npm 不校验该项；要改就重新生成 lock，注意 npm 10.8.2 的 arborist 缺陷）。
  - 验证托管要在本地起一个**无 SPA 回退**的静态服务器（未命中返回 404.html + 404 状态码），
    Pages 不会替你回退；直接 `npm run preview` 会因 Vite 的 spa 回退而掩盖问题，测不出深链接。
- `node --test` 覆盖三款游戏的引擎层、存储层与图标生成器（87 个用例：`game`/`physics`/`layout` 弹球 31、
  `snake` 18、`tetris` 21、`store` 11、`icons` 6）；改几何/度量要同步 `test/layout.test.js` 的档位期望值，
  改存储结构要同步 `test/store.test.js` 并递增 `SCHEMA_VERSION`（否则老用户数据会被当空档），
  改像素矩阵要跑 `npm run icons` 重新提交产物，否则 `icons` 第 5 例直接红。
- 生产构建里 `import.meta.env.DEV` 为假，调试入口只存在于 dev：弹球 `window.game`/`window.layout`/
  `window.relayout`，贪吃蛇 `window.snake`/`window.snakeLayout`/`window.snakeRelayout`，
  方块堆叠 `window.tetris`/`window.tetrisLayout`/`window.tetrisRelayout`。在浏览器里驱动游戏做回归，
  必须连 dev 服务。

### 浏览器验证的已知限制
- Qoder 内置浏览器未打开时页面 `visibilityState` 为 `hidden`：`requestAnimationFrame` 完全冻结
  （实测 600 ms 内 0 帧），且后台标签的 `setTimeout` 被节流到秒级——脚本里多次 `await wait()` 会撞
  15 秒超时。因此 `take_screenshot` 会报 `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`，只能靠
  `evaluate_script` 读 DOM/画布像素做结构验证。
- 需要跑主循环时：先覆盖 `window.requestAnimationFrame`/`cancelAnimationFrame` 捕获回调，再
  **重新挂载一次游戏组件**，然后手动按递增时间戳泵帧；这样 `syncStatus()` 与 `draw()` 才会执行，
  才能验证 HUD 文本与画布像素。两条铁律：
  1. **换路由要用真实锚点点击**（首页卡片 `a.card[href="/game/<id>"]`、返回链接 `a[href="/"]`），
     别再用 `history.pushState` + 派发 `popstate`——vue-router 认不出自造 state，路由状态更新了但
     视图不换，后面所有断言都打在旧组件上。
  2. **一次 `evaluate_script` 只有一轮微任务/宏任务**，同步读 DOM 拿到的是上一次 flush 的旧文本；
     需要 DOM 反映最新状态时，脚本末尾 `await new Promise(r => setTimeout(r, 60))` 再读。
     页面在两次工具调用之间可能被重置回首页，所以整条回归（进游戏→开局→泵帧→结束→读 localStorage）
     尽量写在同一个脚本里。
- 泵帧时间戳必须**递增且大于挂载时的 `performance.now()`**（例如从 1e7 起每帧 +16.7 ms）；
  恒定时间戳会让 `delta` 为 0，递增不足则被 View 里的负 delta 夹成 0，游戏看着不动。
- 画布像素检查：`getImageData` 统计亮像素数（蛇一局约 5–6 千、方块含侧栏面板约 7–8 万），
  为 0 说明主循环没跑或 `setupCanvas` 没被调用。

## 维护说明
- 更新本节前先重新执行 `node -v`、`npm -v`、`which node`、`uname -m`、`sw_vers -productVersion`；版本管理器与智能体运行时都可能变化。
