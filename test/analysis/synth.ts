// Synthetic test signals with known ground truth.
export const SR = 22050;

export function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const silence = (seconds: number) => new Float32Array(Math.round(seconds * SR));

export function sine(freq: number, seconds: number, amp = 0.5) {
  const out = silence(seconds);
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

function add(buf: Float32Array, t: number, len: number, f: (i: number) => number) {
  const s = Math.round(t * SR);
  for (let i = 0; i < len && s + i < buf.length; i++) if (s + i >= 0) buf[s + i] += f(i);
}

export function kick(buf: Float32Array, t: number, gain = 1) {
  let phase = 0;
  add(buf, t, Math.round(0.25 * SR), (i) => {
    const tt = i / SR;
    phase += (2 * Math.PI * (50 + 70 * Math.exp(-tt / 0.03))) / SR;
    return gain * 0.8 * Math.exp(-tt / 0.08) * Math.sin(phase);
  });
}

export function snare(buf: Float32Array, t: number, r: () => number, gain = 1) {
  // noise through a 2-pole resonator at ~900Hz
  const w = (2 * Math.PI * 900) / SR, rad = 0.97;
  let y1 = 0, y2 = 0;
  add(buf, t, Math.round(0.15 * SR), (i) => {
    const x = r() * 2 - 1;
    const y = x + 2 * rad * Math.cos(w) * y1 - rad * rad * y2;
    y2 = y1; y1 = y;
    return gain * 0.06 * Math.exp(-i / SR / 0.05) * y;
  });
}

export function hat(buf: Float32Array, t: number, r: () => number, gain = 1) {
  let prev = 0, prev2 = 0;
  add(buf, t, Math.round(0.04 * SR), (i) => {
    const x = r() * 2 - 1;
    const y = x - 2 * prev + prev2; // second difference = high-pass
    prev2 = prev; prev = x;
    return gain * 0.12 * Math.exp(-i / SR / 0.012) * y;
  });
}

export function clickTrack(bpm: number, seconds: number, start = 0.5, jitter = 0, seed = 1) {
  const buf = silence(seconds);
  const r = rng(seed);
  const beats: number[] = [];
  for (let t = start; t < seconds - 0.3; t += 60 / bpm) {
    const tt = t + (jitter ? (r() * 2 - 1) * jitter : 0);
    beats.push(tt);
    kick(buf, tt);
    hat(buf, tt, r);
  }
  return { pcm: buf, beats };
}

/** Rock beat: kick on 1 & 3, snare on 2 & 4, hats on 8ths. */
export function drumPattern(bpm: number, bars: number, seed = 7) {
  const r = rng(seed);
  const beat = 60 / bpm;
  const start = 0.5;
  const pcm = silence(start + bars * 4 * beat + 1);
  const truth: { t: number; band: 0 | 1 | 2 }[] = [];
  for (let b = 0; b < bars * 4; b++) {
    const t = start + b * beat;
    if (b % 2 === 0) { kick(pcm, t); truth.push({ t, band: 0 }); }
    else { snare(pcm, t, r); truth.push({ t, band: 1 }); }
    hat(pcm, t, r);
    hat(pcm, t + beat / 2, r);
    truth.push({ t: t + beat / 2, band: 2 });
  }
  return { pcm, truth, beat, start };
}

/** Harmonic tone (fundamental + 3 harmonics) with optional vibrato, 10ms fades. */
export function tone(buf: Float32Array, t: number, midi: number, dur: number, amp = 0.2, vibrato = 0) {
  const f0 = 440 * 2 ** ((midi - 69) / 12);
  let ph = 0;
  const fade = 0.01 * SR, len = Math.round(dur * SR);
  add(buf, t, len, (i) => {
    const f = f0 * 2 ** ((vibrato * Math.sin(2 * Math.PI * 5.5 * (i / SR))) / 12);
    ph += (2 * Math.PI * f) / SR;
    const env = Math.min(1, i / fade, (len - i) / fade);
    return amp * env * (Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.3 * Math.sin(3 * ph) + 0.15 * Math.sin(4 * ph));
  });
}

/**
 * 32 bars at 120 BPM: verse (quiet, A-minor pad) / chorus (loud, C-major riff) / verse / chorus.
 * Drums play the same pattern everywhere, only louder in the chorus.
 */
export function verseChorusSong(seed = 5) {
  const r = rng(seed);
  const beat = 0.5, start = 0.5, bars = 32;
  const pcm = silence(start + bars * 4 * beat + 1);
  const chorusBars = (b: number) => (b >= 8 && b < 16) || b >= 24;
  for (let bar = 0; bar < bars; bar++) {
    const ch = chorusBars(bar);
    const g = ch ? 1 : 0.3;
    for (let k = 0; k < 4; k++) {
      const t = start + (bar * 4 + k) * beat;
      if (k % 2 === 0) kick(pcm, t, g); else snare(pcm, t, r, g);
      for (let s = 0; s < 4; s++) hat(pcm, t + (s * beat) / 4, r, g * 0.7);
      const riff = ch ? [72, 76, 79, 76] : [69, 72, 76, 72];
      tone(pcm, t, riff[k], beat * 0.9, ch ? 0.12 : 0.04);
    }
  }
  return { pcm, beat, start, chorusBars, bars };
}
