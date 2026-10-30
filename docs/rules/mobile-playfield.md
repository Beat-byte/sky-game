# 手机端全屏层（弹球 / 贪吃蛇 / 方块堆叠 / 愤怒的小鸟 / 飞机大战）

五款街机游戏在手机上必须是**全屏可玩**的，形态与「危险行动」的局内层一致：画面铺满整屏，操作收进一条控制带。
规则的**唯一来源**是 [`src/styles/playfield.css`](../../src/styles/playfield.css)，由 `src/main.js` 与 `base.css` 一起引入。

## 为什么单独一层，且不写进组件

五款的结构本来一致（`.playfield > .stage + .side`），所以一份规则一次覆盖五款；各视图的 scoped 样式**只留桌面/平板档位**。

这条是踩过坑之后的结论，别再改回去：游戏视图是 `defineAsyncComponent` 的异步 chunk，它的 CSS 在运行时才注入 `<head>`。
组件里写 `html[data-device="phone"] .playfield` 会被 Vue 编译成 `html[data-device="phone"] .playfield[data-v-*]`（特异度 3 类 + 1 元素），
和公共层的同名选择器**平手**，然后靠"后加载"赢掉公共层。上一版手机端画布只剩 194 px 宽（格子 14.9 px）就是这么来的。
所以：**手机档位的声明只准住在 playfield.css 里**，视图内新增 `html[data-device="phone"] …` 一律视为回归。

## 三条纪律

1. **只改可见尺寸，不改玩法。** 行列恒定由各自 layout.js 保证（蛇 13×20 / 20×13，方块 10×20），
   弹球靠 `speedScale` 保持垂直穿越时间恒定，小鸟按 `ppm` 换算但视野恒 15 米，
   飞机大战的 `unit` 只决定一单位画多大、空域恒 9×16 单位。这里绝不准出现按设备调速度、格子数或判定。
2. **控制带留在流内**（竖屏贴画布下方、横屏换到右侧 172 px），不许改成绝对浮层——按钮盖在战场上是上一版的病根。
   **唯一例外是「危险行动」的手机档（横屏与竖屏都算）**：那一档要的是和平精英式操作 ——
   两枚摇杆座**默认就显示**、位置钉死在画面下沿两角（左=前进后退、右=转身），横屏再在右侧中部加一枚按住开火的圆钮；
   竖屏保留控制带，但座子画在画布下沿、两者不重叠。条件与验收见 [delta.md](delta.md)「手机＝和平精英式双摇杆（横屏与竖屏）」。
   五款街机**不适用这个例外**：它们的输入是离散的下一个方向或一段拖动距离，没有"看不见落点"的问题。
   **危险行动也不锁方向**：手机竖屏点「进入」只弹一层 fixed `z-index:40` 的「建议转成横屏」引导，
   转横自动放行、坚持竖屏照常玩；网页没有强制横屏的能力（`screen.orientation.lock` 需 Android + 全屏，
   iOS Safari 直接抛错），细则见 [delta.md](delta.md)「竖屏出征前的『请横屏』引导」。
3. **触点地板 44 px**，战绩 `.history` 与说明 `.guide` 在手机隐藏（桌面/平板照常显示），统计 `.stats` 压成一条并可横向滚动。

## 出口

`.playfield` 变成 `position:fixed; inset:0` 后会盖住 `GameView` 的页头（那里有「← 游戏厅」），
所以五款的 `.controls` 里各留一枚 `<RouterLink class="btn exit">退出</RouterLink>`：
组件里默认 `display:none`，只有 playfield.css 在手机档位把它打开。
点它走的是路由卸载 → `onBeforeUnmount` → `endSession("quit")`，中途退出照样留档。
（DEV 探针做 `elementFromPoint` 命中检查时要跳过 0×0 的隐藏按钮，否则桌面/平板档位会白报一个"点不动"。）

## 实测（2026-10-28 首批，2026-10-30 补飞机大战；同源 iframe 模拟 390×844 / 844×390）

| 游戏 | 竖屏画布 | 每格 CSS | 控制带高 | 备注 |
| --- | --- | --- | --- | --- |
| 贪吃蛇 | 386×593（改造前 194×299） | 29.7 px | 235 px | 横屏 20×13 互换长边，格子 29.6 px |
| 方块堆叠 | 388×674 | 38.8 px | 169 px | 横屏带内 3 列排布，`sideScroll` 390/390 刚好放下 |
| 弹球 | 388×753 | — | 89 px | 场地 800×1552，`speedScale` 2.587，垂直穿越 1.577 s = 桌面的 1.579 s |
| 愤怒的小鸟 | 388×674（每米 25.87 px） | — | 168 px（`.pad`+`.controls` 各 44 px，其余留给选关条） | 横屏 `.side` 换到右侧 172 px、画布 670×388（每米 32.33 px、视野 20.72×12 米） |
| 飞机大战 | 386×686 | 每单位 42.89 px | 44 px（`.side` 共 85 px：统计条一条 + 控制带一排） | 横屏 `.side` 换到右侧 172 px、画布 217×386（每单位 24.11 px），竖横两档空域都是 9×16 单位 |

五款在 390×844 与 844×390 下 `document.scrollingElement.scrollHeight === clientHeight`（页面不多出滚动），
`.side` 里每枚按钮 `elementFromPoint` 全部命中（蛇 9 枚、方块 11 枚、弹球 5 枚、小鸟 10 枚、飞机大战 5 枚含「退出」）。
飞机大战还额外量了画布自身：`bareCanvasHit` 为真，且顶/中/底三点探测都落在 `canvas.board` 上，
说明悬浮的页头没把战场上的拖动吃掉（这一款整块画布都是操作区，被挡 1 px 都打不了）。
方块横屏那 4 枚按键掉出屏幕过一次：控制带里 `.pad`/`.controls` 排两列时带内需要 457 px > 390，
改成三列后 305 px 才收住 —— 改横屏带内布局后要重新量 `sideScroll`。

输入链路也在同一环境复验过（hidden 页面 `requestAnimationFrame` 冻结，按
[browser-verify.md](browser-verify.md) 的办法接管 rAF + 重挂组件 + 手动泵帧）：
蛇方向盘转向生效（`dir` 改、蛇头 y 从 10 走到 2）、滑动转向进队列；
方块按键经 `enqueue → update` 落地（旋转 `turn` 0→1、硬降得分 64、暂存换块）；
弹球拖动挡板跟手（逻辑 x 344 → 604 → 4，未越界）。

## 相关

- 档位判定：`src/utils/device.js`，`<html data-device/data-orientation>` 由 `App.vue` 写
- 危险行动的同类改造（每米像素地板、吸底 CTA）：[delta.md](delta.md)。
  它不走 `playfield.css`（局内层是 `.raid`，手机档位规则住在 `DeltaView.vue` 的 scoped 样式里），
  且手机横屏已经改成浮层形态，844×390 的实测数字记在那份文件里。
- 愤怒的小鸟的每米像素地板、`pullRef` 归一与验收数字：[birds.md](birds.md)
- 飞机大战的 9×16 空域、单位语义拖动与验收数字：[airbattle.md](airbattle.md)
- 几何地板的可回归版本：`test/layout.test.js`、`test/snake.test.js`、`test/tetris.test.js` 各自的"手机全屏"用例，
  小鸟的视野与 `pullRef` 地板在 `test/birds.test.js`，飞机大战的画布/每单位/机身与 boss 像素地板在 `test/airbattle.test.js`
