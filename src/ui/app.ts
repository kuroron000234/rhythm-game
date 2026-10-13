import { Renderer } from '../game/renderer.ts';
import { makeHitSound } from '../game/hitsound.ts';
import { storage, type Settings } from '../storage.ts';

export class App {
  readonly ctx = new AudioContext({ latencyHint: 'interactive' });
  readonly hitBuffer = makeHitSound(this.ctx);
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
    return new App(await storage.getSettings(), document.getElementById('game') as HTMLCanvasElement);
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
