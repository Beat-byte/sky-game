/**
 * 方块堆叠自己的音效模块（WebAudio 合成，不加载任何素材，也不复用弹球的音色表）。
 * 每种音色只用一个振荡器 + 一条音量包络；消行按连消数量叠加短琶音，强化「啪」的反馈。
 * 浏览器要求先有用户手势才能建 AudioContext，所以 unlock() 由装配层在点击/按键时调用。
 */

const VOICES = {
  move: { freq: 180, type: "square", gain: 0.03, dur: 0.045 },
  rotate: { freq: 300, type: "square", gain: 0.04, dur: 0.06 },
  hold: { freq: 420, type: "triangle", gain: 0.05, dur: 0.12 },
  lock: { freq: 140, type: "triangle", gain: 0.05, dur: 0.07 },
  drop: { freq: 90, type: "sawtooth", gain: 0.06, dur: 0.1 },
  clear1: { freq: 520, type: "square", gain: 0.06, dur: 0.14 },
  clear2: { freq: 620, type: "square", gain: 0.07, dur: 0.18 },
  clear3: { freq: 720, type: "square", gain: 0.07, dur: 0.22 },
  perfect: { freq: 880, type: "sawtooth", gain: 0.09, dur: 0.36 },
  over: { freq: 110, type: "sawtooth", gain: 0.09, dur: 0.5 },
};

/** 连消时的上行琶音（相对主音的倍数） */
const CLEAR_ARPEGGIO = [1, 1.26, 1.5, 1.9];

export function createAudio() {
  let ctx = null;
  let muted = false;

  function blip(name, ratio = 1, delay = 0) {
    const voice = VOICES[name];
    if (!voice || muted || !ctx) return;
    const start = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = voice.type;
    osc.frequency.setValueAtTime(voice.freq * ratio, start);
    osc.frequency.exponentialRampToValueAtTime(Math.max(50, voice.freq * ratio * 0.6), start + voice.dur);
    gain.gain.setValueAtTime(voice.gain, start);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + voice.dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + voice.dur);
  }

  return {
    setMuted(value) {
      muted = Boolean(value);
    },
    isMuted() {
      return muted;
    },
    toggleMute() {
      muted = !muted;
      return muted;
    },
    /** 浏览器要求用户手势之后才能创建/恢复 AudioContext */
    unlock() {
      if (!ctx && typeof AudioContext !== "undefined") {
        ctx = new AudioContext();
      }
      if (ctx?.state === "suspended") ctx.resume();
    },
    play(name) {
      if (muted || !ctx) return;
      const clearIndex = Number(name.slice(-1));
      if (name.startsWith("clear") && Number.isInteger(clearIndex) && clearIndex > 0) {
        for (let i = 0; i < clearIndex; i += 1) {
          blip(name, CLEAR_ARPEGGIO[i % CLEAR_ARPEGGIO.length], i * 0.05);
        }
        return;
      }
      // 一次性音效不排队，直接按主音播放
      blip(name === "perfect" ? "perfect" : name);
    },
    dispose() {
      if (!ctx) return;
      const closing = ctx.close?.();
      ctx = null;
      if (closing && typeof closing.catch === "function") closing.catch(() => {});
    },
  };
}
