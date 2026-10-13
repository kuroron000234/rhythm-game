import { describe, it, expect } from 'vitest';
import { computeFeatures } from '../../src/analysis/spectrum.ts';
import { HOP } from '../../src/analysis/params.ts';
import { SR, sine } from './synth.ts';

const totalEnergy = (a: Float32Array) => a.reduce((s, v) => s + v, 0);
const dominantBand = (freq: number) => {
  const f = computeFeatures(sine(freq, 1), SR);
  const e = f.energy.map(totalEnergy);
  return e.indexOf(Math.max(...e));
};

describe('computeFeatures', () => {
  it('puts tones in the right band', () => {
    expect(dominantBand(60)).toBe(0);
    expect(dominantBand(1000)).toBe(1);
    expect(dominantBand(6000)).toBe(2);
  });

  it('produces one frame per hop', () => {
    const pcm = sine(440, 1);
    const f = computeFeatures(pcm, SR);
    expect(f.nFrames).toBe(Math.ceil(pcm.length / HOP));
    expect(f.frameRate).toBeCloseTo(SR / HOP);
    expect(f.flux[0].length).toBe(f.nFrames);
    expect(f.combinedFlux.length).toBe(f.nFrames);
    expect(f.rms.length).toBe(f.nFrames);
  });

  it('shows flux at a tone onset and none during the steady part', () => {
    const pcm = new Float32Array(SR);
    pcm.set(sine(1000, 0.5), SR / 2);
    const f = computeFeatures(pcm, SR);
    const onsetFrame = Math.round(SR / 2 / HOP);
    const peak = Math.max(...f.flux[1].slice(onsetFrame - 3, onsetFrame + 3));
    const steady = Math.max(...f.flux[1].slice(onsetFrame + 8, onsetFrame + 15));
    expect(peak).toBeGreaterThan(10 * (steady + 1e-6));
  });
});
