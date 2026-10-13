import type { Note } from '../analysis/chart.ts';
import type { Grade } from './judge.ts';

export interface Frame {
  /** Song time used for drawing (visual offset already applied). */
  t: number;
  notes: Note[];
  judged: (index: number) => { head?: Grade; tail?: Grade };
  holding: (lane: number) => number;
  pressed: boolean[];
  /** Hi-speed 1–12. */
  speed: number;
  pulse: number;
  score: number;
  combo: number;
  life: number;
  failed: boolean;
  progress: number;
  title: string;
  keys: string[];
}

interface Particle { x: number; y: number; vx: number; vy: number; born: number; life: number; color: string; size: number }
interface Flash { lane: number; born: number; color: string }

const COLORS = {
  tap: ['#9ff3ff', '#29c9f0'],
  critical: ['#fff3b0', '#ffbe2e'],
  hold: ['#b8ffd9', '#2fd88a'],
  grade: { perfect: '#ffe36e', great: '#ff8ad8', good: '#6fd3ff', miss: '#8a8f9c' } as Record<Grade, string>,
};
const GRADE_LABEL: Record<Grade, string> = { perfect: 'PERFECT', great: 'GREAT', good: 'GOOD', miss: 'MISS' };
const K = 3; // perspective strength: the far end is 1/(1+K) as wide as the judge line
const Z_MIN = -0.12;

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private bg: HTMLCanvasElement | null = null;
  private particles: Particle[] = [];
  private flashes: Flash[] = [];
  private judgeText: { grade: Grade; born: number; critical: boolean } | null = null;
  private comboBorn = 0;
  private first = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.resize();
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Pre-blurs the thumbnail once; drawing a blurred image every frame is too slow. */
  setBackground(img: HTMLImageElement | null) {
    if (!img) { this.bg = null; return; }
    const c = document.createElement('canvas');
    c.width = 480;
    c.height = 270;
    const g = c.getContext('2d')!;
    g.filter = 'blur(14px) saturate(1.3)';
    const s = Math.max(c.width / img.width, c.height / img.height);
    g.drawImage(img, (c.width - img.width * s) / 2, (c.height - img.height * s) / 2, img.width * s, img.height * s);
    this.bg = c;
  }

  reset() {
    this.particles = [];
    this.flashes = [];
    this.judgeText = null;
    this.first = 0;
  }

  // --- geometry -----------------------------------------------------------
  private get judgeY() { return this.h * 0.84; }
  private get farY() { return this.h * 0.06; }
  private get laneW() { return Math.min(this.w * 0.9, this.h * 0.95); }
  private get vanishY() { const s1 = 1 / (1 + K); return (this.farY - s1 * this.judgeY) / (1 - s1); }
  private scale(z: number) { return 1 / (1 + K * z); }
  private y(z: number) { return this.vanishY + (this.judgeY - this.vanishY) * this.scale(z); }
  /** e in [-0.5, 0.5] across the whole playfield. */
  private x(e: number, z: number) { return this.w / 2 + e * this.laneW * this.scale(z); }
  private laneEdge(lane: number) { return -0.5 + lane / 4; }

  private quad(e0: number, e1: number, z0: number, z1: number) {
    const c = this.ctx;
    c.beginPath();
    c.moveTo(this.x(e0, z0), this.y(z0));
    c.lineTo(this.x(e1, z0), this.y(z0));
    c.lineTo(this.x(e1, z1), this.y(z1));
    c.lineTo(this.x(e0, z1), this.y(z1));
    c.closePath();
  }

  // --- effects ------------------------------------------------------------
  hit(lane: number, grade: Grade, critical: boolean, tail = false) {
    const now = performance.now();
    this.judgeText = { grade, born: now, critical };
    if (grade === 'miss') return;
    this.comboBorn = now;
    const color = critical ? COLORS.critical[1] : COLORS.grade[grade];
    this.flashes.push({ lane, born: now, color });
    const cx = this.x(this.laneEdge(lane) + 0.125, 0);
    const n = tail ? 8 : critical ? 26 : 16;
    for (let i = 0; i < n; i++) {
      const a = Math.PI * (1 + Math.random());
      const sp = 140 + Math.random() * 380;
      this.particles.push({
        x: cx + (Math.random() - 0.5) * this.laneW * 0.15, y: this.judgeY,
        vx: Math.cos(a) * sp * 0.6, vy: Math.sin(a) * sp, born: now, life: 350 + Math.random() * 250,
        color, size: 1.5 + Math.random() * 2.5,
      });
    }
  }

  // --- drawing ------------------------------------------------------------
  draw(f: Frame) {
    const c = this.ctx;
    const now = performance.now();
    this.drawBackground(f.pulse);
    this.drawField(f, now);
    this.drawNotes(f);
    this.drawEffects(now);
    this.drawHud(f, now);
    c.globalAlpha = 1;
  }

  private drawBackground(pulse: number) {
    const c = this.ctx;
    c.fillStyle = '#07060f';
    c.fillRect(0, 0, this.w, this.h);
    if (this.bg) {
      const s = Math.max(this.w / this.bg.width, this.h / this.bg.height) * (1.04 + 0.02 * pulse);
      c.globalAlpha = 0.55;
      c.drawImage(this.bg, (this.w - this.bg.width * s) / 2, (this.h - this.bg.height * s) / 2, this.bg.width * s, this.bg.height * s);
      c.globalAlpha = 1;
    }
    const g = c.createRadialGradient(this.w / 2, this.h * 0.3, 0, this.w / 2, this.h * 0.3, this.h * 0.9);
    g.addColorStop(0, `rgba(120, 80, 255, ${0.1 + 0.18 * pulse})`);
    g.addColorStop(1, 'rgba(7, 6, 15, 0.75)');
    c.fillStyle = g;
    c.fillRect(0, 0, this.w, this.h);
  }

  private drawField(f: Frame, now: number) {
    const c = this.ctx;
    // floor
    this.quad(-0.5, 0.5, Z_MIN, 1);
    const floor = c.createLinearGradient(0, this.farY, 0, this.judgeY);
    floor.addColorStop(0, 'rgba(10, 12, 30, 0.2)');
    floor.addColorStop(1, 'rgba(14, 16, 38, 0.85)');
    c.fillStyle = floor;
    c.fill();
    // key glow
    for (let l = 0; l < 4; l++) {
      if (!f.pressed[l]) continue;
      this.quad(this.laneEdge(l), this.laneEdge(l + 1), 0, 0.45);
      const g = c.createLinearGradient(0, this.judgeY, 0, this.y(0.45));
      g.addColorStop(0, 'rgba(140, 220, 255, 0.35)');
      g.addColorStop(1, 'rgba(140, 220, 255, 0)');
      c.fillStyle = g;
      c.fill();
    }
    // hit flashes
    this.flashes = this.flashes.filter((fl) => now - fl.born < 220);
    for (const fl of this.flashes) {
      const a = 1 - (now - fl.born) / 220;
      this.quad(this.laneEdge(fl.lane), this.laneEdge(fl.lane + 1), 0, 0.7);
      const g = c.createLinearGradient(0, this.judgeY, 0, this.y(0.7));
      g.addColorStop(0, hexA(fl.color, 0.5 * a));
      g.addColorStop(1, hexA(fl.color, 0));
      c.fillStyle = g;
      c.fill();
    }
    // lane lines
    c.lineWidth = 1;
    for (let l = 0; l <= 4; l++) {
      const e = this.laneEdge(l);
      c.strokeStyle = l === 0 || l === 4 ? 'rgba(160, 200, 255, 0.55)' : 'rgba(160, 200, 255, 0.18)';
      c.beginPath();
      c.moveTo(this.x(e, Z_MIN), this.y(Z_MIN));
      c.lineTo(this.x(e, 1), this.y(1));
      c.stroke();
    }
    // judge line
    c.save();
    c.shadowColor = '#7fe8ff';
    c.shadowBlur = 16;
    c.strokeStyle = '#e8fbff';
    c.lineWidth = 3;
    c.beginPath();
    c.moveTo(this.x(-0.5, 0), this.judgeY);
    c.lineTo(this.x(0.5, 0), this.judgeY);
    c.stroke();
    c.restore();
    // key labels
    c.font = `600 ${Math.round(this.h * 0.022)}px system-ui, sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    for (let l = 0; l < 4; l++) {
      c.fillStyle = f.pressed[l] ? 'rgba(255,255,255,0.9)' : 'rgba(200,220,255,0.35)';
      c.fillText(f.keys[l] ?? '', this.x(this.laneEdge(l) + 0.125, Z_MIN), this.y(Z_MIN) + this.h * 0.03);
    }
  }

  private drawNotes(f: Frame) {
    const visible = 6.5 / f.speed;
    const z = (t: number) => (t - f.t) / visible;
    const notes = f.notes;
    while (this.first < notes.length && notes[this.first].t + (notes[this.first].dur ?? 0) < f.t - 1) this.first++;
    // hold bodies first so heads draw on top
    for (let pass = 0; pass < 2; pass++) {
      for (let i = this.first; i < notes.length; i++) {
        const n = notes[i];
        const z0 = z(n.t);
        if (z0 > 1) break;
        const j = f.judged(i);
        const held = f.holding(n.lane) === i;
        const e0 = this.laneEdge(n.lane) + 0.006, e1 = this.laneEdge(n.lane + 1) - 0.006;
        if (pass === 0 && n.dur) {
          const zEnd = Math.min(1, z(n.t + n.dur));
          const zStart = held ? 0 : Math.max(Z_MIN, z0);
          if (zEnd <= Z_MIN || (j.tail && !held) || (j.head && j.head !== 'miss' && !held)) continue;
          this.quad(e0 + 0.02, e1 - 0.02, zStart, zEnd);
          const dead = j.head === 'miss';
          this.ctx.fillStyle = dead ? 'rgba(120,130,140,0.35)' : held ? 'rgba(90, 255, 170, 0.6)' : 'rgba(60, 220, 140, 0.42)';
          this.ctx.fill();
          if (!dead && zEnd < 1) this.drawNote(e0, e1, zEnd, COLORS.hold, 0.6);
        }
        if (pass === 1) {
          if (z0 < Z_MIN && !held) continue;
          if (j.head && j.head !== 'miss' && !held) continue;
          const colors = n.critical ? COLORS.critical : n.dur ? COLORS.hold : COLORS.tap;
          this.drawNote(e0, e1, held ? 0 : z0, colors, j.head === 'miss' ? 0.3 : 1);
        }
      }
    }
  }

  private drawNote(e0: number, e1: number, z: number, [light, dark]: string[], alpha: number) {
    const c = this.ctx;
    const dz = 0.02;
    this.quad(e0, e1, z - dz, z + dz);
    const g = c.createLinearGradient(0, this.y(z + dz), 0, this.y(z - dz));
    g.addColorStop(0, light);
    g.addColorStop(1, dark);
    c.globalAlpha = alpha * Math.min(1, (1.05 - z) * 4);
    c.fillStyle = g;
    c.fill();
    c.strokeStyle = 'rgba(255,255,255,0.85)';
    c.lineWidth = 1.5 * this.scale(Math.max(0, z));
    c.stroke();
    c.globalAlpha = 1;
  }

  private drawEffects(now: number) {
    const c = this.ctx;
    this.particles = this.particles.filter((p) => now - p.born < p.life);
    c.globalCompositeOperation = 'lighter';
    for (const p of this.particles) {
      const age = (now - p.born) / 1000;
      const a = 1 - (now - p.born) / p.life;
      c.globalAlpha = a;
      c.fillStyle = p.color;
      c.beginPath();
      c.arc(p.x + p.vx * age, p.y + p.vy * age + 600 * age * age, p.size, 0, Math.PI * 2);
      c.fill();
    }
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = 1;
  }

  private drawHud(f: Frame, now: number) {
    const c = this.ctx;
    const u = this.h / 100;
    c.textBaseline = 'middle';
    // judge text + combo
    if (this.judgeText && now - this.judgeText.born < 600) {
      const age = now - this.judgeText.born;
      const pop = 1 + 0.3 * Math.max(0, 1 - age / 100);
      c.globalAlpha = Math.min(1, (600 - age) / 200);
      c.font = `italic 800 ${Math.round(4.2 * u * pop)}px system-ui, sans-serif`;
      c.textAlign = 'center';
      c.fillStyle = this.judgeText.critical && this.judgeText.grade !== 'miss' ? COLORS.critical[1] : COLORS.grade[this.judgeText.grade];
      c.shadowColor = c.fillStyle as string;
      c.shadowBlur = 18;
      c.fillText(GRADE_LABEL[this.judgeText.grade], this.w / 2, this.judgeY - 26 * u);
      c.shadowBlur = 0;
      c.globalAlpha = 1;
    }
    if (f.combo >= 2) {
      const pop = 1 + 0.15 * Math.max(0, 1 - (now - this.comboBorn) / 120);
      c.textAlign = 'center';
      c.font = `800 ${Math.round(8 * u * pop)}px system-ui, sans-serif`;
      c.fillStyle = 'rgba(255,255,255,0.92)';
      c.fillText(String(f.combo), this.w / 2, this.judgeY - 38 * u);
      c.font = `700 ${Math.round(1.8 * u)}px system-ui, sans-serif`;
      c.fillStyle = 'rgba(200,220,255,0.7)';
      c.fillText('COMBO', this.w / 2, this.judgeY - 32 * u);
    }
    // score
    c.textAlign = 'right';
    c.font = `800 ${Math.round(4 * u)}px system-ui, sans-serif`;
    c.fillStyle = '#fff';
    c.fillText(String(f.score).padStart(7, '0'), this.w - 3 * u, 5 * u);
    // title + progress
    c.textAlign = 'left';
    c.font = `600 ${Math.round(2 * u)}px system-ui, sans-serif`;
    c.fillStyle = 'rgba(220,230,255,0.85)';
    c.fillText(f.title, 3 * u, 4 * u, this.w * 0.4);
    c.fillStyle = 'rgba(255,255,255,0.15)';
    c.fillRect(3 * u, 6.5 * u, this.w * 0.3, 0.5 * u);
    c.fillStyle = '#9ff3ff';
    c.fillRect(3 * u, 6.5 * u, this.w * 0.3 * Math.max(0, Math.min(1, f.progress)), 0.5 * u);
    // life
    const lw = Math.min(this.w * 0.4, 50 * u);
    const lx = this.w / 2 - lw / 2;
    c.fillStyle = 'rgba(255,255,255,0.12)';
    c.fillRect(lx, 2.5 * u, lw, 1.2 * u);
    c.fillStyle = f.failed ? '#666' : f.life < 30 ? '#ff5470' : '#58f0a0';
    c.fillRect(lx, 2.5 * u, (lw * f.life) / 100, 1.2 * u);
    c.font = `700 ${Math.round(1.5 * u)}px system-ui, sans-serif`;
    c.textAlign = 'center';
    c.fillStyle = 'rgba(255,255,255,0.8)';
    c.fillText(f.failed ? 'FAILED' : `LIFE ${Math.ceil(f.life)}`, this.w / 2, 5.2 * u);
  }
}

function hexA(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
