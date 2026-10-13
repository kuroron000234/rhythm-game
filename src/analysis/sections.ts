import type { Features } from './spectrum.ts';
import type { Onset } from './onsets.ts';
import type { Grid } from './tempo.ts';
import { DENSITY_BASE, DENSITY_SPAN, SECTION_BEATS, SECTION_FREE_SECONDS, SECTION_WEIGHTS } from './params.ts';

export interface Section {
  start: number;
  end: number;
  /** 0..1 — how "big" this part of the song is relative to the rest of it. */
  strength: number;
}

export const densityFactor = (strength: number) => DENSITY_BASE + DENSITY_SPAN * strength;

export function sectionAt(sections: Section[], t: number): Section {
  let lo = 0, hi = sections.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (sections[mid].start <= t) lo = mid; else hi = mid - 1;
  }
  return sections[lo] ?? { start: 0, end: Infinity, strength: 0.5 };
}

/** Percentile rank of each value within the array, 0..1 (ties share the lower rank). */
function ranks(a: number[]): number[] {
  if (a.length < 2) return a.map(() => 0.5);
  const sorted = [...a].sort((x, y) => x - y);
  return a.map((v) => sorted.indexOf(v) / (a.length - 1));
}

function cosine(a: Float32Array, b: Float32Array) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? d / Math.sqrt(na * nb) : 0;
}

export function computeSections(f: Features, onsets: Onset[], grid: Grid, duration: number): Section[] {
  // boundaries: every SECTION_BEATS beats (4 bars), or fixed windows without a reliable grid
  const bounds: number[] = [];
  if (grid.reliable && grid.beats.length > 1) {
    for (let i = 0; i < grid.beats.length; i += SECTION_BEATS) bounds.push(grid.beats[i]);
    if (bounds[bounds.length - 1] < duration) bounds.push(grid.beats[grid.beats.length - 1] + 1e-3);
  } else {
    for (let t = 0; t < duration; t += SECTION_FREE_SECONDS) bounds.push(t);
    bounds.push(duration + 1e-3);
  }
  if (bounds.length < 2) return [{ start: 0, end: duration, strength: 0.5 }];
  bounds[0] = Math.min(bounds[0], 0);

  const frame = (t: number) => Math.max(0, Math.min(f.nFrames, Math.round(t * f.frameRate)));
  const barLen = 4; // bars per section (chroma compared bar by bar)
  const loud: number[] = [], dens: number[] = [];
  const bars: Float32Array[][] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const a = frame(bounds[i]), b = frame(bounds[i + 1]);
    let s = 0;
    for (let k = a; k < b; k++) s += f.rms[k];
    loud.push(b > a ? s / (b - a) : 0);
    const len = Math.max(1e-3, bounds[i + 1] - bounds[i]);
    dens.push(onsets.filter((o) => o.t >= bounds[i] && o.t < bounds[i + 1]).length / len);
    // per-bar mean chroma
    const vecs: Float32Array[] = [];
    for (let j = 0; j < barLen; j++) {
      const ba = a + Math.floor(((b - a) * j) / barLen), bb = a + Math.floor(((b - a) * (j + 1)) / barLen);
      const v = new Float32Array(12);
      for (let c = 0; c < 12; c++) for (let k = ba; k < bb; k++) v[c] += f.chroma[c][k];
      vecs.push(v);
    }
    bars.push(vecs);
  }
  // repetition: best bar-aligned chroma similarity with any other section
  const rep = bars.map((vi, i) => {
    let best = 0;
    bars.forEach((vj, j) => {
      if (Math.abs(i - j) < 1) return;
      const sim = vi.reduce((acc, v, k) => acc + cosine(v, vj[k]), 0) / vi.length;
      best = Math.max(best, sim);
    });
    return best;
  });

  const rl = ranks(loud), rd = ranks(dens), rr = ranks(rep);
  const W = SECTION_WEIGHTS;
  const combined = rl.map((l, i) => W.loud * l + W.density * rd[i] + W.repeat * rr[i] * l);
  const maxC = Math.max(...combined) || 1;
  const rc = ranks(combined);
  // mostly rank-based (guarantees contrast), partly absolute (keeps uniform songs from being over-stretched)
  const strength = combined.map((c, i) => Math.max(0, Math.min(1, 0.7 * rc[i] + 0.3 * (c / maxC))));
  // a silent section is never "big"
  const loudMax = Math.max(...loud) || 1;
  return strength.map((s, i) => ({
    start: bounds[i], end: bounds[i + 1], strength: loud[i] < 0.02 * loudMax ? 0 : s,
  }));
}
