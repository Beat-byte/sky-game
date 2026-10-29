# 「愤怒的小鸟」（birds）专属规矩

改 `src/games/birds/` 下任何文件前先读这份。通用分工、主循环三驱动源、DEV 钩子约定见
[game-module.md](game-module.md)；真实页面验收办法见 [browser-verify.md](browser-verify.md)；
手机端全屏层见 [mobile-playfield.md](mobile-playfield.md)。

## 文件分工（引擎框架无关，整个目录不许 import Vue）

| 文件 | 只负责 | 不许做 |
| --- | --- | --- |
| `physics.js` | 刚体求解器（圆 + AABB）、`MATERIALS`/`PIG` 数值表、事件流 | 分数、音效、像素、关卡知识 |
| `levels.js` | 六关手写数据、`BIRDS` 鸟种表、`validateLevel` 几何自检 | 物理步进、渲染 |
| `game.js` | 局内状态机（鸟队列、发射、技能、落定、计分与星数） | 像素级表现、`localStorage` |
| `layout.js` | 舞台盒子→画布几何、`ppm`、相机夹取、屏幕↔世界换算、`aimFromPull` | 玩法数值 |
| `renderer.js` | 背景/弹弓/方块/猪/鸟/轨迹/碎屑的 2D 绘制、`setupCanvas` | 写任何游戏状态 |
| `input.js` | 手势与按键 → 意图（`onPull`/`onRelease`/`onAbility`/`onTrim`/`onAction`） | 直接改状态 |
| `audio.js` | WebAudio 现场合成 12 个音色、`unlock`/静音 | 音频文件 |
| `tick.js` | Worker 心跳（只发 `"tick"`，不带时间戳） | 计算 dt |
| `BirdsView.vue` | 装配：生命周期、主循环、HUD、选关与存档 | 物理或几何数学 |

**`MATERIALS` 的真实来源是 `physics.js`，不是 `levels.js`**（`levels.js` 只 `import` 它取密度与耐久）。
`renderer.js` 曾从 `levels.js` 引它，`npm run build` 直接报 `"MATERIALS" is not exported by levels.js`。

## 物理：三条刻意约束

1. **不引入旋转**。方块永远轴对齐 → 碰撞是圆/AABB 解析解，堆叠不会因数值漂移抖出不可复现结果。
   代价是"柱子被撞后不会倾斜倒下"，替代表现是支撑抽走后方块垂直砸落 + TNT 径向冲量把结构推散。
   **要加倾斜/翻滚就得整套换 OBB，别只在碰撞里塞一半。**
2. **不许 `Math.random`**。碎屑角度、花纹、引线相位由实体 id + 序号经 `spin()` / `hashJitter()` 派生；
   `test/birds.test.js` 的"物理确定性"一例用 `fingerprint()` 钉住"同一串输入跑两遍逐位相等"。
3. **一切按米与秒**：`GRAVITY = 22`、尺寸、速度都是物理量，`ppm` 只决定画多大、不参与任何判定。

求解器参数（改了要同步手感）：`FIXED_DT = 1/120`、`SOLVER_ITERATIONS = 6`、
`POSITION_SLOP = 0.002`、`POSITION_PERCENT = 0.6`、`BOUNCE_SPEED = 1.2`、
`SLEEP_SPEED = 0.16` / `SLEEP_TIME = 0.3` / `WAKE_SPEED = 0.45`。`game.js` 的累加器每帧最多跑 12 子步。

- **法线一律从 a 指向 b**（a 受 `-n`、b 受 `+n`，位置修正同向）。三个碰撞函数当初各写各的方向，
  结果地面把方块"吸"了下去 —— 改任何一个都要守住这条约定。
- **伤害只在"新接触"结算**：`j = (1+e)·vₙ / (1/m₁ + 1/m₂)`，超过材质 `toughness` 才掉血，
  所以静止堆叠不会慢慢磨血。量纲 N·s：1.2 kg 的鸟以 18 m/s 撞 8 kg 石块约 24。
- **睡着的实体本步 `invMass` 视为 0**（不积分、不修正），堆好的塔纹丝不动；
  由 `shouldWake`（对方要够快**且真的往里撞**，`along < -0.25`）或下方支撑消失来叫醒。
- **`explode()` 返回新事件数组，不复用 `this.events`**：调用方再消费一遍就会把上一帧的引线事件重新引爆，
  无限递归。连锁按距离升序处理，事件顺序才固定、爆炸结果才钉得住。

## 数值表：全部有单测下限

| 材质 | 密度 | hp | toughness | 分数 | 实测门槛 |
| --- | --- | --- | --- | --- | --- |
| wood | 0.55 | 18 | 8 | 500 | 冲量 2 无事 / 6 无事 / 25 碎裂 |
| stone | 1.7 | 44 | 18 | 800 | 25 只开裂 |
| glass | 0.85 | 9 | 4 | 400 | 6 开裂 |
| tnt | 0.5 | 3 | 2 | 700 | 6 点燃引线（`fuse` 事件） |

`PIG`：密度 0.7、hp 12、toughness 6、`r = 0.46`、1000 分（冲量 3 无伤、20 击杀）。
TNT 引爆半径 4、冲量 30、距离衰减线性，**8.8 米外的石头不掉血**（单测钉住范围上限）。

| 鸟 | 半径 | 质量 | 技能 | 数值 |
| --- | --- | --- | --- | --- |
| 红鸟 | 0.36 | 1.2 | 无 | 靠撞击与弹跳（restitution 0.34） |
| 黄鸟 | 0.34 | 1.55 | `dash` | 速度 ×`DASH_MULTIPLIER = 1.85`，每发只许一次 |
| 黑鸟 | 0.46 | 2.6 | `bomb` | `BOMB = { radius: 3.8, power: 34 }` 原地引爆并自杀 |

发射：`MIN_LAUNCH_SPEED 8.5` → `MAX_LAUNCH_SPEED 28` 按功率线性；
仰角夹 `[MIN_LAUNCH_ANGLE = 0.06, 1.45]`。拉满 45° 射程 ≈35.7 m > `LEVEL_WIDTH = 30`，够横扫全关。
计分：碎裂按材质表、开裂 50、爆炸 120、猪 1000、**每只剩余鸟 5000**；
`starsFor(left)`：≥2 → 3 星，1 → 2 星，0 → 1 星。

## 几何：横向米数恒定，功率按屏幕行程归一

- `VIEW_WIDTH = 15` m —— 三端横向看到的物理距离完全一样，只有像素大小不同（难度铁律的实现）。
- `MIN_VIEW_HEIGHT = 12` m 是**纵向地板**：矮窗口（桌面超宽舞台）宁可多看见几米宽，
  也不把 45° 抛物线顶点（≈11 m）压出画面。`ppm = min(css.w/15, css.h/12)`。
- `pullRef = max(28, min(css.w, css.h) × 0.13)` —— 发射功率按**屏幕行程**归一，
  手指在 388 px 手机上拖 40 px 与桌面拖 90 px 是同一档功率。地板 28 px 保证极小画布也拖得满。
  **这条是"手机不吃亏"的唯一保证，改回按米归一就是变相惩罚小屏。**
- `GRAB_RADIUS = 2.4`（× `pullRef`）决定按下时算不算"抓住弹兜里的鸟"。
- 相机：横向夹在 `[0, LEVEL_WIDTH - view.width]`；`lift = max(0, focus.y + 1.6 - view.height × 0.62)`
  只在高抛时整体上移，**不改 ppm**。
- 背衬像素 DPR 夹 1..3；Node 里 `window` 不存在 → dpr 恒 1（单测才能跑）。

## 关卡：六关全手写，每次加载都自检

`barn-1` 木棚 / `twin-1` 双棚 / `tower-1` 石塔 / `ice-1` 冰宫 / `keep-1` 三层堡 / `fort-1` 要塞，
鸟队从 3 只红鸟递进到 `["yellow","black","red","black"]`。

- **不许程序生成**：结构必须开局就站得住，而自稳取决于支撑重叠、质量分布与睡眠判定，
  随机搭建几乎必然一开局就塌。
- `B(x, bottom, w, h, material)` 与 `P(x, bottom, r)` 的 `bottom` 是**底边**（不是中心）——
  这是本目录最容易写错的约定，`shelter`/`stack` 两个小工厂就是为了不再手算顶高。
- `validateLevel` 六项检查：无鸟/无猪、未知鸟种、伸进弹弓区（`STRUCTURE_MIN_X = 13.5`）、
  出右界、陷进地里、高出天顶（`LEVEL_CEIL = 14`）、未知材质、**初始两两重叠**。
  每次 `loadLevel` 都跑，结果存进 `game.problems`；单测逐关钉成空数组。
- `loadLevel` 末尾**预沉降 360 步**（3 秒）再交给玩家：开局看到的就是站得住的样子，
  同时清掉沉降过程中产生的碎屑与事件。

## 状态机与"这一发打完了"

`status`：`ready|playing|paused|won|over`；`phase`：`aim|flight|settle|done`。

- 收工判定是**慢速累计**，不是"落地"：`SPENT_SPEED = 0.55` m/s 持续 `SPENT_HOLD = 0.45` s
  （鸟可能停在屋顶、梁上），或鸟被 `cull()` 出界（`x < -3`、`x > width + 3`、`y < -4`）。
- `settle` 等 `world.isQuiet()`，最多等 `SETTLE_TIMEOUT = 2.6` s，超时 `forceSleep()` 强制进下一发。
  **没有这两条兜底，一块永远在抖的石头就能把局冻住。**
- `togglePause` 只动 `status`；`update()` 在非 `playing` 时只推进碎屑、不碰物理 → 暂停真的冻结。
- `trajectory()` 只积分重力、不预演碰撞（和原作一样只给点串），越界即截断。

## 输入与主循环

- 触屏：按住弹兜往左下拖 → `aimFromPull` 屏幕换算 → `game.setAim`；松手发射；
  功率 < 0.08 算取消。飞行中画面任意处点一下 = 放技能。
- 键盘：`↑↓` 仰角 ±`TRIM_ANGLE = 0.045` rad、`→←` 功率 ±0.05、空格发射、`x` 技能、
  `p`/`Esc` 暂停、`r` 重开、`m` 静音、`n` 下一关。**与触屏共用同一条 `setAim` 通道**，
  视图里不许再写第二套换算（当初写过两套，两边角度定义打架）。
- `bindInput` 返回 `{ unbind }`（不是裸函数），装配层按 `input.unbind()` 统一清理。
- 三驱动源（rAF + Worker 心跳 + `setInterval` 看门狗）共用一条 `pump` 与 `last` 游标；
  `watch(status)` 只在 `playing` 时让 Worker 发 `"start"`，结算/暂停画面不挂 60 Hz 心跳。
  `visibilitychange` 回到可见时把游标清零，dt 夹 0.05。

## 三个装配层的坑（都真实踩过）

1. **首帧崩溃**：`OVERLAY` 的 title 是函数，`render` 期就读了还没挂载的 `game` →
   `TypeError: Cannot read properties of null`，整页空白、`window.birds` undefined。
   解法是 `booted` ref 守卫，`onMounted` 末尾才置 true。
2. **hidden 页面里 `ResizeObserver` 不派发**：首帧之后才渲染的东西（鸟队 chip、选关条）把控制带撑高，
   画布就比 `.stage` 高 2 px。解法是 `onMounted` 里补 `setTimeout(relayout, 60)`，卸载时 `clearTimeout`。
3. **控制带按钮的语义**：`ready` 态显示"继续"是错的 → `pauseLabel`（playing 暂停 / paused 继续 /
   ready 开始 / 结算态重开）配 `bandAction`（结算态走 `restart()`）。

## DEV 钩子（`import.meta.env.DEV`，卸载时逐个 delete）

`window.birds`（引擎实例）、`birdsLayout()`、`birdsCamera()`、`birdsRelayout()`、
`birdsLevel(index)`、`birdsShoot(power, angle)`、`birdsBoxes()`。
`birdsBoxes()` 回读视口 / `.playfield` 根 / `.stage` / `.board` / `.side` / `.pad` / `.controls`
与每枚按钮的 `elementFromPoint` 命中结果。**注意两点**：`.playfield` 就是组件根，
`querySelector(".playfield")` 找不到自己，所以 `full` 直接取根元素；
桌面/平板档位下 `.exit` 是 `display:none`（0×0），命中检查跳过它，否则白报一个"点不动"。

## 真实页面的验收数字（2026-10-28 实测，复验时对齐）

同一 hidden 页面，同源 iframe 真视口（别用内联样式假盒子，JS 按真实 `window` 判档位）：

| 档位 | `.stage` | 画布 CSS | `ppm` | 视野（米） | `pullRef` | 按钮命中 |
| --- | --- | --- | --- | --- | --- | --- |
| 390×844 手机竖屏 | 390×676（fixed，`y=0`） | **388×674** | 25.87 | 15 × 26.06 | 50.4 | 10/10，含「退出」 |
| 844×390 手机横屏 | 672×390（`.side` 右侧 172 px） | **670×388** | 32.33 | 20.72 × 12 | 50.4 | 10/10，含「退出」 |
| 888×712 平板横屏 | 549×547 | 546×545 | 36.40 | 15 × 14.97 | 70.9 | 9/9（`.exit` 隐藏，跳过） |

- **主循环真的在跑**：`game.elapsed` 差 / `performance.now()` 差 = **1.003**（手机竖屏，Worker 驱动）、
  **0.999**（平板档位，一发打完整局）。这两个比值偏离 1 就是循环或 dt 游标坏了。
- **画布真的在画**：竖屏 backing `776×1348`、横屏 `1340×776`，`alpha > 0` 像素占比 **100%**
  （天空渐变铺满底），隔 997 px 采样到 **199 种颜色**。
- 手机档控制带：竖屏 `.pad` 与 `.controls` 各 378×44 贴在底部（`y=744` / `y=794`），
  横屏换到右侧 159×94 两条；按键触点 ≥ 44 px。
- **页面不多出一屏滚动**：竖屏 `scrollHeight 844 == clientHeight 844`、横屏 `390 == 390`，
  `.playfield` computed `position: fixed`，`.side` 自身 `scrollWidth == clientWidth`（171/171）——
  选关条与鸟队 chip 撑高控制带的那次溢出就是这么压回去的。
- 一发入魂的落盘证据（上一轮实测）：`sky-games:game:birds` 里 `{score:11500, level:1, won:true, outcome:"won"}`，
  `sky-games:save:birds` = `{unlocked:2, stars:{"barn-1":3}, best:11500, v:1}`。
  11500 = 猪 1000 + 木梁碎裂 500 + 剩余 2 只鸟 × 5000。
- 构建产物：`BirdsView` chunk **40.30 kB**（无 three、无音频文件）。

## 改 X 必须同步 Y

- 改**材质/鸟种/发射速度** → `test/birds.test.js` 的门槛断言（2/6/25 与 3/20 那两组）与
  `MAX/MIN_LAUNCH_SPEED` 推导的射程注释一起动。
- 改**关卡几何** → 该关 `validateLevel` 必须仍是空数组；单测的"一发入魂"（barn-1）与
  "四发哑弹判负"（fort-1）都依赖具体几何，动了就重算期望分数。
- 改 **`VIEW_WIDTH`/`MIN_VIEW_HEIGHT`/`PULL_REF_RATIO`** → `test/layout.test.js` 的三端视野地板
  与 `test/birds.test.js` 的 `aimFromPull` 归一用例一起改，见 [testing.md](testing.md)。
- 改 **`src/styles/playfield.css`** → birds 与另三款共用同一套类名，重量手机档的
  `elementFromPoint` 与画布溢出，见 [mobile-playfield.md](mobile-playfield.md)。
- 改**存档/解锁结构** → 走 `useGameSave("birds", …)`，同步 `test/store.test.js` 与
  `SCHEMA_VERSION`，见 [store.md](store.md)。
- 给 `renderer.js` 加新的 canvas 手段 → 同步 `test/birds.test.js` 的记录型 ctx 桩
  （桩里缺方法直接崩；`String(proxy)` 还要有 `Symbol.toPrimitive`）。

## 相关

- 主循环三驱动源与模块分工细则：[game-module.md](game-module.md)
- hidden 页面泵帧与画布取样：[browser-verify.md](browser-verify.md)
- 回归基线：`test/birds.test.js` 22 例（全套 177 例）
