# 真实页面验收（内置浏览器的已知限制）

单测绿不等于能玩 —— 交付前必须在真实页面里用**可观测信号**复验，见 [testing.md](testing.md) 末节。

## 环境行为（实测，别再重复踩）

- Qoder 内置浏览器未打开时页面 `visibilityState` 为 `hidden`：
  **`requestAnimationFrame` 完全冻结**（实测 600 ms 内 0 帧），且后台标签的 `setTimeout` 被节流到秒级
  —— 脚本里多次 `await wait()` 会撞 15 秒超时。
- 因此 `take_screenshot` 会报 `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`，
  **只能靠 `evaluate_script` 读 DOM / 画布像素做结构验证**。
- **2026-10-27 在同一 hidden 页面实测四种驱动源（各跑 2 秒）**：
  `requestAnimationFrame` **0 次** / `setInterval(16ms)` **3 次**（逐级节流到约 600 ms～1 分钟一次）/
  **Web Worker `postMessage` 177 次（≈88 Hz，不受节流）** / `MessageChannel` 自循环瞬间跑满 3000 次。
  结论：hidden 页面里唯一可靠的节拍来自 Worker；`setInterval` 兜底只能救"切到别的窗口"，救不了预览面板。
  （这就是主循环三驱动源的由来，见 [game-module.md](game-module.md)。）
- 验证"游戏到底动没动"要**直接比较 `performance.now()` 差值与 `game.timeSec` 差值**（实测比值 1.000），
  不要靠肉眼看截图，也不要把 `setTimeout(1000)` 当成 1 秒墙钟 —— 它在该环境里会迟到近一倍。

## 怎么在 hidden 页面里跑主循环

1. 覆盖 `window.requestAnimationFrame` / `cancelAnimationFrame` 捕获回调；
2. **重新挂载一次游戏组件**（否则捕获不到当前帧循环）；
3. 手动按递增时间戳泵帧，`syncStatus()` 与 `draw()` 才会执行，才能验 HUD 文本与画布像素。

泵帧时间戳必须**递增且大于挂载时的 `performance.now()`**（例如从 `1e7` 起每帧 `+16.7`）：
恒定时间戳会让 delta 为 0，递增不足则被 View 里的负 delta 夹成 0，游戏看着不动。

**带 Worker 心跳的三款（delta、birds、airbattle）不需要这套接管**：DEV 钩子里
`birdsLevel(i)` / `airbattleLevel(i)` / `deltaFrames` 之类一开局，`watch(status)` 就把心跳点起来，hidden 页面照样 60 Hz 推进
（2026-10-28 实测 birds `game.elapsed` / `performance.now()` = 1.003；
2026-10-30 实测 airbattle `game.timeSec` / `performance.now()` = **1.000**，另配 `airbattleAdvance(frames)` 手动喂帧跑完整六关）。
只挂 rAF 的旧三款（弹球 / 贪吃蛇 / 方块堆叠）在 hidden 页面里画布必然全黑（实测 `lit = 0`），
那不是回归，是没泵帧。

## 真视口档位怎么造

`take_screenshot` 不可用、内置视口又不是手机宽度时，**用同源 iframe 量**：
`width:390px;height:844px` 的 iframe 里 `window.innerWidth` 就是 390，`deviceClass` 判档与手机一致
（别给外层容器塞内联样式假盒子 —— JS 按真实 `window` 判朝向，假盒子给出的数据自相矛盾）。
横屏就在同一个 iframe 上改尺寸 + `contentWindow.dispatchEvent(new contentWindow.Event('resize'))`，
再补一次 `birdsRelayout()`，可以顺手验"事件丢失时是否按容器盒子重排"。
组件根自己带 `.playfield` 类时 `querySelector('.playfield')` 找不到它，探针要直接取根元素。

## 两条铁律

1. **换路由要用真实锚点点击**（首页卡片 `a.card[href="/game/<id>"]`、返回链接 `a[href="/"]`）。
   别用 `history.pushState` + 派发 `popstate` —— vue-router 认不出自造 state，
   路由状态更新了但视图不换，后面所有断言都打在旧组件上。
2. **一次 `evaluate_script` 只有一轮微任务/宏任务**，同步读 DOM 拿到的是上一次 flush 的旧文本；
   需要 DOM 反映最新状态时，脚本末尾 `await new Promise(r => setTimeout(r, 60))` 再读。
   页面在两次工具调用之间可能被重置回首页，所以整条回归（进游戏 → 开局 → 泵帧 → 结束 → 读 localStorage）
   尽量写在同一个脚本里。

## 补充坑位

- **同一 URL 的 `navigate_page` 不会重载 app 模块**：改完源码要
  `location.href = '...?x=' + Date.now()` 硬重载，否则测的是旧模块。
  要证明 live 模块已更新，可以 `fetch('/src/games/delta/scene3d.js?t=')` 再对照
  `window.deltaThree().spec.ground`。
- **画布选择器会撞 GL 画布**：双视图下两张画布同格叠放，`canvas.board` 命中第一张（WebGL，
  clientWidth 0、取样全黑）。用 `canvas.board:not(.gl)`，且必须先 `deltaFrames` 泵帧再取样。
- **WebGL 可能建不起来**（`THREE.WebGLRenderer: Error creating WebGL context.`），属环境抖动。
  遇到就验降级路径是否正确（回俯视 + `.stage-msg` 显示原因 + 偏好写回 `topdown`），重载后再测 fps。
- 画布像素检查：`getImageData` 统计亮像素数（蛇一局约 5–6 千、方块含侧栏面板约 7–8 万），
  为 0 说明主循环没跑或 `setupCanvas` 没被调用。危险行动第一人称的验收数字记在
  [delta.md](delta.md) 末节；愤怒的小鸟有整片天空渐变，`alpha > 0` 恒 100%，
  所以要**隔固定步长采样颜色种类**（实测每 997 px 采一次得 199 种）才说明真的画了东西，
  数字见 [birds.md](birds.md) 末节。

## 相关

- 各游戏的 DEV 钩子清单见 [game-module.md](game-module.md)
- dev 服务与端口见 [stack-and-deps.md](stack-and-deps.md)
