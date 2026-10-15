import { fft } from './spectrum.ts';

/** Must match ml/features.py exactly — the in-browser chart model was trained on these features. */
export const MEL = { sr: 22050, nFft: 1024, hop: 256, nMels: 64, fmin: 30, fmax: 11025 } as const;

const hzToMel = (f: number) => 2595 * Math.log10(1 + f / 700);
const melToHz = (m: number) => 700 * (10 ** (m / 2595) - 1);

let filters: Float64Array[] | null = null;
function melFilters(): Float64Array[] {
  if (filters) return filters;
  const { nMels, nFft, sr, fmin, fmax } = MEL;
  const lo = hzToMel(fmin), hi = hzToMel(fmax);
  const pts = Array.from({ length: nMels + 2 }, (_, i) => melToHz(lo + ((hi - lo) * i) / (nMels + 1)));
  const nBins = nFft / 2 + 1;
  filters = Array.from({ length: nMels }, (_, m) => {
    const w = new Float64Array(nBins);
    for (let k = 0; k < nBins; k++) {
      const f = (k * sr) / nFft;
      w[k] = Math.max(0, Math.min((f - pts[m]) / (pts[m + 1] - pts[m]), (pts[m + 2] - f) / (pts[m + 2] - pts[m + 1])));
    }
    return w;
  });
  return filters;
}

/** Log-mel features, (nMels × frames) stored row-major as [mel][frame], standardised per song. */
export function logMel(pcm: Float32Array): { data: Float32Array; frames: number } {
  const { nFft, hop, nMels } = MEL;
  const frames = 1 + Math.floor(pcm.length / hop);
  const fb = melFilters();
  const nBins = nFft / 2 + 1;
  const out = new Float64Array(nMels * frames);
  const re = new Float64Array(nFft), im = new Float64Array(nFft), power = new Float64Array(nBins);
  const win = new Float64Array(nFft);
  for (let i = 0; i < nFft; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / nFft);
  for (let f = 0; f < frames; f++) {
    const start = f * hop - nFft / 2;
    for (let i = 0; i < nFft; i++) {
      const j = start + i;
      re[i] = (j >= 0 && j < pcm.length ? pcm[j] : 0) * win[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < nBins; k++) power[k] = re[k] * re[k] + im[k] * im[k];
    for (let m = 0; m < nMels; m++) {
      const w = fb[m];
      let s = 0;
      for (let k = 0; k < nBins; k++) if (w[k]) s += w[k] * power[k];
      out[m * frames + f] = Math.log(s + 1e-6);
    }
  }
  let mean = 0;
  for (const v of out) mean += v;
  mean /= out.length;
  let sd = 0;
  for (const v of out) sd += (v - mean) ** 2;
  sd = Math.sqrt(sd / out.length);
  const data = new Float32Array(out.length);
  for (let i = 0; i < out.length; i++) data[i] = (out[i] - mean) / (sd + 1e-5);
  return { data, frames };
}
