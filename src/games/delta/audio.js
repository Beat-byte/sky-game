/**
 * 「危险行动」音效：WebAudio 现场合成，零音频文件（与另三款同一套做法）。
 *
 * 只有音色，没有游戏数值：`play(name)` 不读引擎状态也不写。
 * 枪声按武器的 sfx 分流（手枪闷、步枪脆、霰弹炸、狙弹长），
 * 命中与搜索完成用短促音，避免长时间游戏后听觉疲劳。
 */

const VOICES = {
  shot_light: { type: "square", freq: 420, to: 120, ms: 70, gain: 0.12, noise: 0.05 },
  shot_smg: { type: "square", freq: 520, to: 150, ms: 55, gain: 0.1, noise: 0.06 },
  shot_rifle: { type: "sawtooth", freq: 640, to: 130, ms: 80, gain: 0.13, noise: 0.09 },
  shot_shell: { type: "sawtooth", freq: 260, to: 60, ms: 150, gain: 0.16, noise: 0.16 },
  shot_sniper: { type: "sawtooth", freq: 900, to: 90, ms: 220, gain: 0.15, noise: 0.12 },
  hit: { type: "triangle", freq: 880, to: 620, ms: 50, gain: 0.09 },
  hurt: { type: "sawtooth", freq: 220, to: 90, ms: 180, gain: 0.13 },
  search: { type: "triangle", freq: 520, to: 780, ms: 120, gain: 0.1 },
  reload: { type: "square", freq: 300, to: 220, ms: 90, gain: 0.07 },
  med: { type: "sine", freq: 440, to: 880, ms: 260, gain: 0.1 },
  skill: { type: "sine", freq: 660, to: 1320, ms: 300, gain: 0.1 },
  exfil: { type: "triangle", freq: 600, to: 1000, ms: 400, gain: 0.12 },
  escape: { type: "triangle", freq: 700, to: 1500, ms: 700, gain: 0.15 },
  dead: { type: "sawtooth", freq: 300, to: 60, ms: 900, gain: 0.16 },
  click: { type: "sine", freq: 520, to: 600, ms: 50, gain: 0.07 },
};

export function createAudio() {
  let ctx = null;
  let muted = false;
  /** 枪声密集时限制同时发声数，否则 620 rpm 会把手机构成卡顿 */
  const active = new Set();

  const voiceDuration = (voice) => voice.ms / 1000;

  function blip(voice) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    osc.type = voice.type;
    osc.frequency.setValueAtTime(voice.freq, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, voice.to), now + voiceDuration(voice));
    gain.gain.setValueAtTime(voice.gain, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + voiceDuration(voice));
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + voiceDuration(voice) + 0.02);
    active.add(osc);
    osc.onended = () => active.delete(osc);
  }

  /** 枪声的"爆"靠一段极短白噪声，纯振荡器听起来像电子音而不是射击 */
  function burst(voice) {
    const frames = Math.floor(ctx.sampleRate * voiceDuration(voice));
    const buffer = ctx.createBuffer(1, Math.max(1, frames), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i += 1) data[i] = (1 - i / frames) * (Math.random() * 2 - 1);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = voice.noise ?? 0.06;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 1800;
    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start();
    active.add(source);
    source.onended = () => active.delete(source);
  }

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
      if (active.size > 12) return;
      blip(voice);
      if (voice.noise) burst(voice);
    },
    dispose() {
      for (const node of active) {
        try {
          node.stop?.();
        } catch {
          // 已经结束的节点 stop 会抛，忽略
        }
      }
      active.clear();
      try {
        ctx?.close?.();
      } catch {
        // 关闭失败无所谓，页面已经要卸载了
      }
      ctx = null;
    },
  };
}

export const AUDIO_NAMES = Object.keys(VOICES);
