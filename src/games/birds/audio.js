/**
 * 音效：WebAudio 现场合成，零音频文件。
 * 浏览器要求首次用户手势后才能建 AudioContext，所以 unlock() 由输入回调调用。
 * 形状与贪吃蛇那份一致（setMuted / isMuted / toggleMute / unlock / play / dispose），
 * 装配层的清理顺序因此可以完全相同。
 */

const VOICES = {
  click: { type: "sine", freq: 420, to: 520, ms: 50, gain: 0.08 },
  pull: { type: "triangle", freq: 180, to: 260, ms: 90, gain: 0.06 },
  launch: { type: "sawtooth", freq: 300, to: 760, ms: 160, gain: 0.13 },
  dash: { type: "square", freq: 900, to: 1500, ms: 110, gain: 0.12 },
  thud: { type: "sine", freq: 140, to: 60, ms: 150, gain: 0.16 },
  crack: { type: "square", freq: 520, to: 300, ms: 60, gain: 0.07 },
  break: { type: "triangle", freq: 360, to: 120, ms: 160, gain: 0.13 },
  glass: { type: "sawtooth", freq: 1600, to: 900, ms: 120, gain: 0.1 },
  pig: { type: "triangle", freq: 640, to: 220, ms: 220, gain: 0.15 },
  boom: { type: "sawtooth", freq: 220, to: 40, ms: 420, gain: 0.2 },
  win: { type: "triangle", freq: 620, to: 1240, ms: 340, gain: 0.15 },
  fail: { type: "sawtooth", freq: 300, to: 80, ms: 460, gain: 0.16 },
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
      const seconds = voice.ms / 1000;
      osc.frequency.setValueAtTime(voice.freq, now);
      osc.frequency.exponentialRampToValueAtTime(voice.to, now + seconds);
      gain.gain.setValueAtTime(voice.gain, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + seconds);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now);
      osc.stop(now + seconds + 0.02);
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
