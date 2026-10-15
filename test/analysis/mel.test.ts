import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logMel, MEL } from '../../src/analysis/mel.ts';
import { SR, drumPattern, tone } from './synth.ts';

const hasNumpy = (() => {
  try { execFileSync('python3', ['-c', 'import numpy']); return true; } catch { return false; }
})();

describe('logMel', () => {
  const { pcm } = drumPattern(128, 4);
  tone(pcm, 1, 69, 2, 0.1);

  it('has one frame per hop (+1) and 64 bands, standardised', () => {
    const { data, frames } = logMel(pcm);
    expect(frames).toBe(1 + Math.floor(pcm.length / MEL.hop));
    expect(data.length).toBe(64 * frames);
    const mean = data.reduce((a, b) => a + b, 0) / data.length;
    expect(Math.abs(mean)).toBeLessThan(1e-3);
  });

  it.skipIf(!hasNumpy)('matches ml/features.py to within 1e-3', () => {
    expect(SR).toBe(MEL.sr);
    const dir = mkdtempSync(join(tmpdir(), 'mel-'));
    writeFileSync(join(dir, 'in.f32'), Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
    execFileSync('python3', ['ml/features.py', join(dir, 'in.f32'), join(dir, 'out.f32')]);
    const b = readFileSync(join(dir, 'out.f32'));
    const py = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
    const ts = logMel(pcm).data;
    expect(py.length).toBe(ts.length);
    let max = 0;
    for (let i = 0; i < ts.length; i++) max = Math.max(max, Math.abs(ts[i] - py[i]));
    expect(max).toBeLessThan(1e-3);
  });
});
