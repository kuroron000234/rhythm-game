/** A short, soft wooden tap: band-limited noise burst plus a quickly decaying body tone. */
export function makeHitSound(ctx: BaseAudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.round(sr * 0.06);
  const buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  let lp = 0, seed = 12345;
  for (let i = 0; i < len; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const noise = seed / 0x3fffffff - 1;
    lp += 0.35 * (noise - lp);
    const t = i / sr;
    d[i] = (0.5 * lp * Math.exp(-t / 0.006) + 0.5 * Math.sin(2 * Math.PI * 1150 * t) * Math.exp(-t / 0.018)) * 0.8;
  }
  return buf;
}

export function playHit(ctx: AudioContext, buf: AudioBuffer, volume: number, critical = false) {
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = critical ? 1.35 : 1;
  const g = ctx.createGain();
  g.gain.value = volume;
  src.connect(g).connect(ctx.destination);
  src.start();
}
