import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeChart, mulberry32, peaks, type LaneWeights } from '../../src/analysis/neural.ts';

const hasTorch = (() => { try { execFileSync('python3', ['-c', 'import torch, numpy']); return true; } catch { return false; } })();

describe('peaks / mulberry32', () => {
  it('finds spaced local maxima above the threshold', () => {
    const p = [0, 0.2, 0.9, 0.5, 0, 0, 0, 0, 0.6, 0.3, 0.1];
    expect(peaks(p, 0.4)).toEqual([2, 8]);
  });
  it('matches the reference mulberry32 sequence', () => {
    const r = mulberry32(42);
    expect([r(), r(), r()].map((x) => x.toFixed(6))).toEqual(['0.601104', '0.448291', '0.852466']);
  });
});

describe.skipIf(!hasTorch)('decodeChart vs ml/train.py decode()', () => {
  // random LaneNet + random frame outputs, decoded by Python; TS must produce the same chart
  const dir = mkdtempSync(join(tmpdir(), 'lane-'));
  execFileSync('python3', ['-c', `
import sys, json, numpy as np, torch
sys.path.insert(0, 'ml')
from model import LaneNet
from train import decode
torch.manual_seed(3)
lane = LaneNet(32).eval()
rng = np.random.default_rng(5)
T = 2500
onset = np.clip(rng.random(T) ** 6 * 1.5, 0, 1).astype(np.float32)
chord = rng.normal(size=(4, T)).astype(np.float32); chord[0] += 1.5
feat = np.tanh(rng.normal(size=(64, T))).astype(np.float32)
sd = {k: v.detach().numpy().astype(np.float64).ravel().tolist() for k, v in lane.state_dict().items()}
w = {"hidden": 32, "input": LaneNet.IN, "w_ih": sd["cell.weight_ih"], "w_hh": sd["cell.weight_hh"], "b_ih": sd["cell.bias_ih"],
     "b_hh": sd["cell.bias_hh"], "lanes_w": sd["lanes.weight"], "lanes_b": sd["lanes.bias"], "holds_w": sd["holds.weight"], "holds_b": sd["holds.bias"]}
out = {"T": T, "onset": onset.tolist(), "chord": chord.ravel().tolist(), "feat": feat.ravel().tolist(), "w": w}
for temp in (0, 1):
    out[f"ref{temp}"] = [[t, l, e] for t, l, e in decode(onset, chord, feat, lane, 0.5, temp=temp, seed=7, chord_bias=0.8)]
json.dump(out, open('${dir}/case.json', 'w'))
`]);
  const c = JSON.parse(readFileSync(join(dir, 'case.json'), 'utf8')) as {
    T: number; onset: number[]; chord: number[]; feat: number[]; w: LaneWeights; ref0: [number, number, number | null][]; ref1: [number, number, number | null][];
  };
  for (const temp of [0, 1] as const) {
    it(`gives the same notes and holds (temp ${temp})`, () => {
      const ref = temp ? c.ref1 : c.ref0;
      const ts = decodeChart(c.onset, c.chord, c.feat, c.T, c.w, 0.5, temp, 7, 0.8);
      expect(ref.length).toBeGreaterThan(30);
      expect(ts.length).toBe(ref.length);
      ts.forEach((n, i) => {
        expect(n.lane).toBe(ref[i][1]);
        expect(n.t).toBeCloseTo(ref[i][0], 6);
        if (ref[i][2] === null) expect(n.dur).toBeUndefined();
        else expect(n.t + n.dur!).toBeCloseTo(ref[i][2]!, 6);
      });
    });
  }
});
