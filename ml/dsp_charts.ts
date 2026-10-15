// Dump the heuristic (non-AI) charts for given songs so ml/evaluate.py can compare them with MuG.
// npx tsx ml/dsp_charts.ts OUT.json AUDIO...
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { analyze } from '../src/analysis/analyze.ts';

const [out, ...files] = process.argv.slice(2);
const result: Record<string, Record<string, [number, number, number | null][]>> = {};
for (const f of files) {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-ac', '1', '-ar', '22050', '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  const pcm = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4).slice();
  const a = analyze(pcm, 22050, f);
  result[f] = Object.fromEntries(Object.entries(a.charts).map(([d, c]) => [d, c.notes.map((n) => [n.t, n.lane, n.dur ? n.t + n.dur : null])]));
}
writeFileSync(out, JSON.stringify(result));
