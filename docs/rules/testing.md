# 测试：分布与"改 X 要同步 Y"

跑法：`npm test`（等价 `node --test`，无需构建、无需浏览器）。基线 **178 例全绿**。

## 分布（178 例）

| 文件 | 例数 | 覆盖 |
| --- | --- | --- |
| `test/game.test.js` | 12 | 弹球 `game.js` 状态 |
| `test/physics.test.js` | 10 | 弹球碰撞/反射 |
| `test/layout.test.js` | 16 | 三端几何档位，含 delta 视野/画布盒子交叉校验、手机全屏每米像素地板与旋转抢跑时容器接管、弹球手机全屏舞台画布与穿越时间恒定 |
| `test/snake.test.js` | 19 | 贪吃蛇引擎（含旋转双射）、手机全屏舞台的格子边长地板 |
| `test/tetris.test.js` | 22 | 方块堆叠（含 7 袋随机、锁定、消行）、手机全屏舞台的行列恒定与画布铺满 |
| `test/delta.test.js` | 45 | 危险行动：引擎、双视图、色板与抗晕参数（含按住扳机与自动开火两条通道互不污染、俯视也消化 `setLook`、右摇杆转向时"推哪走哪"与追瞄让路） |
| `test/delta-input.test.js` | 8 | 危险行动输入层：假 DOM 桩上的摇杆向量归零、可见摇杆坐标与半径夹取、多指接力、第一人称转向分区、固定双座的座心原点与按下即形变、转身座连续量与座外像素增量共存、**座内短按不算"轻点＝搜刮"而座外与浮动档位仍算** |
| `test/birds.test.js` | 22 | 愤怒的小鸟：求解器下限（材质门槛、TNT 连锁范围）、六关自检与预沉降自稳、物理确定性、屏幕功率归一与三端视野地板、状态机（一发入魂/哑弹判负/暂停冻结）、渲染逐笔一致、引擎源码扫描 |
| `test/store.test.js` | 18 | 持久化层（注入 fake storage） |
| `test/icons.test.js` | 6 | 像素矩阵与已提交产物对拍 |

## 哪些东西能进 Node，全靠分层

- `delta` 里第一人称那一组 —— `fovForAspect` / `cameraConfig` / `yawFor` / `buildSceneSpec` / `eyePose`、
  双视图位移与转向解耦、自动开火不转身、小地图叠层，以及配色 ΔE 下限、形状提示层、抗晕参数、
  夜景绝对亮度、顶盖墨色对比 —— **全部依赖 `scene3d.js` 是纯函数**才能在 Node 里跑。
- **新增 3D 数学与色板一律进 `scene3d.js`，别写进 `three-view.js`**（那里没有 WebGL，测不了）。
- `birds` 能在 Node 里跑完整一局，靠的是同一套分层：`physics.js` / `levels.js` / `layout.js` / `game.js`
  全是纯逻辑（`layout.js` 里 `window` 不存在时 dpr 退回 1），技能、连锁、预沉降、星数都能直接喂帧验证。
  **材质表与鸟种表的真实来源分别是 `physics.js` 与 `levels.js`，`renderer.js` 只 import 不复制。**
- 渲染层用 `test/delta.test.js` 的记录型 ctx 桩做"同相位逐笔一致 + 渲染不写状态"对拍：
  给 `renderer.js` 加新的 canvas 手段（如 `strokeText`、`lineJoin`）要**同步补桩**，否则直接崩
  （`test/birds.test.js` 的桩只认字符串键，Symbol 键一律 `undefined`；参数里的对象统一记成 `<obj>`，
  否则 `String(proxy)` 会抛 "Cannot convert object to primitive value"）。
- 存储层与图标生成器都靠"注入依赖"（`storage` / 文件读写）而不是 mock 全局，新增模块沿用这个写法。
- `delta/input.js` 是唯一读浏览器事件的一层，`test/delta-input.test.js` 用**假 emitter 桩 + 临时挂到
  `globalThis` 的 `window`/`document`**（`bindInput` 会往这两个上挂监听，Node 里默认不存在）测它。
  新增事件通道请照这一例补，别把归零逻辑只交给真机手感 —— "手指离开还在往前跑"就是这么漏掉的。

## 改 X 必须同步 Y（漏一项就有线上代价）

- 改**几何/度量/视口档位** → 同步 `test/layout.test.js` 的档位期望值。
- 改 **`src/styles/playfield.css`（手机全屏层）** → 同步四款视图里"手机档位不写规则"的约定，
  并重量 `sideScroll`/`elementFromPoint`（带内排布一改就可能把最下面一排按键顶出屏幕），见 [mobile-playfield.md](mobile-playfield.md)。
- 改**存储结构** → 同步 `test/store.test.js` **并递增 `SCHEMA_VERSION`**
  （否则老用户数据会被当空档丢掉），见 [store.md](store.md)。
- 改**像素矩阵** → 跑 `npm run icons` 重新提交三个产物，否则 `icons` 第 5 例直接红，
  见 [ghpages.md](ghpages.md)。
- 改**危险行动人形/配色/相机参数** → 一起看 `delta` 里对应的下限断言，
  阈值与理由记在 [delta.md](delta.md)。
- 改**手机浮层摇杆（`.pads`/`.cluster`/`.padlayer`/`.stick.seat`）或 `input.js` 的通道** →
  `test/delta-input.test.js` 的归零、夹取与"座内短按不搜刮"八例一起动，页面里必须重新读
  `deltaBoxes()`：`bareCanvasHit`、逐按钮命中、`seatMove/seatLook` 与 `rigs` 的**零像素偏差**
  （浮层容器一旦吃掉触控，摇杆和转身当场全废；判定圆与画出来的圆分家就是"看得见摸不着"），见 [delta.md](delta.md)。
- 改**小鸟材质/发射速度/关卡几何** → `birds` 里的门槛断言（2/6/25、3/20）、六关 `validateLevel`
  空数组、barn-1 一发入魂与 fort-1 哑弹判负的期望分数一起动，数值与理由记在 [birds.md](birds.md)。
- 改**小鸟视野地板（`VIEW_WIDTH`/`MIN_VIEW_HEIGHT`/`PULL_REF_RATIO`）** →
  `test/layout.test.js` 的三端视野下限与 `test/birds.test.js` 的 `aimFromPull` 屏幕归一两处一起改。
- 改**格子类行列或速度定义** → 那是跨端恒定这条铁律的实现，`snake`/`tetris`/`layout` 三处断言一起动，
  见 [game-module.md](game-module.md)。

## 单测绿不等于能玩

`node --test` 只证明引擎与参数下限成立。视图挂载、主循环真的在推进、HUD 文案、画布像素这些必须在
真实页面里用可观测信号复验，方法见 [browser-verify.md](browser-verify.md)。
