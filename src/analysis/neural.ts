import { MEL } from './mel.ts';
import type { RawNote } from './osu.ts';

// Must match ml/model.py / ml/train.py.
const FRAME = MEL.hop / MEL.sr;
const FEAT = 64;
const MIN_GAP = 0.09;
export const HOLD_MID = [0, 0.22, 0.45, 0.9, 1.8, 3.0];

/** LaneNet weights exported by ml/export.py (PyTorch GRUCell layout: gates r, z, n). */
export interface LaneWeights {
  hidden: number;
  input: number;
  w_ih: number[]; w_hh: number[]; b_ih: number[]; b_hh: number[];
  lanes_w: number[]; lanes_b: number[];
  holds_w: number[]; holds_b: number[];
}

export function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Argmax (temp 0) or a sample from softmax(logits/temp) over the allowed indices; −1 if none. */
function pick(logits: ArrayLike<number>, allowed: boolean[], temp: number, rnd: () => number): number {
  const idx: number[] = [];
  for (let i = 0; i < logits.length; i++) if (allowed[i]) idx.push(i);
  if (!idx.length) return -1;
  if (temp <= 0) return idx.reduce((b, i) => (logits[i] > logits[b] ? i : b), idx[0]);
  const m = Math.max(...idx.map((i) => logits[i]));
  const w = idx.map((i) => Math.exp((logits[i] - m) / temp));
  let r = rnd() * w.reduce((a, b) => a + b, 0);
  for (let k = 0; k < idx.length; k++) {
    r -= w[k];
    if (r <= 0) return idx[k];
  }
  return idx[idx.length - 1];
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

class LaneGRU {
  h: Float64Array;
  constructor(private w: LaneWeights) {
    this.h = new Float64Array(w.hidden);
  }

  step(x: Float64Array): { lanes: Float64Array; holds: Float64Array } {
    const { hidden: H, input: I, w_ih, w_hh, b_ih, b_hh } = this.w;
    const gi = new Float64Array(3 * H), gh = new Float64Array(3 * H);
    for (let r = 0; r < 3 * H; r++) {
      let s = b_ih[r];
      for (let c = 0; c < I; c++) s += w_ih[r * I + c] * x[c];
      gi[r] = s;
      let t = b_hh[r];
      for (let c = 0; c < H; c++) t += w_hh[r * H + c] * this.h[c];
      gh[r] = t;
    }
    const h = new Float64Array(H);
    for (let j = 0; j < H; j++) {
      const r = sigmoid(gi[j] + gh[j]);
      const z = sigmoid(gi[H + j] + gh[H + j]);
      const n = Math.tanh(gi[2 * H + j] + r * gh[2 * H + j]);
      h[j] = (1 - z) * n + z * this.h[j];
    }
    this.h = h;
    const lin = (W: number[], b: number[], out: number) => {
      const y = new Float64Array(out);
      for (let o = 0; o < out; o++) {
        let s = b[o];
        for (let c = 0; c < H; c++) s += W[o * H + c] * h[c];
        y[o] = s;
      }
      return y;
    };
    return { lanes: lin(this.w.lanes_w, this.w.lanes_b, 15), holds: lin(this.w.holds_w, this.w.holds_b, 4 * HOLD_MID.length) };
  }
}

const dtFeature = (dt: number) => Math.min(3, Math.log1p(Math.max(0, dt) / 0.1)) / 3;
const popcount = (m: number) => ((m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1));

/** Note-start frames: local maxima (±3) at or above thr, at least 4 frames apart. */
export function peaks(p: ArrayLike<number>, thr: number): number[] {
  const out: number[] = [];
  for (let f = 0; f < p.length;) {
    let ok = p[f] >= thr;
    if (ok) for (let j = Math.max(0, f - 3); j <= Math.min(p.length - 1, f + 3); j++) if (p[j] > p[f]) { ok = false; break; }
    if (ok) { out.push(f); f += 4; } else f++;
  }
  return out;
}

/**
 * Mirror of ml/train.py decode(). onsetProb: (T), chordLogits: (4×T), feat: (64×T), row-major.
 * Lanes and hold lengths are chosen note by note by LaneNet (sampled with a seeded PRNG when temp > 0).
 */
export function decodeChart(
  onsetProb: ArrayLike<number>, chordLogits: ArrayLike<number>, feat: ArrayLike<number>, T: number,
  weights: LaneWeights, thr: number, temp = 1, seed = 1, chordBias = 0,
): RawNote[] {
  const rnd = mulberry32(seed);
  const gru = new LaneGRU(weights);
  const notes: RawNote[] = [];
  let prev = 0, lastT = -10;
  const laneEnd = [-10, -10, -10, -10];
  const x = new Float64Array(weights.input);
  for (const f of peaks(onsetProb, thr)) {
    const t = f * FRAME;
    // chordBias (calibrated per difficulty) is subtracted from the multi-note sizes
    const size = pick([0, 1, 2, 3].map((k) => chordLogits[k * T + f] - (k ? chordBias : 0)), [true, true, true, true], temp, rnd) + 1;
    let held = 0;
    for (let l = 0; l < 4; l++) if (laneEnd[l] > t) held |= 1 << l;
    x.fill(0);
    for (let c = 0; c < FEAT; c++) x[c] = feat[c * T + f];
    x[FEAT + size - 1] = 1;
    x[FEAT + 4] = dtFeature(t - lastT);
    for (let l = 0; l < 4; l++) {
      x[FEAT + 5 + l] = (prev >> l) & 1;
      x[FEAT + 9 + l] = (held >> l) & 1;
    }
    const { lanes, holds } = gru.step(x);
    const ok = [0, 1, 2, 3].map((l) => t - laneEnd[l] >= MIN_GAP);
    let best = 0;
    for (let want = size; want >= 1 && !best; want--) {
      const allowed = Array.from({ length: 15 }, (_, i) => {
        const m = i + 1;
        return popcount(m) === want && [0, 1, 2, 3].every((l) => !((m >> l) & 1) || ok[l]);
      });
      const k = pick(lanes, allowed, temp, rnd);
      if (k >= 0) best = k + 1;
    }
    if (!best) continue;
    for (let l = 0; l < 4; l++) {
      if (!((best >> l) & 1)) continue;
      const b = pick(holds.subarray(l * HOLD_MID.length, (l + 1) * HOLD_MID.length), HOLD_MID.map(() => true), temp, rnd);
      const dur = HOLD_MID[b];
      notes.push(dur ? { t, lane: l, dur } : { t, lane: l });
      laneEnd[l] = t + dur;
    }
    prev = best;
    lastT = t;
  }
  return notes.sort((a, b) => a.t - b.t || a.lane - b.lane);
}
