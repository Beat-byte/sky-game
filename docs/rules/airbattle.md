# 「飞机大战」（airbattle）专属规矩

改 `src/games/airbattle/` 下任何文件前先读这份。通用分工、主循环三驱动源、DEV 钩子约定见
[game-module.md](game-module.md)；真实页面验收办法见 [browser-verify.md](browser-verify.md)；
手机端全屏层见 [mobile-playfield.md](mobile-playfield.md)。

## 文件分工（引擎框架无关，整个目录不许 import Vue）

| 文件 | 只负责 | 不许做 |
| --- | --- | --- |
| `field.js` | 逻辑空域 `FIELD`、`hashJitter`、`SHIP`/`SHOT`/`ENEMIES`/`WEAPONS`/`ITEMS`/`BOMB`/`COMBO` 数值表 | 像素、DOM、关卡顺序 |
| `waves.js` | 六关手写编成 `LEVELS`、`laneX`、`validateGroups` 自检、`planFor` 逐架展开 | 物理步进、渲染 |
| `game.js` | 局内状态机（跟随、开火、弹幕、掉落、连击、过关与结算） | `Date.now`/`performance`、`localStorage`、像素 |
| `layout.js` | 舞台盒子→画布几何、`unit`、屏幕↔世界换算、`metricsFor`、背衬 DPR | 玩法数值 |
| `renderer.js` | 星空/机体/子弹/道具/碎屑/白闪/暗幕的 2D 绘制与 `setupCanvas` | 写任何游戏状态 |
| `input.js` | 手势与按键 → 意图（`onDrag`/`onAxis`/`onAction`） | 直接改状态 |
| `audio.js` | WebAudio 现场合成 10 个音色、`unlock`/静音 | 音频文件 |
| `tick.js` | Worker 心跳（只发 `"tick"`，不带时间戳） | 计算 dt |
| `AirbattleView.vue` | 装配：生命周期、主循环、HUD、战绩与结算落盘 | 碰撞或几何数学 |

**数值表的真实来源是 `field.js`，编成表的真实来源是 `waves.js`**：`renderer.js` 与 HUD 都从这两处 import，
复制一份数字就等于埋下"画出来和打起来不一样"的分歧。

## 恒定口径：空域恒 9×16 单位，长宽比钉死

这一款把"难度与设备无关"做得比另几款更强 —— 空域是**离散单位**，不是按比例伸缩的连续场地：

- `FIELD = { w: 9, h: 16 }`。竖屏、平板、桌面看到的**横向 9 单位、纵向 16 单位完全一样**，
  `fitBoard` 只做 9:16 内接（letterbox），所以画布永远居中、四周留边，而不是"手机上看到更窄的一条"。
- `unit = css.width / 9` 只决定**一单位画多少像素**，不参与任何判定：敌机从入场飞到出场几秒、
  碰撞半径多大、子弹飞多快，全部写在单位与秒里（`vy`、`SHOT.speed`、`SHIP.speed` 都是单位/秒）。
- 与另两款的对照：弹球是连续场地只能保「垂直穿越时间恒定」（`speedScale`）、小鸟保「横向 15 米恒定」（`ppm`），
  飞机大战保的是「单位恒定」。三种口径不能互相替换，改任何一款的几何前先确认自己动的是哪一套。
- **手机不吃亏的那条**在输入层：拖动报的是**相对单位增量**（像素 ÷ `unit`），不是绝对跟手。
  桌面拖 90 px 与手机拖 90 px 得到的位移按各自 `unit` 折算，所以小屏不会"拖满屏幕才挪一点点"。
  这条与小鸟的 `pullRef` 屏幕归一是同一个问题的同一个解法。

## 编成：六关全手写，每次展开都自检

`边境巡逻 → 干扰编队 → 火力点突入 → 轰炸机航线 → 护航歼灭 → 母舰突袭`，逐架展开后的实测架数
**12 / 17 / 17 / 16 / 23 / 13**。

- **不许程序生成**：弹幕游戏靠节奏，随机刷怪会把"三下点掉一架"变成"永远在打空气"。
  每关是一串 `groups = { at, kind, count, gap, lane }`，`lane ∈ left|right|mid|spread|alt|sine`。
- `validateGroups(levelIndex)` 返回错误数组：未知类型、未知 lane、架数 ≤ 0、`at` 倒序、
  **boss 只许出现在第 6 关**（`BOSS_LEVEL = 6`）。单测逐关钉成空数组。
- `planFor()` 把小组展开成逐架 `{ at, kind, x, amp, period, phase, index }`，`seed = (level+1)*977 + gi*31 + i`
  喂给 `hashJitter` —— **同一关永远同一份计划、同一串入场点**。机动幅度还要夹进场地：
  `amp = min(spec.amp, x - r, FIELD.w - r - x)`，所以 `sine` 摆到边上时不会把敌机甩出屏幕。
- 掉落由击坠序号 `this.kills` 派生（不是随机数），因此"第几架掉道具"可复现，单测才钉得住"两遍逐位相等"。

## 数值表：全部有单测上下限

- `SHIP`：`r 0.55`、`speed 11` 单位/秒、生命 `hpStart 3 / hpMax 5`、炸弹 `bombsStart 2 / bombsMax 3`、
  中弹无敌 `invuln 1.35` s、1 档射击间隔 `fireBase 0.28` s、开局 `startY = 16 - 2.2`。
- `SHOT`：速度 24、半径 0.16、伤害 1；`ENEMY_SHOT`：速度 6.8、半径 0.2、伤害 1。
- `WEAPONS`（4 档，间隔倍率 × 弹道）：`1.0/单发` → `0.9/双发 ±0.34` → `0.8/三发 ±0.46` →
  `0.7/四发（±0.26 直、±0.66 带 `vx ±3.2` 外扩）`。
- `ENEMIES`：

| 机型 | hp | r | vy（单位/秒） | stop | fire | 分数 | 掉落率 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| scout | 1 | 0.5 | 3.4 | — | — | 100 | 0.07 |
| dart | 1 | 0.46 | 5.2 | — | — | 140 | 0.06 |
| fighter | 3 | 0.62 | 2.5 | — | 2.2 | 220 | 0.18 |
| gunner | 5 | 0.78 | 1.9 | 4.6 | 1.5 | 320 | 0.32 |
| bomber | 9 | 0.9 | 1.4 | 6.4 | 2.6（双发） | 520 | 0.45 |
| boss | 64 | 1.7 | 1.1 | 4.2 | 1.0（三发扇形） | 4000 | 1 |

- `RAM`：撞机玩家掉 1 血、**敌机自己也掉 3 血**（撞击不是无代价的）。
- `BOMB`：全屏 8 点伤害 + 清空敌弹 + 0.9 s 无敌 + 0.5 s 白闪。
- `ITEMS`：`power`/`repair`/`bomb` 三种，`vy 2.4`、`r 0.55`，吃到了分别 +1 火力档 / +1 血 / +1 炸弹，
  各自带 120/150/150 分。
- `COMBO`：`hold 3.2` s 内不击杀就清零，每阶 +2% 分数，封顶 20 阶。
- 通关奖励：`bonus = 剩余生命 × 800 + 剩余炸弹 × 400`，写进结算文案。

## 状态机与"这一关打完了"

`status`：`ready|playing|paused|over|won`。

- `update()` 非 `playing` 直接返回，所以暂停真的冻结（单测钉住）；单帧 dt 在 View 的 `pump` 与引擎的
  `clampDt` 两处都夹 **0.05 s** —— 切回标签或看门狗补帧时宁可慢放，也不让飞机一帧穿过弹幕。
- `checkProgress()` 要求 **`cursor` 走到计划末尾且场上敌机为 0** 才过关；
  第 6 关满足时算 `bonus` 并置 `won`，否则 `level += 1` 并挂 2 秒横幅。
  **少一条"场上清空"就会在 boss 还没刷出来时判过关。**
- **悬停不瞬移（真实踩过的坑）**：`stepEnemies` 里起伏必须是 `if (e.stopped && spec.stop)`。
  早先写成只看 `spec.stop`，敌机还在下降途中就被按回停止线，画面上等于凭空跳一截。
- `hurt()` 只在 `invuln <= 0` 时扣血，坠机（`hp <= 0`）才置 `over`；`hit`/`spark` 一类表现事件不带状态改动。
- `jumpTo(index)` **只为验收与单测存在**：打满六关要喂几分钟的帧，boss 关与结算奖励不该靠自然推进去验。
  它清空 `enemies/eshots/items`、把 `cursor`/`waveTime` 归零，其余状态（分数、火力、生命）不动。

## 输入与主循环

- 触屏：画面任意处**按住拖动** = 目标点相对位移（`onDrag(dxPx/unit, dyPx/unit)`），松手停在原地；
  轻点（< 300 ms 且位移 < 12 px）走 `primary`。刻意不做绝对跟手 —— 竖屏手指会盖住机身。
- 键盘：`↑↓←→`/`WASD` 平移（多键按住由 `held` 集合合成一个轴，`keyup`/`blur`/`pointercancel` 归零）、
  `空格`/`Enter` 开始、`B`/`Shift` 投弹、`P`/`Esc` 暂停、`R` 重开、`M` 静音。
- `bindInput` 返回 `{ unbind }`（不是裸函数），装配层按 `input.unbind()` 统一清理。
- 三驱动源（rAF + Worker 心跳 + `setInterval` 看门狗）共用一条 `pump` 与同一个 `last` 游标；
  `watch(status)` 只在 `playing` 时让 Worker 发 `"start"`，结算/暂停画面不挂 60 Hz 心跳，卸载 `terminate()`。
  `visibilitychange` 回到可见时把游标清零，dt 夹 0.05 s。
- 手机档**不做横屏引导**（与危险行动不同）：空域长宽比钉死 9:16，竖屏就是它的设计朝向，横屏只是画布变小。

## 渲染：只画，而且不许反查实体

- `draw()` 里不许 `game.enemies.find(...)` 这类反查。碎屑的半径必须**由引擎写在 fx 事件上**
  （`{ kind, x, y, t, life, seed, r }`）：上一版让 `drawFx` 用 `seed` 去 `find` 实体，实体一离场半径就取不到，
  爆炸忽大忽小，还让"渲染不改状态"的对拍变得依赖存活顺序。
- 星层、机体尾焰相位、花纹一律由 `hashJitter(整数序号, 盐)` + `game.timeSec` 取模派生，**不用渐变、不画文字**
  （文字全在 DOM 侧），这样同相位跑两遍逐笔一致，`test/airbattle.test.js` 的对拍才成立。
- 局内只在画布上压一层暗幕表示四种停局态（`ready/paused/over/won`），单测按"满屏 `fillRect(0,0,…)` 笔数"钉住
  （局内 1 笔、停局 2 笔）。

## DEV 钩子（`import.meta.env.DEV`，卸载时逐个 delete）

`window.airbattle`（引擎实例）、`airbattleLayout()`、`airbattleRelayout()`、`airbattleAdvance(frames, ms)`
（手动喂帧，hidden 页面里唯一能把六关跑完的办法）、`airbattleMove(dxUnits, dyUnits)`（回读 `ship` 与 `target`）、
`airbattleBomb()`、`airbattleLevel(index)`、`airbattleBoxes()`。
`airbattleBoxes()` 回读视口 / 档位 / 朝向 / `unit` / `view` / `.playfield` 根 / `.stage` / `.board` / `.side` /
`.controls` / `sideScroll` / 每枚按钮的 `elementFromPoint` 命中 / `bareCanvasHit`。
两个既有约定：**`.playfield` 就是组件根**，`querySelector(".playfield")` 找不到自己，`full` 直接取根元素；
桌面/平板档位 `.exit` 是 `display:none`（0×0），命中检查跳过它，否则白报"点不动"。

## 真实页面的验收数字（2026-10-30 实测，复验时对齐）

同一 hidden 页面，同源 iframe 真视口（`?fx=` 硬重载，别用内联样式假盒子）：

| 档位 | `.stage` | 画布 CSS | `unit` | 空域 | 按钮命中 | 控制带 |
| --- | --- | --- | --- | --- | --- | --- |
| 390×844 手机竖屏 | 390×759（fixed，`y=0`） | **386×686** | 42.889 | 9×16 | 5/5，含「退出」 | `.side` 390×85 贴底，`.controls` 378×44（`y=794`，底边 838） |
| 844×390 手机横屏 | 672×390 | **217×386**（`x=228`） | 24.111 | 9×16 | 5/5，含「退出」 | `.side` 右侧 172×390，`.controls` 159×94 两列 |
| 1280×800 平板横屏 | 950×634 | **354×630** | 39.333 | 9×16 | 4/4（`.exit` 隐藏） | `.side` 240 px，`.stats` 4 列 |
| 1920×1080 桌面 | 1530×914 | **512×910** | 56.889 | 9×16 | 4/4（`.exit` 隐藏） | `.side` 300 px |

- **空域四档全等**：`view` 恒为 `9×16`，`unit` 分别 42.889 / 24.111 / 39.333 / 56.889 —— 只有像素大小变，判定不变。
- **主循环真的在跑**：`game.timeSec` 差 / `performance.now()` 差 = **1.000**（hidden 页面 2 s 墙钟推进 2 s 游戏时间，
  由 Worker 心跳驱动；rAF 在该环境里 0 帧）。
- **画布真的在画**：竖屏 backing `772×1372`（dpr 2），与左上角底色不同的像素 **4861 个（0.56%）**、
  隔 997 px 采样到 7 种颜色（本作是深底星空 + 小尺寸机体，不是整片渐变，亮像素占比本来就低；
  为 0 才说明主循环或 `setupCanvas` 坏了）。
- **触控不被浮层吃掉**：`bareCanvasHit` true；竖屏与横屏各探画布的顶 3%、35%、50%、底 97%、左边 2%、右边 98%
  六个点，`elementFromPoint` 全部落在 `canvas.board` 上（手机全屏层 fixed `z-index:30` 压在页头之上，
  悬浮的 header 没挡战场；这一款整块画布都是操作区，被挡 1 px 就拖不动）。
- **不多出一屏滚动**：竖屏 `scrollHeight 844 == clientHeight 844`、横屏 `390 == 390`；`.playfield` computed
  `position: fixed`；`.side` 自身 `scrollWidth == clientWidth`（竖 390/390、横 171/171）、`scrollHeight == clientHeight`
  （竖 84/84、横 390/390）—— 统计条与控制带排进一条之后没有把按键顶出屏幕。
- **拖动是单位语义**：拖 `+90 px / -72 px` → `target` 变化 `+2.10 / -1.68` 单位（`90/42.889`、`72/42.889` 精确对齐），
  机身随后逐帧追到目标点，没有瞬移。
- **boss 与通关**：`airbattleLevel(5)` → HUD「6 / 6」、计划 13 架；喂约 1080 帧后 boss 进场（`hp 64`、`r 1.7`、
  从 `y = -1.68` 起以 0.28 单位/15 帧匀速下降）；清空全场后 `status = won`、
  `bonus 5200 = 5×800 + 3×400`、`score 13656`、击坠 13 架，覆盖层文案「母舰被打下来了…（含剩余生命与炸弹奖励 5200 分）」。
- **落盘证据**：`sky-games:game:airbattle` = `{v:1, best:13656, plays:2, records:[{score:13656, level:6, won:true, ms:36429, outcome:"won"}, {score:3231, level:6, won:false, ms:104707, outcome:"over"}]}`；
  战绩区两行「全部通关」「座机坠落」。中途点「退出」锚点会走路由卸载 → `endSession("quit")` 照样留档。
- 静音按钮把 `sky-games:global` 写成 `{v:1, prefs:{muted:true}}`，再点回 `false`。
- 构建产物：`AirbattleView` chunk **11.55 kB gzip**（CSS 另 0.97 kB），无 three、无音频文件。

## 改 X 必须同步 Y

- 改**空域 `FIELD` 或任何速度/半径数值** → `test/airbattle.test.js` 的"入场与机动不出界""弹道不出界"
  与 `test/layout.test.js` 的档位期望一起看；手机上限地板（`unit ≥ 40`、机身 ≥ 45 px、boss ≥ 100 px）在
  `test/airbattle.test.js` 的手机地板一例里，改小屏幕几何时先确认这条地板还成立。
- 改**编成表 `LEVELS`** → 该关 `validateGroups` 必须仍是空数组；单测钉住三条：关卡数不跌破
  `LEVEL_COUNT_FLOOR`（6 关）、每关 `planSize(i) >= 12` 架、第 1 关恰好 12 架且第 5 关更密 —— 动了就重算期望值；
  boss 仍然只许在第 6 关，且只有一架。
- 改 **`fitBoard`/`airbattleLayout`/`worldToScreen`** → 三端 `view` 恒 `9×16` 那条断言与坐标互逆用例一起动，
  页面里重新读 `airbattleBoxes()` 的四档 `unit`。
- 改 **`input.js` 的拖动/轴语义** → `test/airbattle.test.js` 的假 DOM 输入层用例（单位增量 `[1, 0.25]`、
  轻点、轴合成与归零、6 个动作、`{unbind}` 后监听数为 0）一起改，页面里必须重测真 PointerEvent 位移换算。
- 改 **`src/styles/playfield.css`** → airbattle 与另四款共用同一套类名，重量手机档的 `elementFromPoint`
  与 `sideScroll`，见 [mobile-playfield.md](mobile-playfield.md)。
- 给 `renderer.js` 加新的 canvas 手段 → 同步 `test/airbattle.test.js` 的记录型 ctx 桩（桩里缺方法直接崩）。
- 改**结算/落盘结构** → 走 `store.commitRun("airbattle", …)`，同步 `test/store.test.js` 与 `SCHEMA_VERSION`，
  见 [store.md](store.md)。

## 相关

- 主循环三驱动源与模块分工细则：[game-module.md](game-module.md)
- hidden 页面泵帧与画布取样：[browser-verify.md](browser-verify.md)
- 回归基线：`test/airbattle.test.js` 41 例（全套 219 例）
