import { describe, it, expect } from 'vitest';
import { computeFeatures } from '../../src/analysis/spectrum.ts';
import { trackBeats } from '../../src/analysis/tempo.ts';
import { SR, clickTrack, drumPattern, silence, kick, rng } from './synth.ts';

const grid = (pcm: Float32Array) => trackBeats(computeFeatures(pcm, SR), pcm.length / SR);

describe('trackBeats', () => {
  for (const bpm of [95, 128, 174]) {
    it(`estimates ${bpm} BPM within ±1 and lands on the beats`, () => {
      const { pcm, beats } = clickTrack(bpm, 30);
      const g = grid(pcm);
      expect(Math.abs(g.bpm - bpm)).toBeLessThanOrEqual(1);
      expect(g.reliable).toBe(true);
      const inner = beats.filter((b) => b > 2 && b < 28);
      const aligned = inner.filter((b) => g.beats.some((x) => Math.abs(x - b) < 0.03));
      expect(aligned.length / inner.length).toBeGreaterThanOrEqual(0.95);
    });
  }

  it('handles a drum pattern (kick/snare/hats) at 110 BPM', () => {
    const g = grid(drumPattern(110, 16).pcm);
    expect(Math.abs(g.bpm - 110)).toBeLessThanOrEqual(1);
  });

  it('follows a slowly drifting tempo', () => {
    const pcm = silence(40);
    const truth: number[] = [];
    for (let t = 0.5, bpm = 118; t < 39.5; t += 60 / bpm, bpm += 0.04) { kick(pcm, t); truth.push(t); }
    const g = grid(pcm);
    const inner = truth.filter((b) => b > 3 && b < 37);
    const aligned = inner.filter((b) => g.beats.some((x) => Math.abs(x - b) < 0.03));
    expect(aligned.length / inner.length).toBeGreaterThanOrEqual(0.9);
  });

  it('flags randomly timed hits as unreliable', () => {
    const pcm = silence(30);
    const r = rng(3);
    for (let t = 0.5; t < 29; t += 0.25 + r() * 0.9) kick(pcm, t);
    expect(grid(pcm).reliable).toBe(false);
  });

  it('builds 16th-note slots covering the song', () => {
    const { pcm } = clickTrack(120, 10);
    const g = grid(pcm);
    expect(g.slots[0].t).toBeLessThan(0.2);
    expect(g.slots.at(-1)!.t).toBeGreaterThan(9.7);
    for (let i = 1; i < g.slots.length; i++) {
      expect(g.slots[i].t).toBeGreaterThan(g.slots[i - 1].t);
      expect(g.slots[i].sub).toBe((g.slots[i - 1].sub + 1) % 4);
    }
    const mid = g.slots.findIndex((s) => s.t > 5);
    expect(g.slots[mid + 1].t - g.slots[mid].t).toBeCloseTo(0.125, 2);
  });

  it('does not throw on silence or very short input', () => {
    for (const pcm of [silence(10), silence(0.5)]) {
      const g = grid(pcm);
      expect(g.reliable).toBe(false);
      expect(Number.isFinite(g.bpm)).toBe(true);
    }
  });
});
