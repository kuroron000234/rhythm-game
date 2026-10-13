import { describe, it, expect } from 'vitest';
import { computeFeatures } from '../../src/analysis/spectrum.ts';
import { detectOnsets } from '../../src/analysis/onsets.ts';
import { SR, drumPattern, silence } from './synth.ts';

describe('detectOnsets', () => {
  for (const bpm of [100, 140]) {
    it(`finds ≥90% of drum hits within 30ms at ${bpm} BPM`, () => {
      const { pcm, truth } = drumPattern(bpm, 8);
      const onsets = detectOnsets(computeFeatures(pcm, SR));
      const hit = truth.filter((g) => onsets.some((o) => Math.abs(o.t - g.t) <= 0.03));
      expect(hit.length / truth.length).toBeGreaterThanOrEqual(0.9);
      const rightBand = truth.filter((g) => onsets.some((o) => o.band === g.band && Math.abs(o.t - g.t) <= 0.03));
      expect(rightBand.length / truth.length).toBeGreaterThanOrEqual(0.8);
      // not wildly over-detecting: at most 3 onsets per real event (one per band)
      expect(onsets.length).toBeLessThanOrEqual(truth.length * 3);
    });
  }

  it('returns sorted onsets with strength in 0..1', () => {
    const onsets = detectOnsets(computeFeatures(drumPattern(120, 4).pcm, SR));
    for (let i = 1; i < onsets.length; i++) expect(onsets[i].t).toBeGreaterThanOrEqual(onsets[i - 1].t);
    for (const o of onsets) {
      expect(o.strength).toBeGreaterThan(0);
      expect(o.strength).toBeLessThanOrEqual(1);
    }
  });

  it('returns nothing for silence', () => {
    expect(detectOnsets(computeFeatures(silence(3), SR))).toEqual([]);
  });
});
