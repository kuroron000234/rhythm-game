import { fft } from './spectrum.ts';
import { VOCAL } from './params.ts';

export interface VocalNote {
  t: number;
  dur: number;
  /** Median pitch as a (fractional) MIDI note number. */
  midi: number;
  /** 0..1 loudness relative to the loud parts of the vocal. */
  level: number;
}

interface PitchTrack { f0: Float32Array; conf: Float32Array; rms: Float32Array }

/** YIN pitch tracking; the autocorrelation is done with an FFT for speed. */
function trackPitch(x: Float32Array, sr: number): PitchTrack {
  const { win: W, hop: HOP } = VOCAL;
  const minLag = Math.floor(sr / VOCAL.maxHz), maxLag = Math.min(W - 1, Math.ceil(sr / VOCAL.minHz));
  const nF = Math.max(0, Math.floor((x.length - W) / HOP) + 1);
  const f0 = new Float32Array(nF), conf = new Float32Array(nF), rms = new Float32Array(nF);
  const N = 2 * W;
  const re = new Float64Array(N), im = new Float64Array(N), pre = new Float64Array(W + 1);
  for (let f = 0; f < nF; f++) {
    const s = f * HOP;
    re.fill(0); im.fill(0);
    for (let i = 0; i < W; i++) { re[i] = x[s + i]; pre[i + 1] = pre[i] + x[s + i] * x[s + i]; }
    rms[f] = Math.sqrt(pre[W] / W);
    if (pre[W] < 1e-10) continue;
    fft(re, im);
    for (let k = 0; k < N; k++) { re[k] = re[k] * re[k] + im[k] * im[k]; im[k] = 0; }
    fft(re, im); // power spectrum → (circular, but zero-padded so linear) autocorrelation × N
    // YIN difference d(t) = E[0, W−t) + E[t, W) − 2 r(t), then cumulative-mean normalisation
    const d = (t: number) => pre[W - t] + (pre[W] - pre[t]) - (2 * re[t]) / N;
    let run = 0;
    for (let t = 1; t <= maxLag; t++) {
      const dt = d(t);
      run += dt;
      const cmnd = run > 0 ? (dt * t) / run : 1;
      if (t < minLag || cmnd >= VOCAL.yinThreshold) continue;
      let best = t, bestV = cmnd, acc = run;
      while (best + 1 <= maxLag) {
        const dn = d(best + 1);
        const vn = (dn * (best + 1)) / (acc + dn);
        if (vn > bestV) break;
        acc += dn; best++; bestV = vn;
      }
      // parabolic refinement of the lag
      const a = d(best - 1), b = d(best), c = best + 1 <= maxLag ? d(best + 1) : b;
      const shift = a - 2 * b + c !== 0 ? (0.5 * (a - c)) / (a - 2 * b + c) : 0;
      f0[f] = sr / (best + Math.max(-0.5, Math.min(0.5, shift)));
      conf[f] = 1 - bestV;
      break;
    }
  }
  return { f0, conf, rms };
}

const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

export function extractVocalNotes(pcm: Float32Array, sr: number): VocalNote[] {
  const { hop: HOP, win: W } = VOCAL;
  const { f0, conf, rms } = trackPitch(pcm, sr);
  const nF = f0.length;
  if (nF < VOCAL.minFrames) return [];
  const ref = median(Array.from(rms).sort((a, b) => a - b).slice(Math.floor(nF * 0.95))) || 0;
  if (ref < 1e-4) return [];

  const raw = new Float32Array(nF).fill(NaN);
  for (let f = 0; f < nF; f++) {
    if (f0[f] > 0 && conf[f] >= VOCAL.minConfidence && rms[f] >= VOCAL.minLevel * ref) raw[f] = 69 + 12 * Math.log2(f0[f] / 440);
  }
  // 5-frame median over voiced neighbours removes single-frame octave glitches
  const midi = new Float32Array(nF).fill(NaN);
  for (let f = 0; f < nF; f++) {
    if (isNaN(raw[f])) continue;
    const w: number[] = [];
    for (let j = Math.max(0, f - 2); j <= Math.min(nF - 1, f + 2); j++) if (!isNaN(raw[j])) w.push(raw[j]);
    midi[f] = median(w);
  }

  const time = (frame: number) => (frame * HOP + W / 2) / sr;
  const notes: VocalNote[] = [];
  let cur: { start: number; vals: number[]; peak: number; sum: number; n: number } | null = null;
  let bridge = 0, dev = 0;
  const close = (end: number) => {
    if (cur && end - cur.start >= VOCAL.minFrames) {
      notes.push({
        t: time(cur.start), dur: ((end - cur.start) * HOP) / sr, midi: median(cur.vals),
        level: Math.min(1, cur.sum / cur.n / ref),
      });
    }
    cur = null;
    bridge = 0;
    dev = 0;
  };
  for (let f = 0; f < nF; f++) {
    const m = midi[f];
    const dip = cur !== null && rms[f] < VOCAL.dipRatio * cur.peak;
    if (isNaN(m) || dip) {
      if (cur && !dip && bridge < VOCAL.maxBridge) { bridge++; continue; }
      close(f - bridge);
      continue;
    }
    bridge = 0;
    if (!cur) { cur = { start: f, vals: [m], peak: rms[f], sum: rms[f], n: 1 }; continue; }
    const c = cur as NonNullable<typeof cur>;
    if (Math.abs(m - median(c.vals.slice(-24))) > VOCAL.splitSemitones) {
      if (++dev >= VOCAL.splitFrames) {
        const at = f - VOCAL.splitFrames + 1;
        close(at);
        cur = { start: at, vals: Array.from(midi.slice(at, f + 1)), peak: rms[f], sum: rms[f], n: 1 };
      }
      continue;
    }
    dev = 0;
    c.vals.push(m);
    c.peak = Math.max(c.peak, rms[f]);
    c.sum += rms[f];
    c.n++;
  }
  close(nF);
  return cleanUp(notes);
}

function cleanUp(notes: VocalNote[]): VocalNote[] {
  // octave/sub-harmonic glitches: short and far from both neighbours
  const kept = notes.filter((n, i) => {
    if (n.dur > VOCAL.glitchMaxDur) return true;
    const far = (o?: VocalNote) => !o || Math.abs(o.midi - n.midi) > VOCAL.glitchSemitones;
    return !(far(notes[i - 1]) && far(notes[i + 1]) && (notes[i - 1] || notes[i + 1]));
  });
  // glide fragments: absorb into the note they hang off
  const out: VocalNote[] = [];
  for (const n of kept) {
    const prev = out[out.length - 1];
    if (prev && n.dur < VOCAL.fragment && n.t - (prev.t + prev.dur) <= VOCAL.fragmentGap) {
      prev.dur = n.t + n.dur - prev.t;
      continue;
    }
    out.push({ ...n });
  }
  return out;
}
