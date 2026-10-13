import type { Note } from '../analysis/chart.ts';

export type Grade = 'perfect' | 'great' | 'good' | 'miss';
export type Rank = 'S' | 'A' | 'B' | 'C';

export const WINDOWS = { perfect: 0.04, great: 0.08, good: 0.12 } as const;
export const RATE: Record<Grade, number> = { perfect: 1, great: 0.7, good: 0.4, miss: 0 };
export const LIFE_DELTA: Record<Grade, number> = { perfect: 1, great: 0.5, good: 0, miss: -8 };
export const HOLD_RELEASE_WINDOW = 0.12;
export const MAX_SCORE = 1_000_000;

export interface JudgeEvent {
  lane: number;
  grade: Grade;
  /** Hit time minus note time (seconds); 0 for tails and misses. */
  delta: number;
  critical: boolean;
  tail?: boolean;
  noteIndex: number;
}

export interface JudgeState {
  score: number;
  combo: number;
  maxCombo: number;
  counts: Record<Grade, number>;
  life: number;
  failed: boolean;
  fullCombo: boolean;
  allPerfect: boolean;
}

interface Track {
  note: Note;
  index: number;
  weight: number;
  head?: Grade;
  tail?: Grade;
  holding: boolean;
}

export function rankOf(score: number): Rank {
  return score >= 950_000 ? 'S' : score >= 900_000 ? 'A' : score >= 800_000 ? 'B' : 'C';
}

export function gradeOf(delta: number): Grade | null {
  const d = Math.abs(delta) - 1e-9; // tolerate float error at the exact boundary
  return d <= WINDOWS.perfect ? 'perfect' : d <= WINDOWS.great ? 'great' : d <= WINDOWS.good ? 'good' : null;
}

export class Judge {
  private lanes: Track[][] = [[], [], [], []];
  private tracks: Track[];
  private pending: Track[];
  private totalWeight = 0;
  private earned = 0;
  private units = 0;
  private judgedUnits = 0;
  readonly state: JudgeState = {
    score: 0, combo: 0, maxCombo: 0, counts: { perfect: 0, great: 0, good: 0, miss: 0 },
    life: 100, failed: false, fullCombo: true, allPerfect: true,
  };

  constructor(notes: Note[]) {
    this.tracks = notes.map((note, index) => {
      const weight = note.critical ? 2 : 1;
      const parts = note.dur ? 2 : 1;
      this.totalWeight += weight * parts;
      this.units += parts;
      const tr: Track = { note, index, weight, holding: false };
      this.lanes[note.lane].push(tr);
      return tr;
    });
    for (const l of this.lanes) l.sort((a, b) => a.note.t - b.note.t);
    this.pending = [...this.tracks].sort((a, b) => a.note.t - b.note.t);
  }

  get finished() {
    return this.judgedUnits >= this.units;
  }

  private apply(tr: Track, grade: Grade, delta: number, tail = false): JudgeEvent {
    const s = this.state;
    s.counts[grade]++;
    this.judgedUnits++;
    this.earned += tr.weight * RATE[grade];
    s.score = Math.round((MAX_SCORE * this.earned) / (this.totalWeight || 1));
    if (grade === 'miss') {
      s.combo = 0;
      s.fullCombo = false;
    } else {
      s.combo++;
      s.maxCombo = Math.max(s.maxCombo, s.combo);
    }
    if (grade !== 'perfect') s.allPerfect = false;
    s.life = Math.max(0, Math.min(100, s.life + LIFE_DELTA[grade]));
    if (s.life <= 0) s.failed = true;
    if (tail) tr.tail = grade;
    else tr.head = grade;
    return { lane: tr.note.lane, grade, delta, critical: !!tr.note.critical, noteIndex: tr.index, ...(tail ? { tail } : {}) };
  }

  press(lane: number, t: number): JudgeEvent | null {
    for (const tr of this.lanes[lane] ?? []) {
      if (tr.head) continue;
      if (tr.note.t > t + WINDOWS.good) break;
      const grade = gradeOf(t - tr.note.t);
      if (!grade) continue;
      if (tr.note.dur) tr.holding = true;
      return this.apply(tr, grade, t - tr.note.t);
    }
    return null;
  }

  release(lane: number, t: number): JudgeEvent | null {
    const tr = this.lanes[lane]?.find((x) => x.holding);
    if (!tr) return null;
    tr.holding = false;
    const end = tr.note.t + tr.note.dur!;
    return this.apply(tr, t >= end - HOLD_RELEASE_WINDOW ? 'perfect' : 'miss', 0, true);
  }

  /** Advance time: miss passed notes and auto-complete holds that reached their end. */
  update(t: number): JudgeEvent[] {
    const out: JudgeEvent[] = [];
    const p = this.pending;
    let keep = 0;
    let i = 0;
    for (; i < p.length; i++) {
      const tr = p[i];
      // pending is time-ordered: once a head is still in the future, so is everything after it
      if (!tr.head && tr.note.t + WINDOWS.good >= t) break;
      if (!tr.head) {
        out.push(this.apply(tr, 'miss', 0));
        if (tr.note.dur) out.push(this.apply(tr, 'miss', 0, true));
      } else if (tr.holding && t >= tr.note.t + tr.note.dur!) {
        tr.holding = false;
        out.push(this.apply(tr, 'perfect', 0, true));
      }
      if (!(tr.head && (!tr.note.dur || tr.tail))) p[keep++] = tr;
    }
    for (; i < p.length; i++) p[keep++] = p[i];
    p.length = keep;
    return out;
  }

  /** Index of the hold currently held in a lane, if any (for rendering). */
  holdingIn(lane: number): number {
    return this.lanes[lane]?.find((x) => x.holding)?.index ?? -1;
  }

  judged(index: number): { head?: Grade; tail?: Grade } {
    const tr = this.tracks[index];
    return { head: tr?.head, tail: tr?.tail };
  }
}
