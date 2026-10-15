import { MEL } from './mel.ts';
import type { RawNote } from './osu.ts';

const FRAME = MEL.hop / MEL.sr;
/** Minimum hold length (s) for a predicted long note; must match ml/train.py decode(). */
const MIN_HOLD = 0.15;

/**
 * Mirror of ml/train.py decode(): per lane, a note starts at a local maximum (±3 frames) of the
 * note-start probability at or above `thr`; it becomes a hold while the hold probability stays ≥ 0.5.
 * `onset` and `hold` are [lane][frame] row-major (4 × T).
 */
export function decodeNotes(onset: Float32Array, hold: Float32Array, T: number, thr: number): RawNote[] {
  const notes: RawNote[] = [];
  for (let lane = 0; lane < 4; lane++) {
    const p = onset.subarray(lane * T, (lane + 1) * T);
    const h = hold.subarray(lane * T, (lane + 1) * T);
    let f = 0;
    while (f < T) {
      let isMax = p[f] >= thr;
      if (isMax) {
        let m = -Infinity;
        for (let j = Math.max(0, f - 3); j <= Math.min(T - 1, f + 3); j++) m = Math.max(m, p[j]);
        isMax = p[f] === m;
      }
      if (!isMax) { f++; continue; }
      let g = f + 1;
      while (g < T && h[g] >= 0.5) g++;
      const n: RawNote = { t: f * FRAME, lane };
      if ((g - 1 - f) * FRAME >= MIN_HOLD) n.dur = (g - 1 - f) * FRAME;
      notes.push(n);
      f += 4;
    }
  }
  return notes.sort((a, b) => a.t - b.t || a.lane - b.lane);
}
