/**
 * Synthesised hit sounds in the spirit of Project SEKAI's: a short bright tap, a sparkling critical,
 * and a soft loop while a hold is down. (No game assets are bundled; players can load their own files.)
 */
export interface HitSounds {
  tap: AudioBuffer;
  critical: AudioBuffer;
  hold: AudioBuffer;
}

function render(ctx: BaseAudioContext, seconds: number, f: (t: number, noise: number) => number): AudioBuffer {
  const sr = ctx.sampleRate;
  const buf = ctx.createBuffer(1, Math.round(sr * seconds), sr);
  const d = buf.getChannelData(0);
  let seed = 0x2545f491;
  for (let i = 0; i < d.length; i++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    d[i] = f(i / sr, (seed >>> 0) / 0xffffffff * 2 - 1);
  }
  return buf;
}

const sine = (hz: number, t: number) => Math.sin(2 * Math.PI * hz * t);

/** Crisp "tsk": a very short high-passed click plus two bright partials with a slight downward chirp. */
function tapAt(t: number, noise: number, prev: { x: number; y: number }) {
  const hp = 0.85 * (prev.y + noise - prev.x); // one-pole high-pass on the noise
  prev.x = noise; prev.y = hp;
  const chirp = 1 + 0.08 * Math.exp(-t / 0.01);
  return 0.55 * hp * Math.exp(-t / 0.004)
    + 0.35 * sine(2100 * chirp, t) * Math.exp(-t / 0.022)
    + 0.2 * sine(3300 * chirp, t) * Math.exp(-t / 0.015);
}

export function makeHitSounds(ctx: BaseAudioContext): HitSounds {
  const s1 = { x: 0, y: 0 };
  const tap = render(ctx, 0.08, (t, n) => tapAt(t, n, s1));
  const s2 = { x: 0, y: 0 };
  // critical: the tap plus a shimmering high chord (G6–C8, slightly detuned pairs) ringing out
  const bell = [1568, 2349, 3136, 4186];
  const critical = render(ctx, 0.45, (t, n) => {
    let b = 0;
    for (const hz of bell) b += sine(hz, t) + 0.6 * sine(hz * 1.004, t);
    return tapAt(t, n, s2) + 0.07 * b * Math.exp(-t / 0.12) * Math.min(1, t / 0.003);
  });
  // hold: 0.5s seamless loop (every component completes whole cycles), quiet and soft
  const hold = render(ctx, 0.5, (t) => 0.12 * (0.6 + 0.4 * sine(8, t)) * (sine(1046, t) + 0.5 * sine(1568, t)));
  return { tap, critical, hold };
}

export function playHit(ctx: AudioContext, buf: AudioBuffer, volume: number) {
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = ctx.createGain();
  g.gain.value = volume;
  src.connect(g).connect(ctx.destination);
  src.start();
}

/** Starts a looping sound; the returned function fades it out and stops it. */
export function startLoop(ctx: AudioContext, buf: AudioBuffer, volume: number): () => void {
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  const g = ctx.createGain();
  g.gain.value = volume;
  src.connect(g).connect(ctx.destination);
  src.start();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    const now = ctx.currentTime;
    g.gain.setTargetAtTime(0, now, 0.01);
    src.stop(now + 0.06);
  };
}
