import { computeFeatures } from './spectrum.ts';
import { detectOnsets, percentile } from './onsets.ts';
import { trackBeats } from './tempo.ts';
import { generateChart, type Chart, type Difficulty } from './chart.ts';
import { CHART_VERSION } from './params.ts';

export interface Analysis {
  version: number;
  bpm: number;
  gridReliable: boolean;
  duration: number;
  charts: Record<Difficulty, Chart>;
  /** 0..1 low-band energy envelope for the background pulse. */
  pulse: { frameRate: number; data: Float32Array };
}

export type Progress = (fraction: number, stage: string) => void;

export function analyze(pcm: Float32Array, sr: number, seed: string, onProgress?: Progress): Analysis {
  const duration = pcm.length / sr;
  onProgress?.(0.05, 'スペクトル解析');
  const f = computeFeatures(pcm, sr);
  onProgress?.(0.5, 'オンセット検出');
  const onsets = detectOnsets(f);
  onProgress?.(0.65, 'テンポ推定');
  const grid = trackBeats(f, duration);
  onProgress?.(0.8, '譜面生成');
  const charts = {
    easy: generateChart(f, onsets, grid, 'easy', seed, duration),
    normal: generateChart(f, onsets, grid, 'normal', seed, duration),
    hard: generateChart(f, onsets, grid, 'hard', seed, duration),
  };

  const low = f.energy[0].map((e) => Math.log1p(e));
  const ref = percentile(low, 0.95) || 1;
  const data = new Float32Array(low.length);
  let v = 0;
  for (let i = 0; i < low.length; i++) {
    const x = Math.min(1, low[i] / ref);
    v = x > v ? x : v * 0.9; // fast attack, ~0.25s release
    data[i] = v;
  }
  onProgress?.(1, '完了');
  return { version: CHART_VERSION, bpm: charts.easy.bpm, gridReliable: grid.reliable, duration, charts, pulse: { frameRate: f.frameRate, data } };
}
