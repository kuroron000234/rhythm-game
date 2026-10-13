import type { App } from './app.ts';
import { h } from './dom.ts';
import type { LoadedSong } from '../loader.ts';
import type { PlayResult } from './play.ts';
import { rankOf } from '../game/judge.ts';
import { storage } from '../storage.ts';

export async function showResult(app: App, song: LoadedSong, r: PlayResult, go: { retry: () => void; select: () => void; title: () => void }) {
  const st = r.state;
  const rank = rankOf(st.score);
  const cleared = !st.failed;
  const prev = await storage.getBest(song.entry.id, r.difficulty);
  const isNew = !prev || st.score > prev.score;
  await storage.putBest(song.entry.id, r.difficulty, {
    score: Math.max(st.score, prev?.score ?? 0),
    rank: isNew ? rank : prev!.rank,
    maxCombo: Math.max(st.maxCombo, prev?.maxCombo ?? 0),
    fullCombo: st.fullCombo || !!prev?.fullCombo,
    allPerfect: st.allPerfect || !!prev?.allPerfect,
    cleared: cleared || !!prev?.cleared,
    at: Date.now(),
  });

  const badge = st.allPerfect ? 'ALL PERFECT' : st.fullCombo ? 'FULL COMBO' : null;
  const offsetHint = Math.abs(r.meanDelta) >= 15
    ? `平均 ${Math.abs(r.meanDelta).toFixed(0)}ms ${r.meanDelta > 0 ? '遅れ' : '早め'}気味です。設定の判定オフセットで調整できます`
    : null;

  const root = h('div.screen.result', {},
    h('div.muted', {}, `${song.entry.title} · ${r.difficulty.toUpperCase()}`),
    h(`div.big-rank.r${rank}`, {}, rank),
    h('div.score', {}, st.score.toLocaleString(), isNew ? h('span.new', {}, 'NEW RECORD') : null),
    h(`div.clear.${cleared ? 'ok' : 'ng'}`, {}, cleared ? 'CLEAR' : 'FAILED'),
    badge ? h('div.badge', {}, badge) : null,
    h('table.counts', {},
      ...(['perfect', 'great', 'good', 'miss'] as const).map((g) => h('tr', {}, h(`th.${g}`, {}, g.toUpperCase()), h('td', {}, String(st.counts[g])))),
      h('tr', {}, h('th', {}, 'MAX COMBO'), h('td', {}, String(st.maxCombo))),
    ),
    offsetHint ? h('p.muted', {}, offsetHint) : null,
    h('div.buttons', {},
      h('button.primary', { onclick: go.retry }, 'リトライ (R)'),
      h('button', { onclick: go.select }, '難易度選択 (Enter)'),
      h('button.ghost', { onclick: go.title }, 'タイトルへ (Esc)'),
    ),
  );
  app.show(root, {
    keydown: (e) => {
      if (e.code === 'KeyR') go.retry();
      else if (e.code === 'Enter') go.select();
      else if (e.code === 'Escape') go.title();
    },
  });
}
