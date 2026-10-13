import type { Features } from './spectrum.ts';
import {
  BEAT_TIGHTNESS, BPM_FOLD, GRID_ALIGN_TOL, GRID_MIN_ALIGNMENT, BPM_SEARCH, DEFAULT_BPM, GRID_MAX_CV, GRID_MIN_PROMINENCE,
} from './params.ts';

export interface Slot {
  t: number;
  /** Position within the beat: 0 = on the beat, 2 = 8th, 1/3 = 16ths. */
  sub: 0 | 1 | 2 | 3;
  /** Index of the beat this slot belongs to. */
  beat: number;
}

export interface Grid {
  bpm: number;
  beats: number[];
  reliable: boolean;
  slots: Slot[];
}

function normalize(x: Float32Array): Float32Array {
  let mean = 0;
  for (const v of x) mean += v;
  mean /= x.length || 1;
  let sd = 0;
  for (const v of x) sd += (v - mean) ** 2;
  sd = Math.sqrt(sd / (x.length || 1));
  return sd > 1e-9 ? x.map((v) => v / sd) : new Float32Array(x.length);
}

/** Returns the period in frames and how much the ACF peak stands out. */
function estimatePeriod(env: Float32Array, frameRate: number): { period: number; prominence: number } {
  const lagMin = Math.floor((frameRate * 60) / BPM_SEARCH[1]);
  const lagMax = Math.min(env.length - 1, Math.ceil((frameRate * 60) / BPM_SEARCH[0]));
  if (lagMax <= lagMin + 2) return { period: (frameRate * 60) / DEFAULT_BPM, prominence: 0 };
  const acf = new Float64Array(lagMax + 2);
  let sum = 0;
  for (let L = lagMin; L <= lagMax + 1; L++) {
    let s = 0;
    for (let i = 0; i + L < env.length; i++) s += env[i] * env[i + L];
    acf[L] = s / (env.length - L);
    if (L <= lagMax) sum += acf[L];
  }
  const mean = sum / (lagMax - lagMin + 1);
  let best = -1, bestScore = -Infinity;
  for (let L = lagMin + 1; L < lagMax; L++) {
    if (acf[L] < acf[L - 1] || acf[L] < acf[L + 1]) continue;
    const bpm = (frameRate * 60) / L;
    // log-Gaussian prior centred on 120 BPM, one octave wide
    const w = Math.exp(-0.5 * Math.log2(bpm / DEFAULT_BPM) ** 2);
    if (acf[L] * w > bestScore) { bestScore = acf[L] * w; best = L; }
  }
  if (best < 0 || mean <= 0) return { period: (frameRate * 60) / DEFAULT_BPM, prominence: 0 };
  // parabolic interpolation for sub-frame accuracy
  const a = acf[best - 1], b = acf[best], c = acf[best + 1];
  const shift = a - 2 * b + c !== 0 ? (0.5 * (a - c)) / (a - 2 * b + c) : 0;
  let bpm = (frameRate * 60) / (best + shift);
  while (bpm < BPM_FOLD[0]) bpm *= 2;
  while (bpm > BPM_FOLD[1]) bpm /= 2;
  return { period: (frameRate * 60) / bpm, prominence: b / mean };
}

/** Ellis (2007) dynamic-programming beat tracker. Returns beat frame indices. */
function dpBeats(env: Float32Array, period: number): number[] {
  const n = env.length;
  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.round(period / 2), hi = Math.round(period * 2);
  for (let t = 0; t < n; t++) {
    let best = 0, arg = -1;
    for (let p = t - hi; p <= t - lo; p++) {
      if (p < 0) continue;
      const s = score[p] - BEAT_TIGHTNESS * Math.log((t - p) / period) ** 2;
      if (arg < 0 || s > best) { best = s; arg = p; }
    }
    score[t] = env[t] + (arg >= 0 ? best : 0);
    back[t] = arg;
  }
  let t = n - 1;
  for (let i = Math.max(0, n - Math.round(period)); i < n; i++) if (score[i] > score[t]) t = i;
  const beats: number[] = [];
  for (; t >= 0; t = back[t]) beats.push(t);
  return beats.reverse();
}

/** Fraction of strong envelope peaks lying within ±GRID_ALIGN_TOL of a 16th-note position of the beat grid. */
function gridAlignment(env: Float32Array, frameRate: number, beats: number[]): number {
  if (beats.length < 2) return 0;
  const pos: number[] = [];
  for (let i = 0; i + 1 < beats.length; i++) {
    const q = (beats[i + 1] - beats[i]) / 4;
    pos.push(beats[i], beats[i] + q, beats[i] + 2 * q, beats[i] + 3 * q);
  }
  pos.push(beats[beats.length - 1]);
  let peaks = 0, aligned = 0, k = 0;
  for (let i = 3; i < env.length - 3; i++) {
    if (env[i] < 1.5) continue;
    let isPeak = true;
    for (let j = i - 3; j <= i + 3; j++) if (env[j] > env[i]) isPeak = false;
    if (!isPeak) continue;
    const t = i / frameRate;
    while (k + 1 < pos.length && pos[k + 1] <= t) k++;
    const d = Math.min(Math.abs(t - pos[k]), k + 1 < pos.length ? Math.abs(pos[k + 1] - t) : Infinity);
    peaks++;
    if (d <= GRID_ALIGN_TOL) aligned++;
  }
  return peaks ? aligned / peaks : 0;
}

/** Local linear fit over ±4 beats removes the frame quantisation (~23ms) while still following drift. */
function smoothBeats(beats: number[]): number[] {
  const R = 4;
  return beats.map((_, i) => {
    const a = Math.max(0, i - R), b = Math.min(beats.length - 1, i + R);
    if (b - a < 2) return beats[i];
    let mx = 0, my = 0;
    for (let j = a; j <= b; j++) { mx += j; my += beats[j]; }
    mx /= b - a + 1; my /= b - a + 1;
    let num = 0, den = 0;
    for (let j = a; j <= b; j++) { num += (j - mx) * (beats[j] - my); den += (j - mx) ** 2; }
    return my + (num / den) * (i - mx);
  });
}

function median(a: number[]) {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[s.length >> 1] : 0;
}

export function trackBeats(f: Features, duration: number): Grid {
  const env = normalize(f.combinedFlux);
  const { period, prominence } = estimatePeriod(env, f.frameRate);
  let beats = smoothBeats(dpBeats(env, period).map((i) => i / f.frameRate));

  const intervals = beats.slice(1).map((b, i) => b - beats[i]);
  const med = median(intervals) || 60 / DEFAULT_BPM;
  const meanI = intervals.reduce((s, v) => s + v, 0) / (intervals.length || 1);
  const cv = intervals.length > 1
    ? Math.sqrt(intervals.reduce((s, v) => s + (v - meanI) ** 2, 0) / intervals.length) / meanI
    : Infinity;

  // least-squares slope of beat time vs index gives a precise average tempo
  let bpm = 60 / med;
  if (beats.length >= 8) {
    const n = beats.length, mx = (n - 1) / 2;
    const my = beats.reduce((s, v) => s + v, 0) / n;
    let num = 0, den = 0;
    beats.forEach((y, x) => { num += (x - mx) * (y - my); den += (x - mx) ** 2; });
    bpm = 60 / (num / den);
  }
  const alignment = gridAlignment(env, f.frameRate, beats);
  const reliable =
    beats.length >= 8 && prominence >= GRID_MIN_PROMINENCE && cv <= GRID_MAX_CV && alignment >= GRID_MIN_ALIGNMENT;

  // extend the beat list to cover [0, duration]
  if (beats.length === 0) beats = [0];
  const p0 = beats.length > 1 ? median(intervals.slice(0, 4)) : med;
  const p1 = beats.length > 1 ? median(intervals.slice(-4)) : med;
  while (beats[0] > 0) beats.unshift(beats[0] - p0);
  while (beats[beats.length - 1] <= duration) beats.push(beats[beats.length - 1] + p1);

  const slots: Slot[] = [];
  for (let i = 0; i + 1 < beats.length; i++) {
    const step = (beats[i + 1] - beats[i]) / 4;
    for (let s = 0; s < 4; s++) {
      const t = beats[i] + s * step;
      if (t >= 0 && t <= duration) slots.push({ t, sub: s as Slot['sub'], beat: i });
    }
  }
  return { bpm: Number.isFinite(bpm) ? bpm : DEFAULT_BPM, beats, reliable, slots };
}
