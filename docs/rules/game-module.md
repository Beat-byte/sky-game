# 游戏模块分工、主循环与恒定难度

改任何一款游戏的引擎或视图前先读这份。危险行动的双视图专属规矩另见 [delta.md](delta.md)，
愤怒的小鸟的求解器/材质/关卡/几何地板另见 [birds.md](birds.md)。

## 模块边界
- 游戏引擎模块必须保持**框架无关**（纯 ES Module，不 import vue）；只有 `*.vue` 装配层允许依赖 Vue。
- 新增游戏 = 加 `src/games/<id>/` 目录 + 在 `src/games/registry.js` 加一条记录。
  **不要改路由文件，也不要改别的游戏的目录或公共组件**（各游戏互不引用）。
  入口三件套（注册表 + 视图 + 首页卡片）是第一步，不是最后一步。
- 每款游戏内部分工固定：`game.js` 状态、`layout.js` 几何、`renderer.js` 只画不改状态、
  `input.js` 只翻译事件、`audio.js` 只合成音色、`<Id>View.vue` 装配主循环/HUD/战绩/卸载清理。

## 卸载清理（踩过坑）
- **`input.js` 必须返回 `{ unbind }`**（贪吃蛇曾返回裸函数，卸载时抛错，视图卡在半个卸载过程）。
- View 的 `onBeforeUnmount` 里依次：`endSession("quit")` → 取消 rAF → 断开 `ResizeObserver` →
  移除窗口监听 → `input?.unbind()` → `audio?.dispose()` → 删掉 DEV 调试全局。

## 主循环：rAF 为主 + 非 rAF 驱动源兜底
- **只挂 rAF 等于没做兜底**（内置浏览器 hidden 页面里 rAF 一帧都不走，实测数据见
  [browser-verify.md](browser-verify.md)）。
- delta 与 birds 各带一份 `tick.js`（`src/games/delta/tick.js`、`src/games/birds/tick.js`，
  Vite `new Worker(new URL(..., import.meta.url), {type:"module"})`）按 60 Hz 发 `postMessage` 心跳，
  主线程收到就 `pump(performance.now())`。
- 三个驱动源（rAF / Worker / setInterval 看门狗）**共用同一条 `pump` 和同一个时间游标 `last`**，
  所以谁先到达都只按真实流逝推进，不会翻倍。
- Worker 心跳只在 `phase === "playing"` 期间启动（`postMessage("start"/"stop")`），卸载必须 `terminate()`。
- Worker 不发送时间戳（跨上下文 `performance.timeOrigin` 不保证同基准，会算出负 dt）。
- 生产构建里 Worker 是独立 chunk `dist/assets/tick-*.js`（`VITE_BASE=/game/` 实测解析为
  `/game/assets/tick-*.js`，子路径可用）。

## 难度与设备无关（渲染层与逻辑层共同的铁律）
- **不许 `Math.random`**：抖动、花纹、相位一律由整数格号 / 实体 id / 传入的 `phase` 经 `hashJitter` 派生，
  这样同一帧画两次结果一致，"渲染不改状态"的单测和截图对拍才成立。
- 格子类游戏（贪吃蛇、方块堆叠）**行列数在三端恒定**：蛇竖屏 13×20 / 横屏 20×13（总数恒 260，
  旋转用互逆的 90° 双射），方块恒定 10×20。
- 速度一律按"格/秒"或"秒/格"定义，不许按像素或设备档位分档调难度；
  弹球因为是连续场地才用 `speedScale` 保证穿越时间恒定。
- 连续物理的另一份实现是愤怒的小鸟：**横向可见米数恒 15 m**（`ppm` 只决定画多大、不参与判定），
  发射功率按**屏幕行程**归一（`pullRef = min(css.w, css.h) × 0.13`，地板 28 px），
  否则小屏必须拖更长才打得远，等于变相惩罚手机玩家。
- 渲染层能读 `metricsFor` 的只有线宽/字号/小地图边长这类装饰量；
  任何"手机上画小一点所以更难看见"都不允许。

## DEV 调试钩子（生产构建里 `import.meta.env.DEV` 为假，全部不存在）
- 弹球 `window.game` / `window.layout` / `window.relayout`
- 贪吃蛇 `window.snake` / `window.snakeLayout` / `window.snakeRelayout`
- 方块堆叠 `window.tetris` / `window.tetrisLayout` / `window.tetrisRelayout`
- 危险行动 `window.delta` / `window.deltaLayout` / `window.deltaRelayout` / `window.deltaFrames` /
  `window.deltaSetView` / `window.deltaView` / `window.deltaThree` / `window.deltaGlSample` /
  `window.deltaBoxes`（全屏层、画布格子、控制带、可见摇杆与逐按钮的 `elementFromPoint` 命中，
  外加 `bareCanvasHit` —— 浮层容器有没有吃掉画布触控）/
  `window.deltaStick()`（摇杆 DOM 圈态 + 引擎向量）/ `window.deltaTrigger(bool)`（扳机两态）
- 愤怒的小鸟 `window.birds` / `window.birdsLayout` / `window.birdsCamera` / `window.birdsRelayout` /
  `window.birdsLevel(i)` / `window.birdsShoot(power, angle)` / `window.birdsBoxes`（同一套逐按钮命中，
  细节见 [birds.md](birds.md)）
- 新增视图能力时同步补钩子：验证只能靠可观测信号，没有钩子就等于没法验收。
