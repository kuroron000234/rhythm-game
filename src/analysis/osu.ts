import type { Chart, Difficulty, Lane, Note } from './chart.ts';
import { CHART_VERSION, CRITICAL_MIN_GAP_BEATS, CRITICAL_SHARE } from './params.ts';

export interface RawNote { t: number; lane: number; dur?: number }

/** Snap tolerance (s) and the beat fractions notes may snap to: 16ths plus triplets. */
const SNAP_TOL = 0.03;
const FRACTIONS = [0, 1 / 4, 1 / 3, 1 / 2, 2 / 3, 3 / 4];
/** Same-lane notes closer than this (after a previous note or hold end) are dropped. */
const MIN_LANE_GAP = 0.09;
const MIN_HOLD = 0.1;

/** Reads the hit objects of a 4-key osu!mania beatmap. */
export function parseOsuMania(text: string): RawNote[] {
  const keys = Number(/^\s*CircleSize\s*:\s*([\d.]+)/m.exec(text)?.[1]);
  if (keys !== 4) throw new Error(`4 キーの譜面ではありません (keys=${keys})`);
  const body = text.split(/^\[HitObjects\]\s*$/m)[1] ?? '';
  const out: RawNote[] = [];
  for (const line of body.split('\n')) {
    const f = line.trim().split(',');
    if (f.length < 5) continue;
    const lane = Math.min(3, Math.max(0, Math.floor((Number(f[0]) * 4) / 512)));
    const t = Number(f[2]) / 1000;
    const type = Number(f[3]);
    const n: RawNote = { t, lane };
    if (type & 128) {
      const end = Number(f[5]?.split(':')[0]) / 1000;
      if (end > t) n.dur = Math.round((end - t) * 1000) / 1000;
    }
    out.push(n);
  }
  return out.sort((a, b) => a.t - b.t || a.lane - b.lane);
}

/** Snapping positions (time + whether it is on the beat) from tracked beat times. */
function gridOf(beats: number[]) {
  const pos: { t: number; onBeat: boolean }[] = [];
  for (let i = 0; i + 1 < beats.length; i++) {
    const len = beats[i + 1] - beats[i];
    for (const f of FRACTIONS) pos.push({ t: beats[i] + f * len, onBeat: f === 0 });
  }
  return pos.sort((a, b) => a.t - b.t);
}

function nearest(grid: { t: number; onBeat: boolean }[], t: number) {
  let lo = 0, hi = grid.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (grid[m].t < t) lo = m + 1; else hi = m; }
  const cands = [grid[lo - 1], grid[lo]].filter(Boolean);
  return cands.sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0];
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Turns a MuG/osu!mania chart into a game chart on this song's beat grid. */
export function chartFromOsu(raw: RawNote[], beats: number[], difficulty: Difficulty, bpm: number): Chart {
  const grid = beats.length > 1 ? gridOf(beats) : [];
  const snap = (t: number) => {
    const g = grid.length ? nearest(grid, t) : undefined;
    return g && Math.abs(g.t - t) <= SNAP_TOL ? { t: g.t, onBeat: g.onBeat } : { t, onBeat: false };
  };
  const snapped = raw.map((n) => {
    const s = snap(n.t);
    const end = n.dur ? snap(n.t + n.dur).t : undefined;
    return { t: s.t, onBeat: s.onBeat, lane: n.lane as Lane, dur: end !== undefined && end - s.t >= MIN_HOLD ? end - s.t : undefined };
  }).sort((a, b) => a.t - b.t || a.lane - b.lane);

  const lastEnd = [-Infinity, -Infinity, -Infinity, -Infinity];
  const kept: (typeof snapped)[number][] = [];
  for (const n of snapped) {
    if (n.t - lastEnd[n.lane] < MIN_LANE_GAP) continue;
    lastEnd[n.lane] = n.t + (n.dur ?? 0);
    kept.push(n);
  }

  // critical: spaced-out on-beat chords (MuG has no notion of them)
  const beatLen = 60 / bpm;
  const chordTimes = [...new Set(kept.filter((n) => n.onBeat).map((n) => n.t))]
    .filter((t) => kept.filter((n) => n.t === t).length > 1);
  const maxCrit = Math.max(1, Math.floor(kept.length * CRITICAL_SHARE));
  const crit = new Set<number>();
  for (const t of chordTimes) {
    if (crit.size >= maxCrit) break;
    if ([...crit].every((c) => Math.abs(c - t) >= CRITICAL_MIN_GAP_BEATS * beatLen)) crit.add(t);
  }

  const notes: Note[] = kept.map((n) => ({
    t: r3(n.t), lane: n.lane, ...(n.dur ? { dur: r3(n.dur) } : {}), ...(crit.has(n.t) ? { critical: true } : {}),
  }));
  return { version: CHART_VERSION, bpm: Math.round(bpm * 10) / 10, gridReliable: beats.length > 1, difficulty, notes };
}
