import { describe, it, expect } from 'vitest';
import { analyzeWithStems } from '../../src/analysis/analyze.ts';
import type { Difficulty } from '../../src/analysis/chart.ts';
import { SR, drumPattern, silence, tone } from './synth.ts';

// two-bar phrase at 120 BPM: [offset in beats, length in beats]; three notes are ≥1 beat
const PHRASE: [number, number][] = [[0, 0.4], [0.5, 0.4], [1, 0.4], [1.5, 0.9], [2.5, 0.4], [3, 2.5], [6, 0.4], [6.5, 1.3]];
const PITCHES = [64, 67, 69, 67, 64, 72, 71, 69];

function stems() {
  const { pcm: accomp, beat, start } = drumPattern(120, 16);
  const vocals = silence(accomp.length / SR);
  const truth: { t: number; dur: number }[] = [];
  for (let bar = 0; bar < 16; bar += 2) {
    PHRASE.forEach(([o, l], i) => {
      const t = start + (bar * 4 + o) * beat, dur = l * beat;
      tone(vocals, t, PITCHES[i], dur - 0.02, 0.15, l > 1 ? 0.3 : 0);
      truth.push({ t, dur });
    });
  }
  return { vocals, accomp, truth, beat };
}

const { vocals, accomp, truth, beat } = stems();
const a = analyzeWithStems(vocals, accomp, SR, 'ai-song');
const hand = (l: number) => (l < 2 ? 0 : 1);

describe('analyzeWithStems', () => {
  it('marks the analysis as AI and finds the tempo from the accompaniment', () => {
    expect(a.source).toBe('ai');
    expect(Math.abs(a.bpm - 120)).toBeLessThanOrEqual(1);
  });

  it('puts a note on ≥70% of sung notes (HARD)', () => {
    const notes = a.charts.hard.notes;
    const hit = truth.filter((v) => notes.some((n) => Math.abs(n.t - v.t) <= 0.04));
    expect(hit.length / truth.length).toBeGreaterThanOrEqual(0.7);
  });

  it('turns ≥50% of sung notes lasting a beat or more into holds (NORMAL and HARD)', () => {
    const long = truth.filter((v) => v.dur >= beat);
    for (const d of ['normal', 'hard'] as Difficulty[]) {
      const holds = a.charts[d].notes.filter((n) => n.dur);
      const ok = long.filter((v) => holds.some((h) => Math.abs(h.t - v.t) <= 0.04 && h.dur! >= beat - 0.01));
      expect(ok.length / long.length).toBeGreaterThanOrEqual(0.5);
    }
  });

  it('keeps hold lengths on half-beat steps, at most 4 beats, and within the sung length', () => {
    for (const n of a.charts.hard.notes.filter((x) => x.dur)) {
      const halves = n.dur! / (beat / 2);
      expect(Math.abs(halves - Math.round(halves))).toBeLessThan(0.05);
      expect(n.dur!).toBeLessThanOrEqual(4 * beat + 1e-3);
    }
  });

  it('still follows the existing lane rules', () => {
    for (const d of ['easy', 'normal', 'hard'] as Difficulty[]) {
      const notes = a.charts[d].notes;
      for (const lane of [0, 1, 2, 3]) {
        const ns = notes.filter((n) => n.lane === lane);
        for (let i = 1; i < ns.length; i++) expect(ns[i].t - (ns[i - 1].t + (ns[i - 1].dur ?? 0))).toBeGreaterThanOrEqual(beat / 2 - 0.004);
      }
      for (const h of notes.filter((n) => n.dur)) {
        expect(notes.filter((n) => n !== h && hand(n.lane) === hand(h.lane) && n.t >= h.t - 1e-6 && n.t <= h.t + h.dur! + 1e-6)).toEqual([]);
      }
    }
  });

  it('is deterministic', () => {
    expect(JSON.stringify(analyzeWithStems(vocals, accomp, SR, 'ai-song').charts)).toBe(JSON.stringify(a.charts));
  });

  it('still produces charts for instrumentals (silent vocal stem)', () => {
    const inst = analyzeWithStems(silence(accomp.length / SR), accomp, SR, 'inst');
    for (const d of ['easy', 'normal', 'hard'] as Difficulty[]) expect(inst.charts[d].notes.length).toBeGreaterThan(20);
  });
});
