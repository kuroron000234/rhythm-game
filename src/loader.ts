import type { Analysis } from './analysis/analyze.ts';
import { CHART_VERSION, SR } from './analysis/params.ts';
import { storage, type SongEntry } from './storage.ts';

export type Status = (message: string, progress?: number) => void;

export interface LoadedSong {
  entry: SongEntry;
  buffer: AudioBuffer;
  analysis: Analysis;
}

export class LoadError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
  }
}

export async function serverStatus(): Promise<{ ytdlp: string | null } | null> {
  try {
    const r = await fetch('/api/status');
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

async function fetchJson(url: string, body: unknown) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new LoadError(j.error ?? `サーバーエラー (${r.status})`, j.hint);
  return j;
}

export async function fromUrl(url: string, status: Status): Promise<{ entry: SongEntry; bytes: ArrayBuffer }> {
  status('音声を取得中… (yt-dlp)');
  let meta;
  try {
    meta = await fetchJson('/api/fetch', { url });
  } catch (e) {
    if (e instanceof LoadError) throw e;
    throw new LoadError('サーバーに接続できません', 'npm start でサーバーを起動してください');
  }
  status('音声をダウンロード中…');
  const r = await fetch(`/api/audio/${meta.id}`);
  if (!r.ok) throw new LoadError('音声の取得に失敗しました');
  const entry: SongEntry = { ...meta, source: 'url', url, lastPlayed: Date.now() };
  return { entry, bytes: await r.arrayBuffer() };
}

export async function fromFile(file: File): Promise<{ entry: SongEntry; bytes: ArrayBuffer }> {
  const bytes = await file.arrayBuffer();
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const id = 'file-' + [...hash.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
  await storage.putFile(id, bytes);
  const entry: SongEntry = {
    id, title: file.name.replace(/\.[^.]+$/, ''), duration: 0, thumbnail: null, source: 'file', lastPlayed: Date.now(),
  };
  return { entry, bytes };
}

export async function fromHistory(entry: SongEntry, status: Status): Promise<{ entry: SongEntry; bytes: ArrayBuffer }> {
  if (entry.source === 'file') {
    const bytes = await storage.getFile(entry.id);
    if (!bytes) throw new LoadError('保存された音声が見つかりません', 'ファイルをもう一度ドロップしてください');
    return { entry: { ...entry, lastPlayed: Date.now() }, bytes };
  }
  const r = await fetch(`/api/audio/${entry.id}`).catch(() => null);
  if (r?.ok) return { entry: { ...entry, lastPlayed: Date.now() }, bytes: await r.arrayBuffer() };
  return fromUrl(entry.url!, status);
}

function toMono22k(buffer: AudioBuffer): Promise<AudioBuffer> {
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(buffer.duration * SR)), SR);
  const src = off.createBufferSource();
  src.buffer = buffer;
  src.connect(off.destination);
  src.start();
  return off.startRendering();
}

function runWorker(pcm: Float32Array, seed: string, status: Status): Promise<Analysis> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./analysis/worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') status(`解析中: ${m.stage}`, m.p);
      else {
        w.terminate();
        if (m.type === 'done') resolve(m.analysis);
        else reject(new LoadError(`解析に失敗しました: ${m.message}`));
      }
    };
    w.onerror = (e) => { w.terminate(); reject(new LoadError(`解析に失敗しました: ${e.message}`)); };
    w.postMessage({ mode: 'mix', pcm, sr: SR, seed }, [pcm.buffer]);
  });
}

export async function prepare(ctx: AudioContext, entry: SongEntry, bytes: ArrayBuffer, status: Status): Promise<LoadedSong> {
  status('デコード中…');
  let buffer: AudioBuffer;
  try {
    buffer = await ctx.decodeAudioData(bytes.slice(0));
  } catch {
    throw new LoadError('この音声形式はデコードできませんでした', 'mp3 / wav / ogg / m4a / webm などを試してください');
  }
  entry = { ...entry, duration: buffer.duration };
  let analysis = await storage.getAnalysis(entry.id);
  if (!analysis || analysis.version !== CHART_VERSION) {
    status('解析の準備中…', 0);
    const mono = await toMono22k(buffer);
    analysis = await runWorker(mono.getChannelData(0).slice(), entry.id, status);
    await storage.putAnalysis(entry.id, analysis);
  }
  await storage.putSong(entry);
  return { entry, buffer, analysis };
}
