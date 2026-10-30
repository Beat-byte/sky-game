/**
 * 音效：WebAudio 现场合成，零音频文件（与另外五款同一套写法）。
 * 浏览器要求首次用户手势之后才能创建 AudioContext，所以 unlock() 由输入回调调用。
 *
 * 射击声刻意不做：每秒 3~5 发的合成器会盖过一切，也把 CPU 烧在音频上；
 * 这里只在"有信息量"的时刻出声——击杀、中弹、炸弹、道具、过关、结算。
 */

const VOICES = {
  hit: { type: "square", freq: 880, to: 420, ms: 70, gain: 0.1 },
  boom: { type: "sawtooth", freq: 300, to: 70, ms: 220, gain: 0.16 },
  bigboom: { type: "sawtooth", freq: 180, to: 40, ms: 620, gain: 0.2 },
  hurt: { type: "square", freq: 200, to: 60, ms: 300, gain: 0.18 },
  power: { type: "triangle", freq: 520, to: 1180, ms: 200, gain: 0.14 },
  bomb: { type: "sine", freq: 640, to: 48, ms: 700, gain: 0.22 },
  wave: { type: "triangle", freq: 420, to: 900, ms: 340, gain: 0.15 },
  over: { type: "sawtooth", freq: 320, to: 70, ms: 620, gain: 0.18 },
  win: { type: "triangle", freq: 660, to: 1500, ms: 520, gain: 0.17 },
  click: { type: "sine", freq: 440, to: 520, ms: 60, gain: 0.09 },
};

export function createAudio() {
  let ctx = null;
  let muted = false;

  return {
    setMuted(value) {
      muted = Boolean(value);
    },
    isMuted: () => muted,
    toggleMute() {
      muted = !muted;
      return muted;
    },
    unlock() {
      if (ctx || typeof AudioContext === "undefined") return;
      try {
        ctx = new AudioContext();
      } catch {
        ctx = null;
      }
    },
    play(name) {
      const voice = VOICES[name];
      if (!voice || muted || !ctx) return;
      if (ctx.state === "suspended") ctx.resume?.();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = voice.type;
      const now = ctx.currentTime;
      osc.frequency.setValueAtTime(voice.freq, now);
      osc.frequency.exponentialRampToValueAtTime(voice.to, now + voice.ms / 1000);
      gain.gain.setValueAtTime(voice.gain, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + voice.ms / 1000);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now);
      osc.stop(now + voice.ms / 1000 + 0.02);
    },
    dispose() {
      try {
        ctx?.close?.();
      } catch {
        // 关闭失败无所谓，页面已经要卸载了
      }
      ctx = null;
    },
  };
}
