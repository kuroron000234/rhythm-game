import type { App } from './app.ts';
import { h, fmtTime } from './dom.ts';
import { fromFile, fromHistory, fromUrl, prepare, serverStatus, LoadError, type LoadedSong } from '../loader.ts';
import { storage, type SongEntry } from '../storage.ts';
import type { Difficulty } from '../analysis/chart.ts';

const DIFFS: Difficulty[] = ['easy', 'normal', 'hard'];

export function showTitle(app: App, go: { select: (s: LoadedSong) => void; settings: () => void }, error?: LoadError) {
  const status = h('div.status');
  const bar = h('div.progress', {}, h('div.progress-fill'));
  const errorBox = h('div.error', { hidden: !error });
  const showError = (e: unknown) => {
    const le = e instanceof LoadError ? e : new LoadError(String((e as Error)?.message ?? e));
    errorBox.hidden = false;
    errorBox.replaceChildren(h('strong', {}, le.message), ...(le.hint ? [h('div.hint', {}, le.hint)] : []));
  };
  if (error) showError(error);

  let busy = false;
  const setStatus = (msg: string, p?: number) => {
    status.textContent = msg;
    bar.hidden = p === undefined;
    (bar.firstChild as HTMLElement).style.width = `${Math.round((p ?? 0) * 100)}%`;
  };
  bar.hidden = true;

  async function load(get: () => Promise<{ entry: SongEntry; bytes: ArrayBuffer }>) {
    if (busy) return;
    busy = true;
    errorBox.hidden = true;
    root.classList.add('busy');
    await app.unlockAudio();
    try {
      const { entry, bytes } = await get();
      const song = await prepare(app.ctx, entry, bytes, setStatus);
      go.select(song);
    } catch (e) {
      showError(e);
      setStatus('');
    } finally {
      busy = false;
      root.classList.remove('busy');
    }
  }

  const input = h<HTMLInputElement>('input.url', { type: 'url', placeholder: 'YouTube などの URL を貼り付け', autofocus: true });
  const form = h('form.url-form', {
    onsubmit: (e: Event) => {
      e.preventDefault();
      const url = input.value.trim();
      if (url) load(() => fromUrl(url, setStatus));
    },
  }, input, h('button.primary', { type: 'submit' }, '読み込む'));

  const fileInput = h<HTMLInputElement>('input', { type: 'file', accept: 'audio/*,video/*', hidden: true, onchange: () => {
    const f = fileInput.files?.[0];
    if (f) load(() => fromFile(f));
  } });
  const drop = h('div.drop', { onclick: () => fileInput.click() }, '音声ファイルをドロップ / クリックして選択', fileInput);

  const history = h('div.history');
  const server = h('div.server');
  const root = h('div.screen.title',
    {},
    h('h1.logo', {}, 'AUTO', h('span', {}, 'BEAT')),
    h('p.tagline', {}, '好きな曲が、その場で譜面になる'),
    form, drop, status, bar, errorBox, server,
    h('div.row', {}, h('h2', {}, '履歴'), h('button.ghost', { onclick: go.settings }, '設定')),
    history,
  );

  const onDragOver = (e: DragEvent) => { e.preventDefault(); root.classList.add('dragging'); };
  const onDragLeave = () => root.classList.remove('dragging');
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    root.classList.remove('dragging');
    const f = e.dataTransfer?.files?.[0];
    if (f) load(() => fromFile(f));
  };
  window.addEventListener('dragover', onDragOver);
  window.addEventListener('dragleave', onDragLeave);
  window.addEventListener('drop', onDrop);

  app.show(root, {
    onLeave: () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    },
  });
  app.renderer.setBackground(null);

  serverStatus().then((s) => {
    if (!s) server.textContent = 'サーバーに接続できません。URL 読み込みには npm start が必要です(ファイルのドロップは使えます)';
    else if (!s.ytdlp) server.textContent = 'yt-dlp が見つかりません。URL 読み込みは使えません(ファイルのドロップは使えます)';
    else server.textContent = `yt-dlp ${s.ytdlp}`;
    if (s) server.textContent += s.ai ? ` · AI 譜面: 有効 (${s.ai.device === 'cuda' ? 'GPU' : 'CPU — 分離に数分かかります'})` : ' · AI 譜面: 無効 (npm run setup-ai で有効化)';
    server.classList.toggle('warn', !s?.ytdlp);
  });

  storage.getSongs().then(async (songs) => {
    if (!songs.length) { history.append(h('p.muted', {}, 'まだ曲がありません')); return; }
    for (const s of songs.slice(0, 30)) {
      const bests = await Promise.all(DIFFS.map((d) => storage.getBest(s.id, d)));
      history.append(h('button.song', { onclick: () => load(() => fromHistory(s, setStatus)) },
        s.thumbnail ? h('img', { src: s.thumbnail, alt: '', loading: 'lazy' }) : h('div.noimg', {}, '♪'),
        h('div.song-info', {}, h('div.song-title', {}, s.title), h('div.muted', {}, s.duration ? fmtTime(s.duration) : '')),
        h('div.ranks', {}, ...DIFFS.map((d, i) => h(`span.rank.${d}`, { title: d }, bests[i]?.rank ?? '-'))),
      ));
    }
  });
}
