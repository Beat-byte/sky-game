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
  手机竖屏 4 列两行（106 px）、平板/桌面 8 列一行（56 px）；按钮 `min-height: 44px`。
  **手机档是例外**：那里改成座子常显的底部双摇杆（横屏另加浮层），理由与规矩见下面「手机＝和平精英式双摇杆（横屏与竖屏）」。
  `z-index: 5` 两种形态都要留着 —— fps 下 2D 叠层 `z-index:2`，命中测试按绘制顺序而非像素透明度。
- `.pads` 里的按钮分两簇（`.cluster.nav` 视角/暂停/返回、`.cluster.fight` 搜刮/打药/换弹/技能/开火），
  竖屏与桌面靠 `.cluster { display: contents }` 让按钮直接落进同一张网格，DOM 只有一层语义。
  **改簇内按钮的顺序要连着验竖屏的两行排版**，`display:contents` 下网格按文档流排。
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
- DEV 探针 `window.deltaBoxes()`：回读视口/档位/`.raid`(含 position)/`.stack`/`.pads`(含 position 与
  pointer-events)/`--pads-h`/画布盒子/`.stick`，外加每个按钮的 `elementFromPoint` 命中结果，
  以及 `bareCanvasHit`（画布空白处的命中测试必须落回画布本身 —— 浮层容器吃掉触控当场暴露）。
  "看不见"和"点不动"要一次都验到。另有 `deltaStick()`（DOM 圈态 + 引擎向量）与
  `deltaTrigger(bool)`（DOM `.held` + 引擎 `triggerHeld`）。
  **注意 flush 时差**：一次 `evaluate_script` 只有一轮任务，`dispatchEvent` 之后同步读 DOM 拿到的是
  上一次 flush 的样式，`classList`/`v-if` 要 `await` 一拍再读（实测：按下即读 `held:false`、80 ms 后 `true`）。

## 手机＝和平精英式双摇杆（横屏与竖屏，2026-10-29）

手机那一档**有意推翻**上一条"控制带不进浮层"的结论：旧版控制带把画布压矮、8 个等宽小格排一行、
摇杆完全看不见 —— 与吃鸡手游的形态正好相反。而"按在哪就长在哪"的浮动摇杆仍然不对：
拇指落点随机，实战里根本没法操作。现形态是**两枚摇杆座默认就显示、位置钉死在画面下沿两角**，
左=前进后退/横移、右=转身，横屏时右侧中部再加一枚圆钮按住开火。八条规矩必须一起成立：

1. **横屏 `--pads-h: 0` 且 `.pads` 改 `position:absolute; inset:0`**：`.stack` 于是占满整屏，
   画布从 520×334 涨到 **607×390**。留白仍在左右（`fieldFor('landscape')` 恒 28×18 m，
   不许为了"铺满"去改视野米数 —— 那是难度）。竖屏不推翻控制带：画布 390×607 照旧，
   座子画在**画布**下沿两角，与下方那条 106 px 控制带盒子不重叠（实测座子占 y 537–665，
   搜刮条在 692、提示条在 728，都落在画布之外的空隙里）。
2. **容器 `pointer-events: none`、`.cluster` 各自 `auto`**：空白处一律归画布，摇杆座只是"画"在画面上，
   手指照样落在画布上（`input.js` 只监听画布）。只有拇指真压到按钮时才吃掉触控，`bareCanvasHit` 验这条。
3. **座子位置的唯一来源是 CSS，不是常量**：`measureSeats(canvas)` 在 `syncLayout` 里量两枚
   `.stick.seat` 的盒子，换算成画布内坐标 `{x, y, r}` 交给 `getPads()`。**看得见的圆 = 摸得到的圆**
   靠这个保证，改 `.stick.seat` 的 `left/bottom/width` 就自动跟着改判定区，没有第二处需要同步。
   量不到（`display:none` → 0×0）就返回 `null`，输入层**自动退回浮动摇杆** —— 这条回退现在只服务
   平板与桌面（它们本来就有键盘），由 `isFixedStickLayout = device === 'phone'` 一处开关决定。
   **测量时机也是个坑**：座子定位在 `.padlayer` 里，而 `.padlayer` 的宽高绑在 `boardBox` 上 —— Vue 要到
   下一拍才把新盒子写进 DOM，`syncLayout` 里同步量拿到的是**上一版布局**的座子（实测座心 72 会报成 87.5，
   转屏/重开局那一下判定圆整体偏移）。做法是**先按现状量一次**（任何时候都有圆可用），**再在 `nextTick`
   里重量一次**（还要判 `canvas.isConnected`，否则卸载后的回调会写进已消失的 DOM）。
4. **俯视也吃转向**：`turnPlayer()` 不再只看 `viewMode`，`setLook` 在两种视图里都真的改 `player.angle`；
   同时置 `turnedThisStep`，让本步的"推哪走哪"（`movePlayer` 归正朝向）与追瞄（`autoFire`）都让路 ——
   否则左手一推就把右手刚转的方向抹掉，"边退边转身"这个动作根本做不到。
5. **右摇杆只取横向形变**：上下推不产生任何东西（这引擎没有俯仰），满偏角速度
   `LOOK_STICK_RATE = 5.5 rad/s`，比键盘的 `LOOK_KEY_RATE = 9` 慢，因为拇指全程贴屏推着走；
   座子之外的右半屏**仍然**是像素增量拖动细瞄（两条路共存，互不覆盖）。
6. **开火＝按住**：`Delta.setTrigger(pressed)` 置 `triggerHeld`，`autoFire` 在按住时**即使锥形内没有目标**
   也沿当前枪口出枪（松手回到"自动开火只挑得到的人"）。它与空格那条 `fire-toggle`（`fireEnabled`）
   是两条独立通道，互相不写入 —— 这是 `test/delta.test.js` 里那两例钉住的规矩。
   松手路径要齐全：`pointerup` / `pointercancel` / `pointerleave` / `pause()` / 页面隐藏 / 组件卸载。
7. **排布**：`.stick.seat` 128×128 常显（不按下也在，静止时旋钮就贴在座心），`html[data-device="phone"]`
   一条贴画布下沿左角 `calc(8px + safe-left)`、另一条贴右角，横屏那条再用 `[data-orientation="landscape"]`
   让到 `calc(14px + safe-*)` —— **特异度必须写满两段属性选择器**，否则 `.seat.look` 会被
   `.seat` 的 `left` 盖住，转身座当场跑到屏幕左边。横屏的 `.cluster.fight` 是 `repeat(2,50px) 84px` 网格、
   `bottom: calc(150px + safe-bottom)`，84 px 圆钮独占第三列居中；`.stage-msg` 同样让到 150 px 以上且
   `max-width:42%`，否则身体会压到扳机上。导航簇占左上 ⇒ `.top` 在横屏下移到 `top: 58px`。
   **平板/桌面保持控制带与浮动摇杆不变。**
8. **座子里的短按 ≠ 轻点画布**：`release()` 那条"按下没移动就发 `interact`"（与键盘 `F` 等价）多了一个
   `!pad.inSeat` 条件 —— 手指落在**画出来的那枚座子圆内**就是"在操作控件"，不该顺手开始搜刮
   （拇指在座子上歇一下就翻包，是实战里最烦的误触发）；座子以外的画布、平板/桌面的浮动档位照旧一点就搜。
   判据是到座心 `≤ r`，与 `classify` 那个 `LOOK_CAPTURE = 1.4` 的放大圈无关：放大圈只为"手指略微出界还能
   接手转身"，出界以外仍然是战场。

实测（同源 iframe 844×390 与 390×844，真 PointerEvent 打在 `elementFromPoint` 命中的那张画布上 ——
座子与 GL 画布的类名分别叫 `stick seat` / `board gl`，打在它们身上**不会**冒泡到输入层，踩过两次。
另一个坑：**把玩家瞬移到农林区 `(31,2)` 的弹药箱就等于踩进撤离点**，当场 `won`、`.result`（`z-index:8`）
盖住全屏，此后 `bareCanvasHit` 与 8 枚按钮命中**全 false**，看着像布局回归其实不是 —— 读命中前先查
`delta.status`，"结束→回藏身处→重新进入"再量）：
横屏两枚座子 128×128 都在 `y=248`（屏幕下沿），`rigs` = `{move:(78,312,r64), look:(529,312,r64)}` 与盒子对齐；
左摇杆按下即形变、原点恒在座心、满推 `{x:0,y:-1}` 且旋钮夹在半径内，0.9 s 位移 **4.92 m**，松手归零；
右摇杆半推 `rate 0.5` ⇒ 俯视**原地**转 **126.1°**、`movedWhileTurning 0`，第一人称同样 700 ms 转 **122.8°**
且位移 0 m，松手 `rate 0` 无漂移；双指同推 ⇒ 位移 2.12 m 与转身 −253° 同时成立，先松左手只清移动、
右手继续转，全松后 `{stick:(0,0), rates:{key:0,stick:0}, 两圈 active:false}`；
关掉自动开火后按住 84 px 圆钮 500 ms 出 **9 枪**、松手 600 ms **0 泄漏**，`pointerleave` 也能收尾；
8 枚按钮 `elementFromPoint` 全命中（导航 44 高、功能 50×50、扳机 84×84）、`scrollHeight == clientHeight == 390`；
fps 下 `deltaGlSample` 100% 亮像素（6144/6144）、21 draw call、6290 三角形、`fov 52.5`。
竖屏 390×844：不碰也在 —— 两座 128×128 常显于 `(8,537)` 与 `(254,537)`，静止时旋钮与座心**零像素偏差**，
`rigs` = `{move:(72,535,r64), look:(318,535,r64)}` 与盒子对齐，中间留 118 px 不挡人物；
故意按在座心外 42 px（`30,560`）原点仍锁在 `(72,535)`，0.7 s 走出 **2.65 m**；
右杆半推 `rate -0.5` 在 fps 转 **−154.2°**、俯视转 **201°**，两种视图位移都是 **0 m**；
控制带 106 px 照旧、8 枚按钮 90×44 全命中、`scrollHeight == clientHeight == 844`。
现场转屏（发 `resize` + `deltaRelayout`）：横↔竖 两座只是换坐标、`rigs` 重新量到当档的盒子，摇杆状态无残留；
**平板/桌面**（1280×800）两座仍是 0×0、`rigs: null`、浮动圈在按下点长出 `{origin:(238.5,400)}` 并跟随，
松手归零 —— 回退路径没被这次改动碰坏。

同日补跑（`syncLayout` 里 `padRigs` 改到 `nextTick` 之后再量，见下面第 3 条的落地坑）：
竖屏 390×844 开局即 `rigs`=`{move:(72,535,r64), look:(318,535,r64)}`，与两座盒子 `(8,537)`/`(254,537)`
的**圆心差 dx/dy/r 全为 0 px**（此前按上一版 `.padlayer` 的盒子量，转屏后会差出几十像素）；
左杆按在座心上方 60 px（仍在 r=64 圈内）原点仍锁 `(72,535)`、`{x:0,y:-0.94}`，2.38 s 走 **4.669 m**
≈ **1.96 m/s**，松手 `{0,0}` 且 `active:false`；右杆推 40 px（`rate 0.625`）转 **173.2°**、位移 **0.000 m**；
双指同推 ⇒ `stick{0,-0.94}` 与 `rate -0.625` 同时成立，全松后 `{stick:(0,0), rates:{key:0,stick:0}, 两圈 active:false}`；
**轻点门槛**：座心各短按一次 ⇒ `searchTarget` 始终 `null`，座外 `(194,240)` 短按 ⇒ `searchTarget=弹药箱`、
250 ms 后进度 **1.02 s**；`.pads` 106 px static、`--pads-h:106px`、8 枚按钮 90×44 全命中、`bareCanvasHit:true`、
`scroll{390×844 == 390×844}` 无溢出。横屏 844×390 重开一局再量：两座 `(133,248)`/`(584,248)` 与 `rigs`
`{move:(78,312,r64), look:(529,312,r64)}` 同样 **0 px 偏差**，画布 607×390、`.pads` absolute `inset:0`
`pointer-events:none`、8 枚按钮（70/46×44、50×50、84×84）全命中、`bareCanvasHit:true`；
平板 1280×800：两座 0×0、`rigs:null`、浮动圈原点与按下点**逐像素重合** `(240,300)`、松手即清、
`.pads` 56 px static、按钮全命中 —— 三档在同一轮里对齐，说明"看得见的圆＝摸得到的圆"不再依赖运气。

## 竖屏出征前的「请横屏」引导（2026-10-29）

横屏才有铺满整屏的画布与右侧那枚按住开火的圆钮，竖屏只能带着 106 px 控制带玩。玩家竖着拿手机进局就看不到那套形态，
但**网页不能强制旋转**：`screen.orientation.lock('landscape')` 只在"已进全屏 + Android/Chrome"有效，
iOS Safari 直接抛 `NotSupportedError`；`manifest.json` 的 `"orientation": "landscape"` 只服务"添加到主屏幕后独立运行"
（本站没有 manifest，跑在标签页里）。所以做的是**出征前拦一道**，六条一起成立：

1. 闸门在 `startRaid()` 里、**建引擎之前**：`wantsLandscapeHint()`（`device === 'phone' && orientation === 'portrait'
   && prefs.deltaLandscapeHintOff !== true`）成立就只置 `landscapeHint = true` 然后 `return`，
   `new Delta(...)` 一行都不许跑 —— 否则玩家在读引导时人物正在挨打、时限照走。
2. **`@click="startRaid"` 会把 `PointerEvent` 当第一个参数递进来**，所以跳过引导只认字面量 `true`
   （`if (skipHint !== true && ...)`）。写成 `if (skipHint)` 这道闸门当场失效，而且只在竖屏手机上才露馅。
3. 三枚按钮：「继续竖屏进入」一次性放行、**不写偏好**；「不再提示并进入」`store.setPref('deltaLandscapeHintOff', true)`；
   「先回藏身处」只关层不进局。持久化只有 `store.setPref` 这一条路（往 `prefs` 加新键不算改结构，不升 `SCHEMA_VERSION`）。
4. **转横屏就当场放行**：`watch(() => device.orientation)` 在引导开着且方向离开 `portrait` 时自己关层并
   `startRaid(true)` —— 玩家已经照你说的话做了，不能再要他点第二次「进入」。
5. 层自己是 `position:fixed; inset:0; z-index:40`：引导弹出来时 `phase` 还是 `lobby`，藏身处是流式布局，
   `.cover`/`.result` 那套 `absolute` 在这里没有定位父级；而 `.raid` 是 `fixed` + `z-index:30`，引导必须压过它。
6. 平板/桌面不弹（`device !== 'phone'`），它们本来就有键盘。竖屏的那两枚固定座子照旧常显，引导只是**建议**，不是门槛。

实测（同源 iframe，真点击；`sky-games:global` 只动 `deltaLandscapeHintOff` 一个键，测完复原成 `{deltaView, muted}`）：
竖屏 390×844 点「进入 农林区」⇒ `.rotate-hint` fixed `390×844`、`z-index 40`，`window.delta` 仍是 `null`（引擎没建）、
`.raid` 还是 `phase-lobby`、座子盒子宽 0，出征按钮被引导吃掉（`elementFromPoint` 命中 `.rotate-hint` 本身），
三枚按钮全命中，`scroll == client == 390×844` 无溢出；**按钮高度 44 px（297/113/87 宽）达触点地板**，
面板 329×368 居中在 `(30,238)`，四边都不贴屏幕；点「继续竖屏进入」⇒ `phase-playing`、`status running`、
座子 128 px 仍在画布下沿，且偏好没被写；「回藏身处 → 再出征」引导**还会弹**；引导开着时把视口改成 844×390 + `resize`
⇒ 层自关并直接进局，`rigs` 重排成横屏那组 `(78,312)`/`(529,312)`；点「不再提示并进入」⇒ `deltaLandscapeHintOff === true`
且竖屏 `rigs (72,535)`/`(318,535)` 照常；带着这个偏好重载 ⇒ 点出征不再弹、直接进局；平板档 1280×800 ⇒ 不弹、直接进局、
`--pads-h` 仍 56 px、座子宽 0。

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
