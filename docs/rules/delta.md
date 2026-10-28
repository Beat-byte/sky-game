# 「危险行动」（delta）专属规矩

改 `src/games/delta/` 下任何文件前先读这份。通用分工、主循环、DEV 钩子见
[game-module.md](game-module.md)；怎么在真实页面里验收见 [browser-verify.md](browser-verify.md)。

## 人形只描躯干与头盔

- 四肢**不描边**：恒定视口下人物只有 `radius*2 ≈ 20 px`，手臂/腿的短半径只有 ~2 px，
  比 `m.outlineWidth` 还细，全描边会被线宽整个吃掉（实测四肢像素为 0）。
- 腿摆相位一律由 `draw` 传入的 `phase` 与实体 id 经 `hashJitter` 派生，**不许 `Math.random`**。
- `test/delta.test.js` 用记录型 ctx 桩对拍"同相位逐笔一致 + 渲染不写状态"，改人形要一起看这一例
  （桩里缺 `strokeText`/`lineJoin` 会直接崩，加绘制手段要同步补桩）。

## 俯视（2D canvas）与第一人称（three/WebGL）双视图

1. **视图模式只改"摇杆向量怎么解释"**。引擎只认 `game.viewMode`（`topdown`/`fps`）：fps 下摇杆变
   "沿朝向前后 + 垂直平移"，朝向一律归 `setLook()` 管（单步夹 ±1 rad，`stepFixed` 里
   `flushInput → playerTurn → playerMove` 的固定顺序消费）。
   **速度、锥形、伤害、AI 全部不许按视图分档。**
   fps 下**自动开火不许代玩家转身**（`autoFire` 里跳过追瞄但照常开火），否则视野被人接管。

2. **WebGL 库惰性加载**：只在第一次切到 fps 时 `await import("./three-view.js")`
   （独立 chunk 530 kB / gzip 134 kB，实测），俯视玩家不付这份下载。
   起不来就退回 `topdown` 并把原因写进提示条，不污染状态；退回时连**偏好**一起写回 `topdown`。
   依赖 `three@0.186.1` 是**单包** `npm install three --save-exact` 装的（见
   [stack-and-deps.md](stack-and-deps.md)）。

3. **相机数学全部抽在 `scene3d.js`**（纯函数、Node 可测），`three-view.js` 只搬运。
   **构造相机必须走 `cameraConfig(aspect)`**：`PerspectiveCamera` 的签名是 `(fov, aspect, near, far)`，
   按位置传参曾把 `0.06` 当 aspect、`34` 当 near —— 整张图落在近裁面之前，
   **画了 14 次 draw call 却全黑且零报错**（readPixels 实测 0 亮像素），是这次最贵的坑。
   - 1:1 与宽屏锁水平 FOV 75°；**竖屏改夹垂直角**（`V_FOV_MAX_DEG = 80`）——
     按水平角反算会让 9:19.5 的手机（aspect≈0.46）算出 113° 垂直角，边缘拉伸、
     抬头低头像翻跟头，是第一人称晕眩主因；竖屏因此让出一点水平视野。
   - 雾远界恒 `FOG_FAR_M = 28` m（与俯视恒视口 28×18 m 对齐），起雾点
     `FOG_NEAR_RATIO = 0.5`（14 m）：旧值 0.25（7 m）让中景就发灰，分不清"那是墙还是箱子"。
   - 头部晃动地板 `BOB_M = { eyeY: 0.016, roll: 0.005, bob: 0.01 }`，枪口点光强度 1.4。

4. **fps 下敌人必须过 `game.visible()` 裁剪**。俯视"敌人一律画"是上帝视角的约定，
   照搬进 3D 等于隔墙看人（作弊）。

5. **两张画布靠 `.stack` 同格叠放**（`display:grid` + `.stack > canvas { grid-area: 1/1 }`）：
   GL `z-index:1`，2D 画布在 fps 下加 `.overlay`（`z-index:2` + `background:transparent`）
   只画右上角小地图（`drawMinimapOverlay` 先 `clearRect` 整块场再画），准星层 `pointer-events:none`。
   输入仍绑在 2D 画布上（它在上层），切回俯视时 `.overlay` 类消失、实心背景回来。
   - **命中测试按绘制顺序、不按像素透明度**：透明叠层照样吃掉它下面的按钮。所以局内所有 UI
     （`.pads`/`.top`/`.search`/`.exfil`/`.pulse`）都要 `z-index:5`、暂停面板 `.cover` 用 `6`，
     否则切进第一人称后 8 个按钮全点不动（实测），连"切回俯视"都点不了。
   - 局内的失败原因必须有地方显示：`.stage-msg`（`bottom:64px`、`pointer-events:none`、`z-index:6`）
     配 `flash(text)` 定时消失；`ensureThreeView()` 拿不到画布要 **throw**，静默 `return null`
     会让 `viewMode` 变成 fps 而画面仍是俯视，玩家以为按钮坏了。

## 地图与色板字符

- 两张手写地图：`farm` 农林区（tier 1，**白天**）、`port` 港口仓库（tier 2，**夜间**）；
  时段由 `map.timeSlot` 决定，`scene3d.js` 用它挑 `GROUND_COLORS[slot]` 与 `LIGHTS[slot]`。
  所以"昼夜两张图要各自复验"不是可选项 —— 只验一张等于没验。
- `BLOCKS` 的键是地图字符：`#` 墙体、`x` 掩体箱、`c` 木箱、`s` 货架、`$` 保险柜、`a` 弹药箱、`m` 医疗箱
  （外加 `E` 撤离点、`P` 出生点、`.` 地面）。遍历色板要用 `Object.values(BLOCKS)`，别拿 kind 名当键。

## 色板：只有 `scene3d.js` 一份真实来源

`BLOCKS[?].color`（本体）+ `BLOCKS[?].cap`（顶盖）、`GROUND_COLORS`、`LIGHTS`、`FIGURE_TONE`、`EXFIL`
全在这里；`renderer.js` 用 `cssHex()` 派生、`three-view.js` 直接用数值，**两边都不许再写十六进制**。

下限全部落进了 `test/delta.test.js`（CIELAB ΔE76，sRGB→Lab D65）：

| 约束 | 地板 | 为什么 |
| --- | --- | --- |
| 七类本体两两 | ΔE ≥ 25 | 一眼分不出类别 |
| 顶盖两两 | ≥ 18 | 顶盖是"这是矮容器"的唯一线索 |
| 顶盖 vs 本体 | ≥ 20 | 拉不开就没有体积感 |
| 本体 vs 地面 | ≥ 26 | 竖直面要弹出来 |
| 本体 vs 雾 | ≥ 22 | **墙原来对雾只差 8，一走近就整块化进雾里** |
| 敌人三态 vs 每类本体 | ≥ 22 | 活体不能融进场景 |
| 地面棋盘双色 | 6–20 | 要给移动提供光流线索，太花会抢注意力 |
| 顶盖墨色 `inkOn()` vs 底色 | ≥ 45 | 亮顶盖压浅字直接看不见 |

ΔE 只管"相差多少"，不管"有多黑"，所以另有**夜景绝对亮度下限**：
地面 L\* ≥ 10、雾 L\* ≥ 16 且雾必须比地面亮、半球光 ≥ 0.9、平行光 ≥ 0.85，
且 `LIGHTS.night` 总强度必须低于白天（否则昼夜失去意义）。
夜间第一人称曾整屏 67% 落在 `rgb(3,6,15)`（等于全黑），调完后该区域是 `rgb(12,21,35)`、
`meanSum` 24 → 87、近黑像素 0.7%。`three-view.js` 里必须
`scene.background = new Color(spec.fog.color)` —— 清屏色默认纯黑，实测夜间 4% 像素是 `rgb(0,0,0)`。

## 形状提示层

- 矮容器加亮顶盖（`CAP_M`，比盒顶高 1 cm 防 z-fighting）。
- 墙加视线高度横带（`BAND_M`，y=1.5 m、外扩 4 cm）。
- `marks` 与 `groups` 分两个数组，是为了保住"groups 实例数 == 网格实体格数"这条不变量。
- 俯视的容器首字用 `inkOn(底色)` 取墨色（亮底走同色相深墨、暗底走浅蓝白），
  标签一律带暗色描边（`label(..., halo)`）。
- 小地图走同一张色板 —— 原来容器/墙两块灰蓝在 3 px 格子上分不出"能搜"和"进不去"。

## 局内是全屏层（手机上唯一能玩的形态）

- `.raid` 在 `playing/paused/result` 三态整体 `position: fixed; inset: 0; z-index: 30`，
  把站点栏与游戏标题栏**盖在身后**（不改公共组件 `App.vue`/`GameView.vue`），
  `padding` 全部走 `env(safe-area-inset-*)`。父链上没有 `transform/filter`，fixed 的包含块才是视口。
- 反面数据（改之前）：`.stage` 只有 `min-height: 240px`，竖屏 390 宽的手机上
  `canvasBox` 内接出来是 **154×240**，每米 8.6 px、人形 6 px，8 个按钮再竖着叠 4 行盖住战场 ——
  这就是"手机上没法玩"。现在是全屏层里 `flex:1`，同屏每米 21.7 px 起。
- **画布盒子必须取 `.stack`，不是 `.stage`**：控制带进流后画布真正能用的只有上面那一格，
  按整块 stage 算横屏会多出一整条、把按钮盖住。`syncLayout` 的退路是 `.stack → .stage → 外层 → 视口`
  （`display:none` 时 `getBoundingClientRect` 恒为 0×0，直接喂 `canvasBox` 会得到 2×1 的画布），
  `ResizeObserver` 同时观察 `.stack` 与 `.stage`。
- **控制带 `.pads` 在画布下方占一条**（`--pads-h`），不再绝对浮在画面上：
  手机竖屏 4 列两行（106 px）、手机横屏与平板/桌面 8 列一行（56 px）；按钮 `min-height: 44px`。
  `z-index: 5` 仍要留着 —— fps 下 2D 叠层 `z-index:2`，命中测试按绘制顺序而非像素透明度。
- `.stage-msg` 与搜刮/撤离/脉冲三枚进度条一律用 `bottom: calc(var(--pads-h) + …)` 避让控制带，
  不再钉 `top: 42px`（手机 HUD 标签能换三四行，会把它们压掉）。
- **手机端 `.top` 让开右上角 84 px**：小地图（`minimapSize` 72 逻辑 px ≈ 65 CSS px）就画在画布右上角，
  标签铺满整宽会把它整个盖住。
- 局内 `.bar`（设备标签/钱包/静音）在全屏态隐藏：静音与档位信息移进暂停面板；
  `html[data-device="phone"] .ghost/.primary { min-height: 44px }`（实测默认只有 33 px 触点）。
- **藏身处与结算必须各自可滚**：`.raid`（lobby 态）`overflow-y: auto`，否则手机上黑市/配装把
  「进入」按钮裁出屏幕外（实测 scrollH 857 > clientH 568 时点不到）；
  `.result` 在全屏层里做成 `position:absolute; inset:0; overflow-y:auto; z-index:8` 的叠层，
  留在流里会被 `flex:1` 的画布顶出去。
- **可滚还不够，出征条得吸底**：390×844 上藏身处内容 1242 px、首屏只有 693 px，
  「进入」按钮虽然可滚到，但手指要先滑很久才够得着。`.launch`（提示 + 两个按钮）
  `position: sticky; bottom: 0; z-index: 4`，滑到 `.rules` 时自然归位。
  结算叠层同理：`.result .cta` sticky 到底部，长战利品列表里「回藏身处」一按就到。
- **`.result` 用 `.panel { margin: auto }` 居中，不用 `align-items: center`**：
  滚动容器里居中会把超出的标题顶到滚动区上沿之外，再也滚不回去；auto margin 在内容超量时自动退化成顶端对齐。
- **旋转抢跑时以容器盒子为准（`resolveViewport`）**：ResizeObserver / `orientationchange` 常抢在
  `window.innerWidth` 更新前回调，按旧窗口排会给出竖屏 386×600 的画布塞进 840×280 的横屏容器（溢出 320 px）。
  `layout.js` 的 `resolveViewport(windowSize, box)` 在两者朝向打架时改用盒子的长宽；
  两档视野面积恒 504 m²，**翻这一票不改难度**，盒子不可用（<40 或 0×0）时退回窗口判定。
- DEV 探针 `window.deltaBoxes()`：回读视口/档位/`.raid`(含 position)/`.stack`/`.pads`/画布盒子，
  外加每个按钮的 `elementFromPoint` 命中结果 —— "看不见"和"点不动"要一次都验到。

## 真实页面的验收数字（复验时对齐）

`deltaGlSample` 在同一轮任务里 sync+render 再 `readPixels`，并回传 `info()` 的
`calls/triangles/lights/cam.near/cam.far`：
- 白天 fps：实测 187 种颜色、`meanSum` 198、24 draw call。
- 夜间 fps：`meanSum` 87、21 draw call。
- 夜间俯视：5700 种颜色、100% 亮像素。
- 2026-10-28 全屏改造后在页面里实测（视口 973×712）：`.raid` computed `position: fixed` 且盒子
  = 视口 973×712；`.stack` 973×656、画布 973×626（每米 22.4 px）；`.pads` 56 px 一条贴在 y=656，
  8 个按钮 `elementFromPoint` 全命中；fps 下 `deltaGlSample` 100% 亮像素、21 draw call、
  `cam.near 0.06 / far 34`；暂停面板三枚按钮全命中；结算叠层 `absolute inset:0 + overflow-y:auto`。
  手机档（`data-device="phone"`）单独复验：`--pads-h` 106、按钮 4 列、`.top` 右侧让开 84 px、命中仍全通过。
- 2026-10-28 同源 iframe 真视口复验（**别再用内联样式假 390**：JS 按真实 `window` 判朝向，假盒子给出的
  数据自相矛盾）。390×844 竖屏手机：`.raid` fixed 386×840、`.stack` 386×734、画布 **386×600**
  （每米 21.4 px、人形 15.4 px）、`.pads` 106 px 贴在 y=734、8 枚按钮 89×44 全命中；
  fps 下 `deltaGlSample` 100% 亮像素（6144/6144）、22 draw call、`near 0.06 / far 34`、dpr 1.5。
  同一 iframe 改 844×390（不发 resize 事件，模拟事件丢失）：画布仍按容器排成 436×280 不溢出，
  事件补上后为 513×330；藏身处首屏（scrollH 1242 > clientH 693）出征按钮吸底且 `elementFromPoint` 命中；
  暂停面板三枚按钮 44 px 高全命中、`p` 键双向可切；结算叠层 `margin:auto` 居中、标题不被裁。
- 下限：**draw call ≥ 14、颜色数 ≥ 94、中心 86% 亮像素**才算这个视图真的活了。
- WebGL 建不起来属环境抖动，验证降级路径正确即可（回俯视 + `.stage-msg` 显示原因 + 偏好写回）。

## 相关

- 改几何/度量/视野要同步 `test/layout.test.js`，见 [testing.md](testing.md)
- 战绩与偏好落盘规矩见 [store.md](store.md)
