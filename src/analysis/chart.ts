import type { Features } from './spectrum.ts';
import type { Onset } from './onsets.ts';
import { percentile } from './onsets.ts';
import type { Grid } from './tempo.ts';
import { hashSeed, makeRng } from './rng.ts';
import { computeSections, densityFactor, sectionAt, type Section } from './sections.ts';
import {
  BEAT_HEAD_BONUS, CHART_VERSION, CRITICAL_MIN_GAP_BEATS, CRITICAL_SHARE, DIFFICULTY, HOLD_MAX_BEATS,
  HOLD_MAX_SHARE, HOLD_MIN_BEATS, HOLD_MIN_LOUDNESS, HOLD_REF_DELAY, HOLD_SUSTAIN_RATIO, SNAP_TOLERANCE,
  CHORD_STRONG, CHORD_STRONG_MULT, CHORD_WEAK, CRITICAL_MIN_STRENGTH,
} from './params.ts';

export type Difficulty = 'easy' | 'normal' | 'hard';
export type Lane = 0 | 1 | 2 | 3;

export interface Note {
  t: number;
  lane: Lane;
  /** Hold length in seconds (long notes only). */
  dur?: number;
  critical?: boolean;
}

export interface Chart {
  version: number;
  bpm: number;
  gridReliable: boolean;
  difficulty: Difficulty;
  notes: Note[];
}

interface Candidate {
  t: number;
  score: number;
  band: 0 | 1 | 2;
  /** Slot subdivision, or -1 when the grid is unreliable. */
  sub: number;
  beat: number;
  /** Local beat length in seconds. */
  beatLen: number;
  dur?: number;
  chord?: boolean;
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;
const hand = (lane: number) => (lane < 2 ? 0 : 1);

/** Merge onsets into one candidate per grid slot (or per 40ms cluster without a grid). */
function candidates(onsets: Onset[], grid: Grid, subs: number[]): Candidate[] {
  const out = new Map<number, Candidate & { bands: number[] }>();
  const add = (key: number, base: Omit<Candidate, 'score' | 'band'>, o: Onset) => {
    let c = out.get(key);
    if (!c) out.set(key, (c = { ...base, score: 0, band: o.band, bands: [0, 0, 0] }));
    c.bands[o.band] = Math.max(c.bands[o.band], o.strength);
  };
  if (grid.reliable) {
    const slots = grid.slots;
    let k = 0;
    for (const o of onsets) {
      while (k + 1 < slots.length && Math.abs(slots[k + 1].t - o.t) <= Math.abs(slots[k].t - o.t)) k++;
      const s = slots[k];
      if (!s) continue;
      const beatLen = (grid.beats[s.beat + 1] ?? s.t + 0.5) - grid.beats[s.beat];
      if (Math.abs(s.t - o.t) > SNAP_TOLERANCE * (beatLen / 4) || !subs.includes(s.sub)) continue;
      add(k, { t: s.t, sub: s.sub, beat: s.beat, beatLen }, o);
    }
  } else {
    const beatLen = 60 / grid.bpm;
    let key = -1, last = -Infinity;
    for (const o of onsets) {
      if (o.t - last > 0.04) { key++; last = o.t; }
      add(key, { t: last, sub: -1, beat: Math.floor(o.t / beatLen), beatLen }, o);
    }
  }
  return [...out.values()]
    .map(({ bands, ...c }) => {
      const max = Math.max(...bands);
      const sum = bands[0] + bands[1] + bands[2];
      return {
        ...c,
        band: bands.indexOf(max) as 0 | 1 | 2,
        score: 0.6 * max + 0.4 * Math.min(1, sum) + (c.sub >= 0 ? BEAT_HEAD_BONUS[c.sub] : 0),
      };
    })
    .sort((a, b) => a.t - b.t);
}

/** Keep the best-scoring candidates in each 4-beat group up to the density cap. */
function thin(cands: Candidate[], factors: number[], maxDensity: number, minScore: number, freeGap: number, reliable: boolean) {
  const groups = new Map<number, number[]>();
  cands.forEach((c, i) => {
    if (c.score < minScore) return;
    const g = Math.floor(c.t / (4 * c.beatLen));
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(i);
  });
  const keep: Candidate[] = [];
  for (const idx of groups.values()) {
    const c0 = cands[idx[0]];
    const cap = Math.max(1, Math.round(maxDensity * 4 * c0.beatLen * factors[idx[0]]));
    const chosen: Candidate[] = [];
    for (const i of [...idx].sort((a, b) => cands[b].score - cands[a].score)) {
      if (chosen.length >= cap) break;
      if (!reliable && chosen.some((c) => Math.abs(c.t - cands[i].t) < freeGap)) continue;
      chosen.push(cands[i]);
    }
    keep.push(...chosen);
  }
  return keep.sort((a, b) => a.t - b.t);
}

/** Mark candidates whose mid-band energy keeps ringing without a re-attack as holds. */
function markHolds(f: Features, keep: Candidate[], duration: number) {
  const mid = f.energy[1];
  const loud = percentile(mid, HOLD_MIN_LOUDNESS);
  const maxHolds = Math.floor(keep.length * HOLD_MAX_SHARE);
  const found: Candidate[] = [];
  for (const c of keep) {
    // measure after the attack transient so a drum hit on the same beat does not set the reference
    const i0 = Math.round((c.t + HOLD_REF_DELAY) * f.frameRate);
    if (i0 >= f.nFrames || mid[i0] <= loud) continue;
    let i = i0;
    while (i < f.nFrames && mid[i] >= HOLD_SUSTAIN_RATIO * mid[i0]) i++;
    const sustain = i / f.frameRate - c.t;
    if (sustain < HOLD_MIN_BEATS * c.beatLen) continue;
    const half = c.beatLen / 2;
    let dur = Math.min(HOLD_MAX_BEATS * c.beatLen, Math.floor(sustain / half) * half);
    dur = Math.min(dur, duration - c.t);
    if (dur >= HOLD_MIN_BEATS * c.beatLen - 1e-6) found.push(Object.assign(c, { dur }));
  }
  found.sort((a, b) => b.score - a.score).slice(maxHolds).forEach((c) => delete c.dur);
}

/** Chords go to the strongest hits, more of them in big sections and none in weak ones. */
function markChords(keep: Candidate[], mode: 'none' | 'strong' | 'any', share: number, sections: Section[]) {
  if (mode === 'none' || keep.length === 0) return;
  const scores = keep.map((c) => c.score);
  const cutNormal = percentile(scores, 1 - share);
  const cutStrong = percentile(scores, 1 - Math.min(0.9, share * CHORD_STRONG_MULT));
  for (const c of keep) {
    if (c.dur || !(mode === 'any' || c.sub === 0 || (c.sub === -1 && c.score > 0.8))) continue;
    const s = sectionAt(sections, c.t).strength;
    if (s < CHORD_WEAK) continue;
    if (c.score >= (s >= CHORD_STRONG ? cutStrong : cutNormal)) c.chord = true;
  }
}

class LanePicker {
  private lastEnd = [-Infinity, -Infinity, -Infinity, -Infinity];
  private holdEnd = [-Infinity, -Infinity];
  private history: number[] = [];

  constructor(private rand: () => number) {}

  cost(lane: number, c: Candidate, exclude = -1): number {
    if (lane === exclude) return Infinity;
    if (this.holdEnd[hand(lane)] >= c.t - 1e-6) return Infinity;
    const minGap = Math.max(c.beatLen / 2, 0.12) - 1e-3;
    if (c.t - this.lastEnd[lane] < minGap) return Infinity;
    const outer = lane === 0 || lane === 3;
    let cost = c.band === 0 ? (outer ? 0 : 0.8) : c.band === 2 ? (outer ? 0.8 : 0) : 0.3;
    const h = this.history;
    if (h.at(-1) === lane) cost += 0.6;
    if (h.at(-1) === lane && h.at(-2) === lane) cost += 2;
    if (h.at(-1) !== lane && h.at(-2) === lane && h.at(-3) === h.at(-1)) cost += 0.5;
    const recent = h.slice(-8);
    const same = recent.filter((l) => hand(l) === hand(lane)).length;
    cost += 0.15 * Math.max(0, same - (recent.length - same));
    if (exclude >= 0 && hand(exclude) === hand(lane)) cost += 0.5;
    return cost + this.rand() * 0.5;
  }

  pick(c: Candidate, exclude = -1): number {
    let best = -1, bestCost = Infinity;
    for (let lane = 0; lane < 4; lane++) {
      const k = this.cost(lane, c, exclude);
      if (k < bestCost) { bestCost = k; best = lane; }
    }
    return best;
  }

  commit(lane: number, t: number, dur = 0) {
    this.lastEnd[lane] = t + dur;
    if (dur) this.holdEnd[hand(lane)] = t + dur;
    this.history.push(lane);
  }

  otherHandHolding(lane: number, t: number) {
    return this.holdEnd[1 - hand(lane)] >= t;
  }
}

export function generateChart(
  f: Features, onsets: Onset[], grid: Grid, difficulty: Difficulty, seed: string, duration: number,
): Chart {
  const p = DIFFICULTY[difficulty];
  const cands = candidates(onsets, grid, p.subs).filter((c) => c.t >= 0 && c.t < duration);
  const sections = computeSections(f, onsets, grid, duration);
  const factors = cands.map((c) => densityFactor(sectionAt(sections, c.t).strength));
  const keep = thin(cands, factors, p.maxDensity, p.minScore, p.freeGap, grid.reliable);
  if (p.holds) markHolds(f, keep, duration);
  markChords(keep, p.chords, p.chordShare, sections);

  const picker = new LanePicker(makeRng(hashSeed(`${seed}:${difficulty}`)));
  const placed: (Note & { score: number; sub: number; beatLen: number })[] = [];
  for (const c of keep) {
    const lane = picker.pick(c);
    if (lane < 0) continue;
    let dur = c.dur;
    if (dur && picker.otherHandHolding(lane, c.t)) dur = undefined;
    // pick the chord partner before committing so the hold does not block its own chord
    const second = c.chord && !dur ? picker.pick(c, lane) : -1;
    picker.commit(lane, c.t, dur);
    placed.push({ t: round3(c.t), lane: lane as Lane, ...(dur ? { dur: round3(dur) } : {}), score: c.score, sub: c.sub, beatLen: c.beatLen });
    if (second >= 0) {
      picker.commit(second, c.t);
      placed.push({ t: round3(c.t), lane: second as Lane, score: 0, sub: c.sub, beatLen: c.beatLen });
    }
  }

  // critical notes: the strongest on-beat accents, spaced apart
  const nCrit = Math.max(placed.length ? 1 : 0, Math.floor(placed.length * CRITICAL_SHARE));
  let made = 0;
  const ranked = placed
    .filter((n) => (n.sub === 0 || n.sub === -1) && sectionAt(sections, n.t).strength >= CRITICAL_MIN_STRENGTH)
    .sort((a, b) => b.score - a.score || a.t - b.t);
  const critTimes: number[] = [];
  for (const n of ranked) {
    if (made >= nCrit) break;
    if (critTimes.some((t) => Math.abs(t - n.t) < CRITICAL_MIN_GAP_BEATS * n.beatLen)) continue;
    n.critical = true;
    critTimes.push(n.t);
    made++;
  }

  const notes: Note[] = placed
    .sort((a, b) => a.t - b.t || a.lane - b.lane)
    .map(({ t, lane, dur, critical }) => ({ t, lane, ...(dur ? { dur } : {}), ...(critical ? { critical } : {}) }));
  return { version: CHART_VERSION, bpm: Math.round(grid.bpm * 10) / 10, gridReliable: grid.reliable, difficulty, notes };
}
