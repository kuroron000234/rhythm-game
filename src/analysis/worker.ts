import { analyze, analyzeWithStems } from './analyze.ts';
import { neuralCharts } from './neuralModel.ts';

type Job =
  | { mode: 'mix'; pcm: Float32Array; sr: number; seed: string }
  | { mode: 'ai'; vocals: Float32Array; accomp: Float32Array; sr: number; seed: string };

self.onmessage = async (e: MessageEvent<Job>) => {
  try {
    const j = e.data;
    const progress = (p: number, stage: string) => self.postMessage({ type: 'progress', p, stage });
    const analysis = j.mode === 'ai'
      ? analyzeWithStems(j.vocals, j.accomp, j.sr, j.seed, (p, s) => progress(p, s))
      : analyze(j.pcm, j.sr, j.seed, (p, s) => progress(p * 0.5, s));
    if (j.mode === 'mix') {
      // in-browser AI charts (distilled from MuG); the heuristic charts stay if the model is unavailable
      try {
        const n = await neuralCharts(j.pcm, analysis.beats, analysis.bpm, import.meta.env.BASE_URL, (p) => progress(0.5 + 0.5 * p, 'AI 譜面を生成'));
        analysis.charts = n.charts;
        analysis.source = 'neural';
      } catch (err) {
        console.warn('chart model unavailable, using heuristic charts', err);
      }
    }
    (self as unknown as Worker).postMessage({ type: 'done', analysis }, [analysis.pulse.data.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err as Error)?.message ?? err) });
  }
};
