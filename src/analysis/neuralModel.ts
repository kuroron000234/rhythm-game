// Browser-only: runs the distilled chart model (ml/) with onnxruntime-web.
import * as ort from 'onnxruntime-web/wasm';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import type { Chart, Difficulty } from './chart.ts';
import { logMel } from './mel.ts';
import { decodeChart, type LaneWeights } from './neural.ts';
import { chartFromOsu } from './osu.ts';

export interface ModelMeta {
  version: string;
  /** Note-start thresholds calibrated so event counts match the teacher (MuG) per difficulty. */
  thresholds: Record<Difficulty, number>;
  /** Sampling temperature for lanes / chord sizes / hold lengths (MuG itself is a sampler). */
  temperature: number;
  lane: LaneWeights;
}

const DIFFS: Difficulty[] = ['easy', 'normal', 'hard'];
let loaded: Promise<{ session: ort.InferenceSession; meta: ModelMeta }> | null = null;

function load(base: string) {
  return (loaded ??= (async () => {
    ort.env.wasm.wasmPaths = { wasm: wasmUrl };
    ort.env.wasm.numThreads = 1; // GitHub Pages is not cross-origin isolated (no SharedArrayBuffer)
    const meta: ModelMeta = await (await fetch(`${base}model/chartnet.json`)).json();
    const session = await ort.InferenceSession.create(`${base}model/chartnet.onnx`, { executionProviders: ['wasm'] });
    return { session, meta };
  })().catch((e) => { loaded = null; throw e; }));
}

/** pcm: mono 22050Hz. Returns the three charts snapped to the song's beat grid. */
export async function neuralCharts(
  pcm: Float32Array, beats: number[], bpm: number, base: string, seed: number, onProgress?: (p: number) => void,
): Promise<{ charts: Record<Difficulty, Chart>; version: string }> {
  const { session, meta } = await load(base);
  const { data, frames: T } = logMel(pcm);
  onProgress?.(0.2);
  const mel = new ort.Tensor('float32', data, [1, 64, T]);
  const charts = {} as Record<Difficulty, Chart>;
  for (const [i, d] of DIFFS.entries()) {
    const out = await session.run({ mel, diff: new ort.Tensor('int64', BigInt64Array.from([BigInt(i)]), [1]) });
    const raw = decodeChart(out.onset.data as Float32Array, out.chord.data as Float32Array, out.feat.data as Float32Array, T,
      meta.lane, meta.thresholds[d], meta.temperature, seed + i);
    charts[d] = chartFromOsu(raw, beats, d, bpm);
    onProgress?.(0.2 + (0.8 * (i + 1)) / 3);
  }
  return { charts, version: meta.version };
}
