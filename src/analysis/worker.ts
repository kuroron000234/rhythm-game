import { analyze } from './analyze.ts';

self.onmessage = (e: MessageEvent<{ pcm: Float32Array; sr: number; seed: string }>) => {
  try {
    const { pcm, sr, seed } = e.data;
    const analysis = analyze(pcm, sr, seed, (p, stage) => self.postMessage({ type: 'progress', p, stage }));
    (self as unknown as Worker).postMessage({ type: 'done', analysis }, [analysis.pulse.data.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err as Error)?.message ?? err) });
  }
};
