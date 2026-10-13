import type { Analysis } from './analysis/analyze.ts';
import type { Difficulty } from './analysis/chart.ts';
import { chartFromOsu, parseOsuMania } from './analysis/osu.ts';
import { SR } from './analysis/params.ts';
import { aiKey, runWorker, serverStatus, toMono22k } from './loader.ts';
import { storage, type SongEntry } from './storage.ts';

export type AiStatus =
  | { state: 'queued' | 'analyzing' }
  | { state: 'running'; progress: number }
  | { state: 'ready'; analysis: Analysis }
  | { state: 'error'; error: string };

type Listener = (s: AiStatus) => void;
interface Job { status: AiStatus; listeners: Set<Listener> }
export type AiKind = 'mug' | 'stems' | null;

const POLL_MS = 2000;
const DIFFS: Difficulty[] = ['easy', 'normal', 'hard'];
const jobs = new Map<string, Job>();

let kind: Promise<AiKind> | null = null;
/** MuG (learned from human charts) is preferred; vocal-stem charts are the fallback. */
export const aiKind = () => (kind ??= serverStatus().then((s) => (s?.mug ? 'mug' : s?.ai ? 'stems' : null)));

/**
 * Starts (or joins) the background AI chart job for a song. It keeps running across screens;
 * listeners just observe it. `base` is the regular analysis (beats, pulse, duration are reused).
 */
export function watchAi(ctx: AudioContext, entry: SongEntry, base: Analysis, which: Exclude<AiKind, null>, listener: Listener): () => void {
  let job = jobs.get(entry.id);
  if (!job) {
    job = { status: { state: 'queued' }, listeners: new Set() };
    jobs.set(entry.id, job);
    void run(ctx, entry, base, which, job);
  }
  job.listeners.add(listener);
  listener(job.status);
  const j = job;
  return () => j.listeners.delete(listener);
}

function set(job: Job, s: AiStatus) {
  job.status = s;
  for (const l of job.listeners) l(s);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls a server job (`/api/<kind>/<id>`) until done, starting it when needed. */
async function waitFor(path: string, job: Job) {
  for (;;) {
    const s = await (await fetch(path)).json();
    if (s.state === 'done') return;
    if (s.state === 'error') throw new Error(s.error ?? 'AI 処理に失敗しました');
    if (s.state === 'none') {
      // not queued yet, or the server restarted and forgot the job
      const r = await fetch(path, { method: 'POST' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `AI 処理を開始できません (${r.status})`);
    }
    set(job, s.state === 'running' ? { state: 'running', progress: s.progress ?? 0 } : { state: 'queued' });
    await sleep(POLL_MS);
  }
}

async function run(ctx: AudioContext, entry: SongEntry, base: Analysis, which: Exclude<AiKind, null>, job: Job) {
  try {
    if (entry.source === 'file') {
      const bytes = await storage.getFile(entry.id);
      if (!bytes) throw new Error('音声データが見つかりません');
      const r = await fetch(`/api/upload/${entry.id}`, {
        method: 'POST', body: bytes, headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(entry.title) },
      });
      if (!r.ok) throw new Error(`アップロードに失敗しました (${r.status})`);
    }
    let analysis: Analysis;
    if (which === 'mug') {
      await waitFor(`/api/mug/${entry.id}`, job);
      set(job, { state: 'analyzing' });
      const texts = await Promise.all(DIFFS.map(async (d) => {
        const r = await fetch(`/api/mug/${entry.id}/${d}`);
        if (!r.ok) throw new Error('MuG の譜面を取得できません');
        return r.text();
      }));
      const charts = Object.fromEntries(DIFFS.map((d, i) => [d, chartFromOsu(parseOsuMania(texts[i]), base.beats, d, base.bpm)])) as Analysis['charts'];
      analysis = { ...base, source: 'mug', charts };
    } else {
      await waitFor(`/api/stems/${entry.id}`, job);
      set(job, { state: 'analyzing' });
      const [vocals, accomp] = await Promise.all(['vocals', 'accomp'].map(async (stem) => {
        const r = await fetch(`/api/stems/${entry.id}/${stem}`);
        if (!r.ok) throw new Error('分離した音声を取得できません');
        const buf = await toMono22k(await ctx.decodeAudioData(await r.arrayBuffer()));
        return buf.getChannelData(0).slice();
      }));
      analysis = await runWorker({ mode: 'ai', vocals, accomp, sr: SR, seed: entry.id }, () => {});
    }
    await storage.putAnalysis(aiKey(entry.id), analysis);
    set(job, { state: 'ready', analysis });
  } catch (e) {
    set(job, { state: 'error', error: String((e as Error)?.message ?? e) });
    jobs.delete(entry.id); // allow a retry next time the song is opened
  }
}
