import type { App } from './app.ts';
import { h, fmtTime } from './dom.ts';
import { fromAudius, fromFile, fromHistory, fromUrl, prepare, serverStatus, LoadError, type LoadedSong } from '../loader.ts';
import { AUDIUS_PRIVACY_URL, AUDIUS_TERMS_URL, searchTracks, type AudiusTrack } from '../audius.ts';
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

  const input = h<HTMLInputElement>('input.url', { type: 'url', placeholder: 'YouTube などの URL を貼り付け(ローカルサーバー版のみ)' });
  const form = h('form.url-form', {
    onsubmit: (e: Event) => {
      e.preventDefault();
      const url = input.value.trim();
      if (url) load(() => fromUrl(url, setStatus));
    },
  }, input, h('button.primary', { type: 'submit' }, '読み込む'));

  // song search (Audius): pick a track and it is charted on the spot
  const results = h('div.results');
  const searchInput = h<HTMLInputElement>('input.url', { type: 'search', placeholder: '曲名・アーティスト名で検索', autofocus: true });
  let searchSeq = 0;
  async function search(q: string) {
    const seq = ++searchSeq;
    if (!q.trim()) { results.replaceChildren(); return; }
    results.replaceChildren(h('p.muted', {}, '検索中…'));
    try {
      const tracks = await searchTracks(q);
      if (seq !== searchSeq) return;
      results.replaceChildren(...(tracks.length
        ? tracks.slice(0, 12).map(trackButton)
        : [h('p.muted', {}, '見つかりませんでした。別の言葉で検索するか、手元の音声ファイルを使ってください')]));
    } catch {
      if (seq === searchSeq) results.replaceChildren(h('p.muted', {}, '検索できませんでした。時間をおいて試してください'));
    }
  }
  const trackButton = (t: AudiusTrack) => h('button.song', { onclick: () => load(() => fromAudius(t, setStatus)) },
    t.artwork ? h('img', { src: t.artwork, alt: '', loading: 'lazy' }) : h('div.noimg', {}, '♪'),
    h('div.song-info', {}, h('div.song-title', {}, t.title), h('div.muted', {}, `${t.artist} · ${fmtTime(t.duration)}`)));
  let debounce = 0;
  searchInput.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = window.setTimeout(() => search(searchInput.value), 450);
  });
  const searchForm = h('form.url-form', {
    onsubmit: (e: Event) => { e.preventDefault(); clearTimeout(debounce); search(searchInput.value); },
  }, searchInput, h('button.primary', { type: 'submit' }, '検索'));
  const audiusNote = h('p.audius-note', {},
    '曲は ', h('a', { href: 'https://audius.co', target: '_blank', rel: 'noopener' }, 'Audius'),
    ' の公開楽曲をその場で再生します(保存はしません)。',
    h('a', { href: AUDIUS_PRIVACY_URL, target: '_blank', rel: 'noopener' }, 'プライバシーポリシー'), ' · ',
    h('a', { href: AUDIUS_TERMS_URL, target: '_blank', rel: 'noopener' }, 'API 規約'));

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
    searchForm, results, audiusNote, status, bar, errorBox, drop, form, server,
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
    if (!s) {
      // static hosting (GitHub Pages) or no local server: everything except URL loading works in the browser
      form.hidden = true;
      server.textContent = '手元の音声ファイル(mp3 / m4a / wav など)をドロップしても遊べます';
      return;
    }
    if (!s.ytdlp) server.textContent = 'yt-dlp が見つかりません。URL 読み込みは使えません(ファイルのドロップは使えます)';
    else server.textContent = `yt-dlp ${s.ytdlp}`;
    if (s) {
      const dev = (d: { device: string }) => (d.device === 'cuda' ? 'GPU' : 'CPU — 数分かかります');
      server.textContent += s.mug ? ` · AI 譜面: MuG (${dev(s.mug)})`
        : s.ai ? ` · AI 譜面: ボーカル連動 (${dev(s.ai)})` : ' · AI 譜面: 無効 (npm run setup-mug で有効化)';
    }
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
