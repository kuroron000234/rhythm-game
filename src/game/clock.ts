/**
 * Song time derived from the AudioContext output clock — never from requestAnimationFrame.
 * getOutputTimestamp() pairs the audio actually reaching the speakers with performance.now(),
 * which lets input event timestamps (performance.now domain) be mapped onto song time exactly.
 */
/** AudioContext output time at a performance.now()-domain timestamp. */
export function ctxTimeAt(ctx: AudioContext, perfMs: number): number {
  const ts = ctx.getOutputTimestamp?.();
  if (ts && ts.performanceTime && ts.contextTime !== undefined) {
    return ts.contextTime + (perfMs - ts.performanceTime) / 1000;
  }
  const latency = ctx.outputLatency || ctx.baseLatency || 0;
  return ctx.currentTime - latency - (performance.now() - perfMs) / 1000;
}

export class SongClock {
  private source?: AudioBufferSourceNode;
  private readonly gain: GainNode;
  private startAt = 0;
  private frozen: number | null = null;
  onEnded?: () => void;

  constructor(readonly ctx: AudioContext, private buffer: AudioBuffer, volume = 1) {
    this.gain = ctx.createGain();
    this.gain.gain.value = volume;
    this.gain.connect(ctx.destination);
  }

  get duration() {
    return this.buffer.duration;
  }

  /** Starts playback so that song time 0 is heard after `leadIn` seconds (song time is negative until then). */
  async start(leadIn = 2) {
    this.stop();
    if (this.ctx.state !== 'running') await this.ctx.resume();
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.gain);
    this.startAt = this.ctx.currentTime + leadIn;
    src.start(this.startAt);
    src.onended = () => this.source === src && this.onEnded?.();
    this.source = src;
    this.frozen = null;
  }

  stop() {
    if (this.source) {
      const s = this.source;
      this.source = undefined;
      try { s.stop(); } catch { /* not started */ }
      s.disconnect();
    }
  }

  async pause() {
    this.frozen = this.now();
    await this.ctx.suspend();
  }

  async resume() {
    await this.ctx.resume();
    this.frozen = null;
  }

  get paused() {
    return this.frozen !== null;
  }

  /** Song time (seconds) at a performance.now()-domain timestamp, e.g. KeyboardEvent.timeStamp. */
  at(perfMs: number): number {
    if (this.frozen !== null) return this.frozen;
    return ctxTimeAt(this.ctx, perfMs) - this.startAt;
  }

  now(): number {
    return this.at(performance.now());
  }

  dispose() {
    this.stop();
    this.gain.disconnect();
  }
}
