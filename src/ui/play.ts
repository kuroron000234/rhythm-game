import type { App } from './app.ts';
import { h, keyLabel } from './dom.ts';
import type { LoadedSong } from '../loader.ts';
import type { Difficulty } from '../analysis/chart.ts';
import { SongClock } from '../game/clock.ts';
import { Judge, type JudgeState } from '../game/judge.ts';
import { playHit } from '../game/hitsound.ts';

export interface PlayResult {
  state: JudgeState;
  difficulty: Difficulty;
  /** Mean hit timing error in ms (positive = late), for offset hints. */
  meanDelta: number;
}

const LEAD_IN = 2;

export function showPlay(app: App, song: LoadedSong, difficulty: Difficulty, go: { result: (r: PlayResult) => void; select: () => void }) {
  const s = app.settings;
  const chart = song.analysis.charts[difficulty];
  const notes = chart.notes;
  const judge = new Judge(notes);
  const clock = new SongClock(app.ctx, song.buffer, s.volume);
  const pressed = [false, false, false, false];
  const deltas: number[] = [];
  const lastEnd = notes.reduce((m, n) => Math.max(m, n.t + (n.dur ?? 0)), 0);
  const endAt = Math.min(song.buffer.duration, lastEnd + 2);
  const judgeOffset = s.judgeOffset / 1000;
  const pulse = song.analysis.pulse;
  let raf = 0;
  let ended = false;
  let menu: HTMLElement | null = null;

  app.renderer.reset();

  const handle = (events: ReturnType<Judge['update']>) => {
    for (const ev of events) {
      app.renderer.hit(ev.lane, ev.grade, ev.critical, ev.tail);
      if (!ev.tail && ev.grade !== 'miss') deltas.push(ev.delta);
    }
  };

  const frame = () => {
    raf = requestAnimationFrame(frame);
    const t = clock.now();
    if (!clock.paused) handle(judge.update(t - judgeOffset));
    const vt = t + s.visualOffset / 1000;
    app.renderer.draw({
      t: vt, notes, speed: s.speed, pressed,
      judged: (i) => judge.judged(i), holding: (l) => judge.holdingIn(l),
      pulse: pulse.data[Math.max(0, Math.min(pulse.data.length - 1, Math.floor(t * pulse.frameRate)))] ?? 0,
      score: judge.state.score, combo: judge.state.combo, life: judge.state.life, failed: judge.state.failed,
      progress: t / song.buffer.duration, title: song.entry.title, keys: s.keys.map(keyLabel),
    });
    if (!ended && t > endAt && (judge.finished || t > endAt + 1)) finish();
  };

  const finish = () => {
    ended = true;
    setTimeout(() => {
      const mean = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;
      go.result({ state: { ...judge.state, counts: { ...judge.state.counts } }, difficulty, meanDelta: mean * 1000 });
    }, 1200);
  };

  const pause = async () => {
    if (ended || clock.paused) return;
    await clock.pause();
    pressed.fill(false);
    menu = h('div.pause', {},
      h('h2', {}, 'PAUSE'),
      h('button.primary', { onclick: resume }, '再開 (Esc)'),
      h('button', { onclick: retry }, 'リトライ (R)'),
      h('button', { onclick: quit }, '曲選択へ (Q)'),
    );
    app.ui.replaceChildren(menu);
  };
  const resume = async () => {
    menu = null;
    app.ui.replaceChildren();
    await clock.resume();
  };
  const retry = async () => {
    await clock.resume();
    showPlay(app, song, difficulty, go);
  };
  const quit = async () => {
    await clock.resume();
    go.select();
  };

  const laneOf = (code: string) => s.keys.indexOf(code);

  app.show(null, {
    keydown: (e) => {
      if (menu) {
        if (e.code === 'Escape') resume();
        else if (e.code === 'KeyR') retry();
        else if (e.code === 'KeyQ') quit();
        return;
      }
      if (e.code === 'Escape') { pause(); return; }
      const lane = laneOf(e.code);
      if (lane < 0) return;
      e.preventDefault();
      if (e.repeat) return;
      pressed[lane] = true;
      const ev = judge.press(lane, clock.at(e.timeStamp) - judgeOffset);
      if (ev) {
        if (s.hitSound) playHit(app.ctx, app.hitBuffer, s.hitVolume, ev.critical);
        handle([ev]);
      }
    },
    keyup: (e) => {
      const lane = laneOf(e.code);
      if (lane < 0) return;
      pressed[lane] = false;
      const ev = judge.release(lane, clock.at(e.timeStamp) - judgeOffset);
      if (ev) handle([ev]);
    },
    onLeave: () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('blur', onBlur);
      clock.dispose();
      app.renderer.idle();
    },
  });

  // releasing focus would leave keys "stuck"; treat it as a pause
  const onBlur = () => pause();
  window.addEventListener('blur', onBlur);

  // ?debug exposes the session for automated end-to-end checks
  if (location.search.includes('debug')) Object.assign(window, { __rg: { notes, keys: s.keys, now: () => clock.now(), state: judge.state, deltas } });

  clock.start(LEAD_IN).then(() => (raf = requestAnimationFrame(frame)));
}
