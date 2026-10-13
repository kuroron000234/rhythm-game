import type { App } from './app.ts';
import { h, fmtTime } from './dom.ts';
import type { LoadedSong } from '../loader.ts';
import type { Difficulty } from '../analysis/chart.ts';
import { storage } from '../storage.ts';

const DIFFS: Difficulty[] = ['easy', 'normal', 'hard'];
let lastDifficulty: Difficulty = 'normal';

export function showSelect(app: App, song: LoadedSong, go: { play: (d: Difficulty) => void; back: () => void }) {
  const { entry, analysis } = song;
  let current = DIFFS.indexOf(lastDifficulty);
  const cards = DIFFS.map((d) => {
    const chart = analysis.charts[d];
    const best = h('div.best', {}, '');
    storage.getBest(entry.id, d).then((b) => {
      if (b) best.replaceChildren(h('span.rank', {}, b.rank), ` ${b.score.toLocaleString()}`, b.allPerfect ? h('em', {}, ' AP') : b.fullCombo ? h('em', {}, ' FC') : '');
    });
    return h(`button.card.${d}`, { onclick: () => start(DIFFS.indexOf(d)) },
      h('div.diff', {}, d.toUpperCase()),
      h('div.count', {}, `${chart.notes.length} notes`),
      best);
  });
  const highlight = () => cards.forEach((c, i) => c.classList.toggle('active', i === current));
  highlight();

  const start = (i: number) => {
    current = i;
    lastDifficulty = DIFFS[i];
    app.unlockAudio();
    go.play(DIFFS[i]);
  };

  const root = h('div.screen.select', {},
    h('button.ghost.back', { onclick: go.back }, '← 戻る'),
    entry.thumbnail ? h('img.cover', { src: entry.thumbnail, alt: '' }) : null,
    h('h2.song-name', {}, entry.title),
    h('div.muted', {}, `${fmtTime(analysis.duration)} · BPM ${analysis.bpm}`),
    analysis.gridReliable ? null : h('div.notice', {}, 'テンポが一定でないため、拍に揃えず音の立ち上がりに合わせた譜面にしています'),
    h('div.cards', {}, ...cards),
    h('p.muted.help', {}, '←→ で選択 · Enter で開始 · Esc で戻る'),
  );

  app.show(root, {
    keydown: (e) => {
      if (e.key === 'ArrowLeft') { current = Math.max(0, current - 1); highlight(); }
      else if (e.key === 'ArrowRight') { current = Math.min(2, current + 1); highlight(); }
      else if (e.key === 'Enter') start(current);
      else if (e.key === 'Escape') go.back();
    },
  });

  if (entry.thumbnail) {
    const img = new Image();
    img.onload = () => app.renderer.setBackground(img);
    img.src = entry.thumbnail;
  }
}
