import { describe, it, expect } from 'vitest';
import { extractVocalNotes } from '../../src/analysis/vocal.ts';
import { SR, silence, tone } from './synth.ts';

// [start, duration, midi, vibrato]
const MELODY: [number, number, number, number][] = [
  [0.5, 0.3, 64, 0], [0.8, 0.3, 67, 0], // legato pitch change, no gap
  [1.2, 0.25, 69, 0], [1.49, 0.25, 69, 0], // same pitch, 40ms gap → two notes
  [2.0, 1.6, 72, 0.35], // long note with vibrato → one note
  [3.8, 0.2, 60, 0], [4.05, 0.2, 62, 0], [4.3, 0.5, 57, 0],
];

function sing() {
  const pcm = silence(5.5);
  for (const [t, d, m, v] of MELODY) tone(pcm, t, m, d, 0.15, v);
  return pcm;
}

describe('extractVocalNotes', () => {
  const notes = extractVocalNotes(sing(), SR);

  it('finds every sung note with the right onset, length and pitch', () => {
    expect(notes.length).toBe(MELODY.length);
    MELODY.forEach(([t, d, m], i) => {
      const n = notes[i];
      expect(Math.abs(n.t - t)).toBeLessThanOrEqual(0.03);
      expect(Math.abs(n.dur - d)).toBeLessThanOrEqual(Math.max(0.15 * d, 0.04));
      expect(Math.abs(n.midi - m)).toBeLessThanOrEqual(0.5);
      expect(n.level).toBeGreaterThan(0);
      expect(n.level).toBeLessThanOrEqual(1);
    });
  });

  it('keeps a vibrato long tone as a single note', () => {
    const long = notes.filter((n) => n.dur > 1);
    expect(long.length).toBe(1);
    expect(Math.round(long[0].midi)).toBe(72);
  });

  it('starts a note at its consonant, not when the pitch settles', () => {
    const pcm = silence(2);
    let seed = 9;
    const r = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x3fffffff - 1);
    const s0 = Math.round(0.5 * SR);
    for (let i = 0; i < 0.05 * SR; i++) pcm[s0 + i] += 0.25 * r() * Math.min(1, i / 40); // "t" burst
    tone(pcm, 0.55, 65, 0.6, 0.15);
    const n = extractVocalNotes(pcm, SR);
    expect(n.length).toBe(1);
    expect(Math.abs(n[0].t - 0.5)).toBeLessThanOrEqual(0.02);
  });

  it('returns nothing for silence and noise-free short input', () => {
    expect(extractVocalNotes(silence(3), SR)).toEqual([]);
    expect(extractVocalNotes(new Float32Array(500), SR)).toEqual([]);
  });
});
