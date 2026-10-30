/**
 * 主循环的心跳来源。
 *
 * 为什么不用 setInterval：页面不可见时（Qoder 内置预览、切到别的标签、微信内浏览器）
 * rAF 一帧都不发、定时器还会被逐级节流到分钟级，玩家看到的就是"点了开始画面冻住"。
 * Web Worker 的 postMessage 不参与这套节流（同页面实测 2 秒 177 条），
 * 所以由 Worker 喊节拍、主线程按自己的 performance.now() 算 dt。
 *
 * Worker 不发送时间戳：Worker 的 performance.timeOrigin 与页面不保证同一条基准，
 * 跨上下文比时间会算出负的 dt。它只负责"该推进了"，推进多少由主线程自己量。
 */
let id = 0;

self.onmessage = (event) => {
  if (event.data === "start") {
    if (id) return;
    id = setInterval(() => self.postMessage("tick"), 1000 / 60);
  } else if (event.data === "stop") {
    clearInterval(id);
    id = 0;
  }
};
