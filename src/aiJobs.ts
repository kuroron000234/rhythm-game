import type { Analysis } from './analysis/analyze.ts';
import { SR } from './analysis/params.ts';
import { aiKey, runWorker, serverStatus, toMono22k } from './loader.ts';
import { storage, type SongEntry } from './storage.ts';

export type AiStatus =
  | { state: 'queued' | 'analyzing' }
  | { state: 'running'; progress: number }
  | { state: 'ready'; analysis: Analysis }
  | { state: 'error'; error: string };

type Listener = (s: AiStatus) => void;

const POLL_MS = 2000;
const jobs = new Map<string, { status: AiStatus; listeners: Set<Listener> }>();

/**
 * Asks the server to separate the song, waits for it in the background (across screens) and
 * builds the vocal-driven analysis when the stems are ready. One job per song id.
 */
export function watchAi(ctx: AudioContext, entry: SongEntry, listener: Listener): () => void {
  let job = jobs.get(entry.id);
  if (!job) {
    job = { status: { state: 'queued' }, listeners: new Set() };
    jobs.set(entry.id, job);
    void run(ctx, entry, job);
  }
  job.listeners.add(listener);
  listener(job.status);
  const j = job;
  return () => j.listeners.delete(listener);
}

function set(job: { status: AiStatus; listeners: Set<Listener> }, s: AiStatus) {
  job.status = s;
  for (const l of job.listeners) l(s);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run(ctx: AudioContext, entry: SongEntry, job: { status: AiStatus; listeners: Set<Listener> }) {
  try {
    if (entry.source === 'file') {
      const bytes = await storage.getFile(entry.id);
      if (!bytes) throw new Error('音声データが見つかりません');
      const r = await fetch(`/api/upload/${entry.id}`, {
        method: 'POST', body: bytes, headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(entry.title) },
      });
      if (!r.ok) throw new Error(`アップロードに失敗しました (${r.status})`);
    }
    for (;;) {
      const s = await (await fetch(`/api/stems/${entry.id}`)).json();
      if (s.state === 'done') break;
      if (s.state === 'error') throw new Error(s.error ?? 'AI 分離に失敗しました');
      if (s.state === 'none') {
        // not queued yet, or the server restarted and forgot the job
        const r = await fetch(`/api/stems/${entry.id}`, { method: 'POST' });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `AI 分離を開始できません (${r.status})`);
      }
      set(job, s.state === 'running' ? { state: 'running', progress: s.progress ?? 0 } : { state: 'queued' });
      await sleep(POLL_MS);
    }
    set(job, { state: 'analyzing' });
    const [vocals, accomp] = await Promise.all(['vocals', 'accomp'].map(async (stem) => {
      const r = await fetch(`/api/stems/${entry.id}/${stem}`);
      if (!r.ok) throw new Error('分離した音声を取得できません');
      const buf = await toMono22k(await ctx.decodeAudioData(await r.arrayBuffer()));
      return buf.getChannelData(0).slice();
    }));
    const analysis = await runWorker({ mode: 'ai', vocals, accomp, sr: SR, seed: entry.id }, () => {});
    await storage.putAnalysis(aiKey(entry.id), analysis);
    set(job, { state: 'ready', analysis });
  } catch (e) {
    set(job, { state: 'error', error: String((e as Error)?.message ?? e) });
    jobs.delete(entry.id); // allow a retry next time the song is opened
  }
}

let available: Promise<boolean> | null = null;
export const aiAvailable = () => (available ??= serverStatus().then((s) => !!s?.ai));
