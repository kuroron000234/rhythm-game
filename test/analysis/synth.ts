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

export function kick(buf: Float32Array, t: number) {
  let phase = 0;
  add(buf, t, Math.round(0.25 * SR), (i) => {
    const tt = i / SR;
    phase += (2 * Math.PI * (50 + 70 * Math.exp(-tt / 0.03))) / SR;
    return 0.8 * Math.exp(-tt / 0.08) * Math.sin(phase);
  });
}

export function snare(buf: Float32Array, t: number, r: () => number) {
  // noise through a 2-pole resonator at ~900Hz
  const w = (2 * Math.PI * 900) / SR, rad = 0.97;
  let y1 = 0, y2 = 0;
  add(buf, t, Math.round(0.15 * SR), (i) => {
    const x = r() * 2 - 1;
    const y = x + 2 * rad * Math.cos(w) * y1 - rad * rad * y2;
    y2 = y1; y1 = y;
    return 0.06 * Math.exp(-i / SR / 0.05) * y;
  });
}

export function hat(buf: Float32Array, t: number, r: () => number) {
  let prev = 0, prev2 = 0;
  add(buf, t, Math.round(0.04 * SR), (i) => {
    const x = r() * 2 - 1;
    const y = x - 2 * prev + prev2; // second difference = high-pass
    prev2 = prev; prev = x;
    return 0.12 * Math.exp(-i / SR / 0.012) * y;
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
