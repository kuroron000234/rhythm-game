import type { App } from './app.ts';
import { h, fmtTime } from './dom.ts';
import type { LoadedSong } from '../loader.ts';
import type { Difficulty } from '../analysis/chart.ts';
import { storage } from '../storage.ts';
import { aiAvailable, watchAi } from '../aiJobs.ts';

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

  // AI (vocal-driven) chart: show progress and swap it in when it arrives
  const aiBadge = h('div.ai-badge', { hidden: true });
  const showBadge = (text: string, cls = '') => {
    aiBadge.hidden = false;
    aiBadge.className = `ai-badge ${cls}`;
    aiBadge.textContent = text;
  };
  let left = false;
  let unwatch = () => {};
  if (analysis.source === 'ai') showBadge('AI 譜面 · ボーカル連動', 'ready');
  else {
    aiAvailable().then((ok) => {
      if (!ok || left) return;
      unwatch = watchAi(app.ctx, entry, (st) => {
        if (left) return;
        if (st.state === 'queued') showBadge('AI 解析待ち…(今の譜面でも遊べます)');
        else if (st.state === 'running') showBadge(`AI 分離中${st.progress > 0 ? ` ${Math.round(st.progress * 100)}%` : '…'}(今の譜面でも遊べます)`);
        else if (st.state === 'analyzing') showBadge('AI 譜面を生成中…');
        else if (st.state === 'error') { showBadge('AI 解析に失敗しました(通常譜面のままです)', 'error'); aiBadge.title = st.error; }
        else if (st.state === 'ready') {
          song.analysis = st.analysis;
          lastDifficulty = DIFFS[current];
          showSelect(app, song, go);
        }
      });
    });
  }

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
    aiBadge,
    analysis.gridReliable ? null : h('div.notice', {}, 'テンポが一定でないため、拍に揃えず音の立ち上がりに合わせた譜面にしています'),
    h('div.cards', {}, ...cards),
    h('p.muted.help', {}, '←→ で選択 · Enter で開始 · Esc で戻る'),
  );

  app.show(root, {
    onLeave: () => { left = true; unwatch(); },
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
