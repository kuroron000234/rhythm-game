import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeNotes } from '../../src/analysis/neural.ts';

const hasNumpy = (() => { try { execFileSync('python3', ['-c', 'import numpy']); return true; } catch { return false; } })();

/** Deterministic smooth random probabilities with peaks and hold plateaus. */
function synth(T: number, seed: number) {
  let s = seed;
  const r = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const onset = new Float32Array(4 * T), hold = new Float32Array(4 * T);
  for (let lane = 0; lane < 4; lane++) {
    for (let f = 0; f < T; f++) onset[lane * T + f] = 0.05 * r();
    for (let k = 0; k < T / 40; k++) {
      const c = Math.floor(r() * T), amp = 0.3 + 0.7 * r();
      for (let d = -2; d <= 2; d++) if (c + d >= 0 && c + d < T) onset[lane * T + c + d] = Math.max(onset[lane * T + c + d], amp * (1 - Math.abs(d) * 0.3));
      if (r() < 0.3) for (let d = 1; d < 5 + r() * 60 && c + d < T; d++) hold[lane * T + c + d] = 0.6 + 0.3 * r();
    }
  }
  return { onset, hold };
}

describe('decodeNotes', () => {
  it('finds peaks above the threshold and turns plateaus into holds', () => {
    const T = 100;
    const onset = new Float32Array(4 * T), hold = new Float32Array(4 * T);
    onset[10] = 0.9; onset[11] = 0.5; // lane 0 note at frame 10
    onset[T + 50] = 0.3; // lane 1 below threshold
    onset[2 * T + 30] = 0.8;
    for (let f = 31; f < 60; f++) hold[2 * T + f] = 0.9; // ~0.34s hold
    const n = decodeNotes(onset, hold, T, 0.4);
    expect(n.length).toBe(2);
    expect(n[0]).toMatchObject({ lane: 0 });
    expect(n[0].dur).toBeUndefined();
    expect(n[1].lane).toBe(2);
    expect(n[1].dur).toBeGreaterThan(0.3);
  });

  it.skipIf(!hasNumpy)('matches ml/train.py decode() exactly', () => {
    const T = 3000;
    const { onset, hold } = synth(T, 42);
    const dir = mkdtempSync(join(tmpdir(), 'dec-'));
    writeFileSync(join(dir, 'o.f32'), Buffer.from(onset.buffer));
    writeFileSync(join(dir, 'h.f32'), Buffer.from(hold.buffer));
    const py = execFileSync('python3', ['-c', `
import sys, json, numpy as np
sys.path.insert(0, 'ml')
from train import decode
o = np.fromfile('${dir}/o.f32', dtype='<f4').reshape(4, ${T}); h = np.fromfile('${dir}/h.f32', dtype='<f4').reshape(4, ${T})
print(json.dumps([[t, l, e] for t, l, e in decode(o, h, 0.45)]))`]).toString();
    const ref = JSON.parse(py) as [number, number, number | null][];
    const ts = decodeNotes(onset, hold, T, 0.45);
    expect(ts.length).toBe(ref.length);
    ts.forEach((n, i) => {
      expect(n.lane).toBe(ref[i][1]);
      expect(n.t).toBeCloseTo(ref[i][0], 6);
      expect(n.dur === undefined).toBe(ref[i][2] === null);
    });
  });
});
