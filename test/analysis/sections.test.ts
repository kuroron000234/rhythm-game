import { describe, it, expect } from 'vitest';
import { computeFeatures } from '../../src/analysis/spectrum.ts';
import { detectOnsets } from '../../src/analysis/onsets.ts';
import { trackBeats } from '../../src/analysis/tempo.ts';
import { computeSections, sectionAt } from '../../src/analysis/sections.ts';
import { analyze } from '../../src/analysis/analyze.ts';
import { SR, verseChorusSong, silence } from './synth.ts';

const song = verseChorusSong();
const duration = song.pcm.length / SR;
const f = computeFeatures(song.pcm, SR);
const onsets = detectOnsets(f);
const grid = trackBeats(f, duration);
const sections = computeSections(f, onsets, grid, duration);
const barOf = (t: number) => Math.floor((t - song.start) / (4 * song.beat));
const isChorus = (t: number) => song.chorusBars(barOf(t));

describe('computeSections', () => {
  it('covers the song with strengths in 0..1', () => {
    expect(sections.length).toBeGreaterThan(4);
    expect(sections[0].start).toBeLessThanOrEqual(0);
    expect(sections.at(-1)!.end).toBeGreaterThanOrEqual(duration);
    for (const s of sections) {
      expect(s.strength).toBeGreaterThanOrEqual(0);
      expect(s.strength).toBeLessThanOrEqual(1);
    }
  });

  it('rates chorus sections well above verse sections', () => {
    const mid = (s: { start: number; end: number }) => (s.start + s.end) / 2;
    const inner = sections.filter((s) => mid(s) > song.start && mid(s) < duration - 1);
    const ch = inner.filter((s) => isChorus(mid(s))).map((s) => s.strength);
    const vs = inner.filter((s) => !isChorus(mid(s))).map((s) => s.strength);
    const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    expect(avg(ch) - avg(vs)).toBeGreaterThan(0.3);
  });

  it('handles silence without throwing', () => {
    const p = silence(5);
    const g = computeFeatures(p, SR);
    expect(() => computeSections(g, [], trackBeats(g, 5), 5)).not.toThrow();
  });
});

describe('section-aware charts', () => {
  const a = analyze(song.pcm, SR, 'vc');
  const rate = (notes: { t: number }[], chorus: boolean) => {
    const bars = Array.from({ length: song.bars }, (_, b) => b).filter((b) => song.chorusBars(b) === chorus);
    return notes.filter((n) => n.t >= song.start && bars.includes(barOf(n.t))).length / (bars.length * 4 * song.beat);
  };

  it('puts at least 1.5x more notes in the chorus than the verse (HARD and NORMAL)', () => {
    for (const d of ['normal', 'hard'] as const) {
      const notes = a.charts[d].notes;
      expect(rate(notes, true) / rate(notes, false)).toBeGreaterThanOrEqual(1.5);
    }
  });

  it('places no chords in weak sections and criticals only in strong ones', () => {
    for (const d of ['normal', 'hard'] as const) {
      const notes = a.charts[d].notes;
      for (const n of notes) {
        const s = sectionAt(sections, n.t).strength;
        if (notes.filter((m) => m.t === n.t).length > 1) expect(s).toBeGreaterThanOrEqual(0.3);
        if (n.critical) expect(s).toBeGreaterThanOrEqual(0.6);
      }
    }
  });
});
