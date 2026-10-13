import { BAND_EDGES, HOP, WIN } from './params.ts';

export interface Features {
  frameRate: number;
  nFrames: number;
  /** Positive log-spectral flux per band (low, mid, high). */
  flux: [Float32Array, Float32Array, Float32Array];
  combinedFlux: Float32Array;
  /** Linear energy per band. */
  energy: [Float32Array, Float32Array, Float32Array];
  rms: Float32Array;
}

/** In-place iterative radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/** Frames are centred on i * HOP (the signal is zero-padded by WIN/2 on both sides). */
export function computeFeatures(pcm: Float32Array, sr: number): Features {
  const nFrames = Math.max(1, Math.ceil(pcm.length / HOP));
  const nBins = WIN / 2 + 1;
  const binOf = (hz: number) => Math.min(nBins, Math.round((hz * WIN) / sr));
  const ranges: [number, number][] = [
    [1, binOf(BAND_EDGES[0])],
    [binOf(BAND_EDGES[0]), binOf(BAND_EDGES[1])],
    [binOf(BAND_EDGES[1]), nBins],
  ];
  const hann = new Float64Array(WIN);
  for (let i = 0; i < WIN; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WIN);

  const mk = () => new Float32Array(nFrames);
  const flux: Features['flux'] = [mk(), mk(), mk()];
  const energy: Features['energy'] = [mk(), mk(), mk()];
  const combinedFlux = mk();
  const rms = mk();
  const re = new Float64Array(WIN);
  const im = new Float64Array(WIN);
  let prev = new Float64Array(nBins);
  let cur = new Float64Array(nBins);

  for (let f = 0; f < nFrames; f++) {
    const start = f * HOP - WIN / 2;
    let sq = 0;
    for (let i = 0; i < WIN; i++) {
      const j = start + i;
      const x = j >= 0 && j < pcm.length ? pcm[j] : 0;
      sq += x * x;
      re[i] = x * hann[i];
      im[i] = 0;
    }
    rms[f] = Math.sqrt(sq / WIN);
    fft(re, im);
    for (let k = 0; k < nBins; k++) cur[k] = Math.hypot(re[k], im[k]);
    for (let b = 0; b < 3; b++) {
      let e = 0, fl = 0;
      for (let k = ranges[b][0]; k < ranges[b][1]; k++) {
        e += cur[k] * cur[k];
        const d = Math.log1p(cur[k]) - Math.log1p(prev[k]);
        if (d > 0) fl += d;
      }
      energy[b][f] = e / WIN;
      flux[b][f] = f === 0 ? 0 : fl;
    }
    combinedFlux[f] = flux[0][f] + flux[1][f] + flux[2][f];
    [prev, cur] = [cur, prev];
  }
  return { frameRate: sr / HOP, nFrames, flux, combinedFlux, energy, rms };
}
