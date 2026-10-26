/**
 * 贪吃蛇音效：WebAudio 现场合成，零音频文件。
 * 浏览器策略要求首次用户手势后才能创建 AudioContext，所以 unlock() 由输入回调调用。
 */

const VOICES = {
  eat: { type: "triangle", freq: 660, to: 880, ms: 90, gain: 0.16 },
  level: { type: "square", freq: 520, to: 1040, ms: 160, gain: 0.14 },
  over: { type: "sawtooth", freq: 320, to: 90, ms: 420, gain: 0.18 },
  win: { type: "triangle", freq: 700, to: 1400, ms: 320, gain: 0.16 },
  click: { type: "sine", freq: 440, to: 520, ms: 60, gain: 0.1 },
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
