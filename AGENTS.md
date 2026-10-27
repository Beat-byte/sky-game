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
- 技术栈固定：Vue 3.5.13 + vue-router 4.4.5 + Vite 5.4.11 + @vitejs/plugin-vue 5.2.1 + three 0.186.1，全部 `--save-exact` 精确锁版本。
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
- 「危险行动」的人形只有**躯干与头盔描边**，四肢不描：恒定视口下人物只有 `radius*2 ≈ 20 px`，
  手臂/腿的短半径只有 ~2 px，比 `m.outlineWidth` 还细，全描边会被线宽整个吃掉（实测四肢像素为 0）。
  腿摆相位一律由 `draw` 传入的 `phase` 与实体 id 经 `hashJitter` 派生，**不许 `Math.random`**；
  `test/delta.test.js` 用记录型 ctx 桩对拍"同相位逐笔一致 + 渲染不写状态"，改人形要一起看这一例。
- 「危险行动」有**俯视（2D canvas）与第一人称（three/WebGL）双视图**，规矩：
  1. 引擎只认 `game.viewMode`（`topdown`/`fps`），视图模式**只改"摇杆向量怎么解释"**：fps 下摇杆
     变"沿朝向前后 + 垂直平移"，朝向一律归 `setLook()` 管（单步夹 ±1 rad，`stepFixed` 里
     `flushInput → playerTurn → playerMove` 的固定顺序消费）。速度、锥形、伤害、AI 全部不许分档。
     fps 下**自动开火不许代玩家转身**（`autoFire` 里跳过追瞄但照常开火），否则视野被人接管。
  2. WebGL 库只在第一次切到 fps 时 `await import("./three-view.js")`（独立 chunk 530 kB / gzip 134 kB，
     实测），俯视玩家不付这份下载；起不来就退回 `topdown` 并把原因写进提示条，不污染状态。
     依赖 `three@0.186.1` 是**单包** `npm install three --save-exact` 装的（多条一起装会撞 arborist 缺陷）。
  3. 相机数学全部抽在 `scene3d.js`（纯函数、node 可测），`three-view.js` 只搬运。
     **构造相机必须走 `cameraConfig(aspect)`**：`PerspectiveCamera` 的签名是 `(fov, aspect, near, far)`，
     按位置传参曾把 `0.06` 当 aspect、`34` 当 near —— 整张图落在近裁面之前，**画了 14 次 draw call
     却全黑且零报错**（readPixels 实测 0 亮像素），是这次最贵的坑。
     1:1 与宽屏锁水平 FOV 75°；**竖屏改夹垂直角**（`V_FOV_MAX_DEG = 80`）——按水平角反算会让
     9:19.5 的手机（aspect≈0.46）算出 113° 垂直角，边缘拉伸、抬头低头像翻跟头，是第一人称晕眩主因；
     竖屏因此让出一点水平视野。雾远界恒 28 m（与俯视恒视口 28×18 m 对齐），起雾点 `FOG_NEAR_RATIO = 0.5`
     （14 m）：旧值 0.25（7 m）让中景就发灰，分不清"那是墙还是箱子"。
  4. fps 下敌人必须过 `game.visible()` 裁剪。俯视"敌人一律画"是上帝视角的约定，
     照搬进 3D 等于隔墙看人（作弊）。
  5. 两张画布靠 `.stack`（`display:grid` + `.stack > canvas { grid-area: 1/1 }`）同格叠放：
     GL `z-index:1`，2D 画布在 fps 下加 `.overlay`（`z-index:2` + `background:transparent`）只画右上角
     小地图（`drawMinimapOverlay` 先 `clearRect` 整块场再画），准星层 `pointer-events:none`。
     输入仍绑在 2D 画布上（它在上层），切回俯视时 `.overlay` 类消失、实心背景回来。
     **但命中测试按绘制顺序、不按像素透明度**：透明叠层照样吃掉它下面的按钮。所以局内所有 UI
     （`.pads`/`.top`/`.search`/`.exfil`/`.pulse`）都要 `z-index:5`、暂停面板 `.cover` 用 `6`，
     否则切进第一人称后 8 个按钮全点不动（实测），连"切回俯视"都点不了。
     局内的失败原因必须有地方显示：`.stage-msg`（`bottom:64px`、`pointer-events:none`、`z-index:6`）
     配 `flash(text)` 定时消失；`ensureThreeView()` 拿不到画布要 **throw**，静默 `return null` 会让
     `viewMode` 变成 fps 而画面仍是俯视，玩家以为按钮坏了。退回俯视时要连**偏好**一起写回 `topdown`。
  6. 验证只能靠可观测信号（内置浏览器截不了图）：DEV 钩子 `window.deltaSetView/deltaView/deltaThree/
     deltaGlSample/deltaFrames`。`deltaGlSample` 在同一轮任务里 sync+render 再 `readPixels`，
     并回传 `info()` 的 `calls/triangles/lights/cam.near/cam.far`——**实测 14~17 calls、94 种颜色、
     中心 86% 亮像素**才算这个视图真的活了。昼夜两张图要各自复验：夜间图（`port`）旧参数实测整屏
     67% 落在 `rgb(3,6,15)`（等于全黑），调完后该区域是 `rgb(12,21,35)`、`meanSum` 24 → 87、近黑像素 0.7%。
  7. **颜色只有 `scene3d.js` 一份真实来源**（`BLOCKS[?].color` 本体 + `BLOCKS[?].cap` 顶盖、
     `GROUND_COLORS`、`LIGHTS`、`FIGURE_TONE`、`EXFIL`），`renderer.js` 用 `cssHex()` 派生、
     `three-view.js` 直接用数值，**两边都不许再写十六进制**。可回归的下限全在 `test/delta.test.js`：
     七类本体两两 ΔE ≥ 25、顶盖两两 ≥ 18、顶盖 vs 本体 ≥ 20（拉不开就没有体积感）、
     本体 vs 地面 ≥ 26、本体 vs 雾 ≥ 22（**墙原来对雾只差 8，一走近就整块化进雾里**）、
     敌人三态 vs 每类本体 ≥ 22、地面棋盘双色 6~20（要给移动提供光流线索，太花会抢注意力）。
     ΔE 只管"相差多少"，不管"有多黑"，所以另有**夜景绝对亮度下限**：地面/雾的 L\* 与半球光、
     平行光强度都设了地板，且 `LIGHTS.night` 总强度必须低于白天。
     形状提示层：矮容器加亮顶盖（`CAP_M`，比盒顶高 1 cm 防 z-fighting）、墙加视线高度横带
     （`BAND_M`，y=1.5 m、外扩 4 cm），`marks` 与 `groups` 分两个数组是为了保住
     "groups 实例数 == 网格实体格数"这条不变量。俯视的容器首字用 `inkOn(底色)` 取墨色
     （亮底走同色相深墨、暗底走浅蓝白），标签一律带暗色描边（`label(..., halo)`），
     小地图也走同一张色板——原来容器/墙两块灰蓝在 3 px 格子上分不出"能搜"和"进不去"。
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
- `node --test` 覆盖四款游戏的引擎层、存储层与图标生成器（140 个用例：弹球 `game` 12 + `physics` 10 +
  `layout` 13（含 delta 视野/画布盒子交叉校验）、`snake` 18、`tetris` 21、`delta` 41、`store` 18、`icons` 6）；
  `delta` 里第一人称那一组（`fovForAspect`/`cameraConfig`/`yawFor`/`buildSceneSpec`/`eyePose`、
  双视图位移与转向解耦、自动开火不转身、小地图叠层，以及配色 ΔE 下限、形状提示层、抗晕参数、
  夜景绝对亮度、顶盖墨色对比）全靠 `scene3d.js` 是纯函数才跑得进 Node——
  **新增 3D 数学与色板一律进 `scene3d.js`，别写进 `three-view.js`（那里没有 WebGL，测不了）**；
  改几何/度量要同步 `test/layout.test.js` 的档位期望值，
  改存储结构要同步 `test/store.test.js` 并递增 `SCHEMA_VERSION`（否则老用户数据会被当空档），
  改像素矩阵要跑 `npm run icons` 重新提交产物，否则 `icons` 第 5 例直接红。
- **游戏主循环一律"rAF 为主 + 非 rAF 驱动源兜底"，只挂 rAF 等于没做兜底**。delta 用
  `src/games/delta/tick.js`（Vite `new Worker(new URL(..., import.meta.url), {type:"module"})`）按 60 Hz
  发 `postMessage` 心跳，主线程收到就 `pump(performance.now())`；三个驱动源（rAF / Worker / setInterval 看门狗）
  共用同一条 `pump` 和同一个时间游标 `last`，所以谁先到达都只按真实流逝推进，不会翻倍。
  Worker 心跳只在 `phase === "playing"` 期间启动（`postMessage("start"/"stop")`），卸载必须 `terminate()`。
  Worker 不发送时间戳（跨上下文 `performance.timeOrigin` 不保证同基准，会算出负 dt），生产构建里它是独立
  chunk `dist/assets/tick-*.js`（`VITE_BASE=/game/` 实测解析为 `/game/assets/tick-*.js`，子路径可用）。
- 生产构建里 `import.meta.env.DEV` 为假，调试入口只存在于 dev：弹球 `window.game`/`window.layout`/
  `window.relayout`，贪吃蛇 `window.snake`/`window.snakeLayout`/`window.snakeRelayout`，
  方块堆叠 `window.tetris`/`window.tetrisLayout`/`window.tetrisRelayout`，
  危险行动 `window.delta`/`window.deltaLayout`/`window.deltaRelayout`/`window.deltaFrames`/
  `window.deltaSetView`/`window.deltaView`/`window.deltaThree`/`window.deltaGlSample`。
  在浏览器里驱动游戏做回归，必须连 dev 服务。

### 浏览器验证的已知限制
- Qoder 内置浏览器未打开时页面 `visibilityState` 为 `hidden`：`requestAnimationFrame` 完全冻结
  （实测 600 ms 内 0 帧），且后台标签的 `setTimeout` 被节流到秒级——脚本里多次 `await wait()` 会撞
  15 秒超时。因此 `take_screenshot` 会报 `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`，只能靠
  `evaluate_script` 读 DOM/画布像素做结构验证。
- **2026-10-27 在同一 hidden 页面里实测四种驱动源（各跑 2 秒）**：`requestAnimationFrame` **0 次**、
  `setInterval(16ms)` **3 次**（被逐级节流到约 600 ms～1 分钟一次）、
  **Web Worker 的 `postMessage` 177 次（≈88 Hz，不受节流）**、`MessageChannel` 自循环瞬间跑满 3000 次。
  结论：hidden 页面里唯一可靠的节拍来自 Worker；`setInterval` 兜底只能救"切到别的窗口"，救不了预览面板。
  验证"游戏到底动没动"要**直接比较 `performance.now()` 差值与 `game.timeSec` 差值**（实测比值 1.000），
  不要靠肉眼看截图，也不要把 `setTimeout(1000)` 当成 1 秒墙钟——它在该环境里会迟到近一倍。
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
