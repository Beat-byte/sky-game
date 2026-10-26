const VOICES = {
  launch: { freq: 220, type: "square", gain: 0.06, dur: 0.12 },
  paddle: { freq: 320, type: "square", gain: 0.05, dur: 0.08 },
  wall: { freq: 180, type: "triangle", gain: 0.04, dur: 0.06 },
  hit: { freq: 440, type: "sawtooth", gain: 0.04, dur: 0.05 },
  break: { freq: 660, type: "square", gain: 0.06, dur: 0.1 },
  good: { freq: 880, type: "sine", gain: 0.08, dur: 0.18 },
  bad: { freq: 140, type: "sawtooth", gain: 0.07, dur: 0.2 },
  lost: { freq: 90, type: "sawtooth", gain: 0.09, dur: 0.4 },
  shield: { freq: 520, type: "sine", gain: 0.08, dur: 0.25 },
  clear: { freq: 780, type: "triangle", gain: 0.09, dur: 0.5 },
};

export function createAudio() {
  let ctx = null;
  let muted = false;

  return {
    setMuted(value) {
      muted = value;
    },
    toggleMute() {
      muted = !muted;
      return muted;
    },
    /** 浏览器要求用户手势之后才能创建 AudioContext */
    unlock() {
      if (!ctx && typeof AudioContext !== "undefined") {
        ctx = new AudioContext();
      }
      if (ctx?.state === "suspended") ctx.resume();
    },
    play(name) {
      const voice = VOICES[name];
      if (!voice || muted || !ctx) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = voice.type;
      osc.frequency.setValueAtTime(voice.freq, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(
        Math.max(60, voice.freq * 0.6),
        ctx.currentTime + voice.dur,
      );
      gain.gain.setValueAtTime(voice.gain, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + voice.dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + voice.dur);
    },
  };
}
