import { Renderer } from '../game/renderer.ts';
import { makeHitSounds, type HitSounds } from '../game/hitsound.ts';
import { storage, type Settings } from '../storage.ts';

export class App {
  readonly ctx = new AudioContext({ latencyHint: 'interactive' });
  /** Built-in sounds, with any custom files the player loaded swapped in. */
  sounds: HitSounds = makeHitSounds(this.ctx);
  readonly renderer: Renderer;
  readonly ui: HTMLElement;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;
  private keyUpHandler: ((e: KeyboardEvent) => void) | null = null;
  private cleanup: (() => void) | null = null;

  constructor(public settings: Settings, readonly canvas: HTMLCanvasElement) {
    this.ui = document.getElementById('ui')!;
    this.renderer = new Renderer(canvas);
    window.addEventListener('resize', () => { this.renderer.resize(); this.renderer.idle(); });
    window.addEventListener('keydown', (e) => this.keyHandler?.(e));
    window.addEventListener('keyup', (e) => this.keyUpHandler?.(e));
  }

  static async create() {
    const app = new App(await storage.getSettings(), document.getElementById('game') as HTMLCanvasElement);
    await app.loadCustomSounds();
    return app;
  }

  /** Replaces tap/critical with the player's own files when present; broken files fall back to the built-ins. */
  async loadCustomSounds() {
    const builtIn = makeHitSounds(this.ctx);
    const load = async (key: 'tap' | 'critical') => {
      const bytes = await storage.getFile(`se:${key}`);
      if (!bytes) return builtIn[key];
      try {
        return await this.ctx.decodeAudioData(bytes.slice(0));
      } catch {
        console.warn(`custom ${key} sound could not be decoded; using the built-in one`);
        return builtIn[key];
      }
    };
    this.sounds = { tap: await load('tap'), critical: await load('critical'), hold: builtIn.hold };
  }

  /** Replace the current screen. `onLeave` runs when the next screen is shown. */
  show(el: HTMLElement | null, opts: { keydown?: (e: KeyboardEvent) => void; keyup?: (e: KeyboardEvent) => void; onLeave?: () => void } = {}) {
    this.cleanup?.();
    this.cleanup = opts.onLeave ?? null;
    this.ui.replaceChildren(...(el ? [el] : []));
    this.keyHandler = opts.keydown ?? null;
    this.keyUpHandler = opts.keyup ?? null;
  }

  async saveSettings(s: Settings) {
    this.settings = s;
    await storage.putSettings(s);
  }

  async unlockAudio() {
    if (this.ctx.state !== 'running') await this.ctx.resume().catch(() => {});
  }
}
