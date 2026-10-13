import { describe, it, expect } from 'vitest';
import { analyze } from '../../src/analysis/analyze.ts';
import type { Chart, Difficulty } from '../../src/analysis/chart.ts';
import { computeFeatures } from '../../src/analysis/spectrum.ts';
import { trackBeats } from '../../src/analysis/tempo.ts';
import { SR, drumPattern, hat, kick, rng, silence } from './synth.ts';

/** Drums at 120 BPM, a sustained mid tone every 4 bars, and a busier second half. */
function songLike() {
  const { pcm, beat, start } = drumPattern(120, 32);
  const r = rng(11);
  for (let bar = 0; bar < 32; bar += 4) {
    const t0 = start + bar * 4 * beat + beat; // starts on beat 2 of the bar
    const s = Math.round(t0 * SR);
    for (let i = 0; i < Math.round(2.5 * beat * SR); i++) {
      const env = Math.min(1, i / 200) * (i > 2.4 * beat * SR ? 0 : 1);
      pcm[s + i] += 0.25 * env * Math.sin((2 * Math.PI * 700 * i) / SR);
    }
  }
  for (let b = 64; b < 128; b++) {
    hat(pcm, start + b * beat + beat / 4, r);
    hat(pcm, start + b * beat + (3 * beat) / 4, r);
  }
  return pcm;
}

const DIFFS: Difficulty[] = ['easy', 'normal', 'hard'];
const pcm = songLike();
const duration = pcm.length / SR;
const result = analyze(pcm, SR, 'song-1');
const grid = trackBeats(computeFeatures(pcm, SR), duration);
const beat = 60 / result.bpm;
const hand = (lane: number) => (lane < 2 ? 0 : 1);

describe('analyze / generateChart', () => {
  it('is deterministic for the same input and seed', () => {
    const again = analyze(pcm, SR, 'song-1');
    expect(JSON.stringify(again.charts)).toBe(JSON.stringify(result.charts));
  });

  it('reports tempo and a reliable grid', () => {
    expect(Math.abs(result.bpm - 120)).toBeLessThanOrEqual(1);
    expect(result.gridReliable).toBe(true);
    expect(result.pulse.data.length).toBeGreaterThan(0);
  });

  it('orders difficulties by note count', () => {
    const n = (d: Difficulty) => result.charts[d].notes.length;
    expect(n('easy')).toBeGreaterThan(20);
    expect(n('easy')).toBeLessThan(n('normal'));
    expect(n('normal')).toBeLessThan(n('hard'));
  });

  for (const d of DIFFS) {
    const chart: Chart = result.charts[d];
    it(`${d}: notes are sorted, in range and on valid lanes`, () => {
      chart.notes.forEach((n, i) => {
        expect([0, 1, 2, 3]).toContain(n.lane);
        expect(n.t).toBeGreaterThanOrEqual(0);
        expect(n.t + (n.dur ?? 0)).toBeLessThanOrEqual(duration);
        if (i) expect(n.t).toBeGreaterThanOrEqual(chart.notes[i - 1].t);
      });
    });

    it(`${d}: no same-lane hits closer than an 8th note`, () => {
      for (const lane of [0, 1, 2, 3]) {
        const ns = chart.notes.filter((n) => n.lane === lane);
        for (let i = 1; i < ns.length; i++) {
          const prevEnd = ns[i - 1].t + (ns[i - 1].dur ?? 0);
          expect(ns[i].t - prevEnd).toBeGreaterThanOrEqual(beat / 2 - 0.004);
        }
      }
    });

    it(`${d}: nothing on the same hand while a hold is active`, () => {
      for (const h of chart.notes.filter((n) => n.dur)) {
        const clash = chart.notes.filter(
          (n) => n !== h && hand(n.lane) === hand(h.lane) && n.t >= h.t - 1e-6 && n.t <= h.t + h.dur! + 1e-6,
        );
        expect(clash).toEqual([]);
      }
    });

    it(`${d}: respects the density cap per 4-beat group`, () => {
      const cap = { easy: 3, normal: 6, hard: 10 }[d] * 4 * beat * 1.2;
      for (let g = 0; g < duration; g += 4 * beat) {
        const times = new Set(chart.notes.filter((n) => n.t >= g && n.t < g + 4 * beat).map((n) => n.t));
        expect(times.size).toBeLessThanOrEqual(Math.ceil(cap) + 1);
      }
    });

    it(`${d}: critical notes are rare`, () => {
      const c = chart.notes.filter((n) => n.critical).length;
      expect(c).toBeGreaterThan(0);
      expect(c).toBeLessThanOrEqual(Math.max(1, chart.notes.length * 0.05));
    });
  }

  it('easy has no chords and no holds', () => {
    const ts = result.charts.easy.notes.map((n) => n.t);
    expect(new Set(ts).size).toBe(ts.length);
    expect(result.charts.easy.notes.some((n) => n.dur)).toBe(false);
  });

  it('normal chords fall only on beats', () => {
    const notes = result.charts.normal.notes;
    const chordTimes = [...new Set(notes.map((n) => n.t))].filter((t) => notes.filter((n) => n.t === t).length > 1);
    expect(chordTimes.length).toBeGreaterThan(0);
    for (const t of chordTimes) expect(grid.beats.some((b) => Math.abs(b - t) < 0.002)).toBe(true);
  });

  it('turns sustained tones into holds on normal and hard', () => {
    expect(result.charts.normal.notes.some((n) => (n.dur ?? 0) >= 2 * beat - 0.01)).toBe(true);
    expect(result.charts.hard.notes.some((n) => n.dur)).toBe(true);
  });

  it('falls back to onset-based charts when the grid is unreliable', () => {
    const p = silence(30);
    const r = rng(3);
    for (let t = 0.5; t < 29; t += 0.25 + r() * 0.9) kick(p, t);
    const a = analyze(p, SR, 'rubato');
    expect(a.gridReliable).toBe(false);
    for (const d of DIFFS) expect(a.charts[d].notes.length).toBeGreaterThan(5);
  });

  it('copes with silence and very short input', () => {
    expect(analyze(silence(10), SR, 's').charts.hard.notes).toEqual([]);
    expect(() => analyze(drumPattern(120, 1).pcm.subarray(0, 3 * SR), SR, 'short')).not.toThrow();
    expect(() => analyze(new Float32Array(100), SR, 'tiny')).not.toThrow();
  });
});
