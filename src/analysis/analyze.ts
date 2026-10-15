import { computeFeatures } from './spectrum.ts';
import { detectOnsets, percentile } from './onsets.ts';
import { trackBeats } from './tempo.ts';
import { generateChart, type Chart, type Difficulty } from './chart.ts';
import { CHART_VERSION } from './params.ts';
import { extractVocalNotes, type VocalNote } from './vocal.ts';
import type { Features } from './spectrum.ts';

export interface Analysis {
  version: number;
  /** 'dsp' heuristics, 'neural' in-browser model distilled from MuG, 'ai' vocal stems, 'mug' MuG Diffusion. */
  source: 'dsp' | 'neural' | 'ai' | 'mug';
  /** Tracked beat times (s), used to snap externally generated charts. */
  beats: number[];
  bpm: number;
  gridReliable: boolean;
  duration: number;
  charts: Record<Difficulty, Chart>;
  /** 0..1 low-band energy envelope for the background pulse. */
  pulse: { frameRate: number; data: Float32Array };
}

export type Progress = (fraction: number, stage: string) => void;

function pulseOf(f: Features) {
  const low = f.energy[0].map((e) => Math.log1p(e));
  const ref = percentile(low, 0.95) || 1;
  const data = new Float32Array(low.length);
  let v = 0;
  for (let i = 0; i < low.length; i++) {
    const x = Math.min(1, low[i] / ref);
    v = x > v ? x : v * 0.9; // fast attack, ~0.25s release
    data[i] = v;
  }
  return { frameRate: f.frameRate, data };
}

function build(pcm: Float32Array, sr: number, seed: string, source: Analysis['source'], onProgress?: Progress, vocals?: () => VocalNote[]): Analysis {
  const duration = pcm.length / sr;
  onProgress?.(0.05, 'スペクトル解析');
  const f = computeFeatures(pcm, sr);
  onProgress?.(0.4, 'オンセット検出');
  const onsets = detectOnsets(f);
  onProgress?.(0.5, 'テンポ推定');
  const grid = trackBeats(f, duration);
  let sung: VocalNote[] | undefined;
  if (vocals) {
    onProgress?.(0.6, 'ボーカル音符の抽出');
    sung = vocals();
  }
  onProgress?.(0.85, '譜面生成');
  const charts = {
    easy: generateChart(f, onsets, grid, 'easy', seed, duration, sung),
    normal: generateChart(f, onsets, grid, 'normal', seed, duration, sung),
    hard: generateChart(f, onsets, grid, 'hard', seed, duration, sung),
  };
  onProgress?.(1, '完了');
  return { version: CHART_VERSION, source, bpm: charts.easy.bpm, beats: grid.beats, gridReliable: grid.reliable, duration, charts, pulse: pulseOf(f) };
}

export function analyze(pcm: Float32Array, sr: number, seed: string, onProgress?: Progress): Analysis {
  return build(pcm, sr, seed, 'dsp', onProgress);
}

/** Vocal-driven charts: rhythm/sections from the accompaniment stem, notes and holds from the vocal stem. */
export function analyzeWithStems(vocals: Float32Array, accomp: Float32Array, sr: number, seed: string, onProgress?: Progress): Analysis {
  return build(accomp, sr, seed, 'ai', onProgress, () => extractVocalNotes(vocals, sr));
}
