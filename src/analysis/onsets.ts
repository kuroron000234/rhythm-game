import type { Features } from './spectrum.ts';
import {
  ONSET_DELTA, ONSET_LAG, ONSET_LAMBDA, ONSET_MIN_GAP, ONSET_PEAK_RADIUS, ONSET_SILENCE, ONSET_WINDOW,
} from './params.ts';

export interface Onset {
  t: number;
  /** 0..1, relative to the loud part of the same band. */
  strength: number;
  band: 0 | 1 | 2;
}

export function percentile(a: ArrayLike<number>, p: number): number {
  if (a.length === 0) return 0;
  const s = Float32Array.from(a).sort();
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
}

/** Sliding median over ±w samples (simple sort per window; fine for ~10^4 frames). */
export function movingMedian(x: Float32Array, w: number): Float32Array {
  const out = new Float32Array(x.length);
  const buf: number[] = [];
  for (let i = 0; i < x.length; i++) {
    buf.length = 0;
    for (let j = Math.max(0, i - w); j <= Math.min(x.length - 1, i + w); j++) buf.push(x[j]);
    buf.sort((a, b) => a - b);
    out[i] = buf[buf.length >> 1];
  }
  return out;
}

export function detectBand(x: Float32Array, frameRate: number, band: 0 | 1 | 2): Onset[] {
  const scale = percentile(x, 0.99);
  if (scale < ONSET_SILENCE) return [];
  const xn = x.map((v) => v / scale);
  const med = movingMedian(xn, Math.round(ONSET_WINDOW * frameRate));
  const out: Onset[] = [];
  let last = -Infinity;
  for (let i = 0; i < xn.length; i++) {
    const v = xn[i];
    if (v <= ONSET_DELTA + ONSET_LAMBDA * med[i]) continue;
    let isPeak = true;
    for (let j = Math.max(0, i - ONSET_PEAK_RADIUS); j <= Math.min(xn.length - 1, i + ONSET_PEAK_RADIUS); j++) {
      if (xn[j] > v || (xn[j] === v && j < i)) { isPeak = false; break; }
    }
    const t = i / frameRate + ONSET_LAG;
    if (!isPeak || t - last < ONSET_MIN_GAP) continue;
    out.push({ t, strength: Math.min(1, v), band });
    last = t;
  }
  return out;
}

export function detectOnsets(f: Features): Onset[] {
  return [0, 1, 2]
    .flatMap((b) => detectBand(f.flux[b], f.frameRate, b as 0 | 1 | 2))
    .sort((a, b) => a.t - b.t || a.band - b.band);
}
