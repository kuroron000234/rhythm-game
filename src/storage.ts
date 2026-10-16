import type { Analysis } from './analysis/analyze.ts';
import type { Difficulty } from './analysis/chart.ts';
import type { Rank } from './game/judge.ts';

export interface SongEntry {
  id: string;
  title: string;
  duration: number;
  thumbnail: string | null;
  source: 'url' | 'file' | 'audius';
  url?: string;
  /** Audius tracks: artist name and the public track page (shown as credit). */
  artist?: string;
  link?: string;
  lastPlayed: number;
}

export interface BestScore {
  score: number;
  rank: Rank;
  maxCombo: number;
  fullCombo: boolean;
  allPerfect: boolean;
  cleared: boolean;
  at: number;
}

export interface Settings {
  /** Added to input times before judging (ms). Positive when you tend to hit late. */
  judgeOffset: number;
  /** Shifts note drawing (ms). */
  visualOffset: number;
  /** Hi-speed, 1–12. */
  speed: number;
  /** KeyboardEvent.code per lane. */
  keys: [string, string, string, string];
  volume: number;
  hitSound: boolean;
  hitVolume: number;
}

export const DEFAULT_SETTINGS: Settings = {
  judgeOffset: 0, visualOffset: 0, speed: 8, keys: ['KeyD', 'KeyF', 'KeyJ', 'KeyK'],
  volume: 0.8, hitSound: true, hitVolume: 0.5,
};

const STORES = ['songs', 'analyses', 'scores', 'settings', 'files'] as const;
type StoreName = (typeof STORES)[number];

interface KV {
  get<T>(store: StoreName, key: string): Promise<T | undefined>;
  put(store: StoreName, key: string, value: unknown): Promise<void>;
  all<T>(store: StoreName): Promise<T[]>;
  del(store: StoreName, key: string): Promise<void>;
}

function memoryKV(): KV {
  const m = new Map<string, Map<string, unknown>>(STORES.map((s) => [s, new Map()]));
  return {
    async get(s, k) { return m.get(s)!.get(k) as never; },
    async put(s, k, v) { m.get(s)!.set(k, v); },
    async all(s) { return [...m.get(s)!.values()] as never; },
    async del(s, k) { m.get(s)!.delete(k); },
  };
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

async function idbKV(): Promise<KV> {
  const open = indexedDB.open('rhythm-game', 1);
  open.onupgradeneeded = () => { for (const s of STORES) open.result.createObjectStore(s); };
  const db = await req(open);
  const tx = (s: StoreName, mode: IDBTransactionMode) => db.transaction(s, mode).objectStore(s);
  return {
    get: (s, k) => req(tx(s, 'readonly').get(k)),
    put: async (s, k, v) => { await req(tx(s, 'readwrite').put(v, k)); },
    all: (s) => req(tx(s, 'readonly').getAll()),
    del: async (s, k) => { await req(tx(s, 'readwrite').delete(k)); },
  };
}

let kvPromise: Promise<KV> | null = null;
/** Falls back to an in-memory store when IndexedDB is unavailable (private mode etc.). */
function kv(): Promise<KV> {
  return (kvPromise ??= idbKV().catch((e) => {
    console.warn('IndexedDB unavailable, scores will not persist', e);
    return memoryKV();
  }));
}

const safe = async <T>(f: (k: KV) => Promise<T>, fallback: T): Promise<T> => {
  try { return await f(await kv()); } catch (e) { console.warn(e); return fallback; }
};

export const storage = {
  getSettings: () => safe(async (k) => ({ ...DEFAULT_SETTINGS, ...(await k.get<Settings>('settings', 'settings')) }), DEFAULT_SETTINGS),
  putSettings: (s: Settings) => safe((k) => k.put('settings', 'settings', s), undefined),
  getSongs: () => safe(async (k) => (await k.all<SongEntry>('songs')).sort((a, b) => b.lastPlayed - a.lastPlayed), []),
  putSong: (e: SongEntry) => safe((k) => k.put('songs', e.id, e), undefined),
  getAnalysis: (id: string) => safe((k) => k.get<Analysis>('analyses', id), undefined),
  putAnalysis: (id: string, a: Analysis) => safe((k) => k.put('analyses', id, a), undefined),
  getBest: (id: string, d: Difficulty) => safe((k) => k.get<BestScore>('scores', `${id}:${d}`), undefined),
  putBest: (id: string, d: Difficulty, s: BestScore) => safe((k) => k.put('scores', `${id}:${d}`, s), undefined),
  getFile: (id: string) => safe((k) => k.get<ArrayBuffer>('files', id), undefined),
  putFile: (id: string, b: ArrayBuffer) => safe((k) => k.put('files', id, b), undefined),
  deleteFile: (id: string) => safe((k) => k.del('files', id), undefined),
};
