import { analyze, analyzeWithStems } from './analyze.ts';

type Job =
  | { mode: 'mix'; pcm: Float32Array; sr: number; seed: string }
  | { mode: 'ai'; vocals: Float32Array; accomp: Float32Array; sr: number; seed: string };

self.onmessage = (e: MessageEvent<Job>) => {
  try {
    const j = e.data;
    const progress = (p: number, stage: string) => self.postMessage({ type: 'progress', p, stage });
    const analysis = j.mode === 'ai'
      ? analyzeWithStems(j.vocals, j.accomp, j.sr, j.seed, progress)
      : analyze(j.pcm, j.sr, j.seed, progress);
    (self as unknown as Worker).postMessage({ type: 'done', analysis }, [analysis.pulse.data.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err as Error)?.message ?? err) });
  }
};
