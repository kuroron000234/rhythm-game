import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../server/app.ts';
import type { YtDlp } from '../server/ytdlp.ts';
import { buildDemucsArgs, type Separator } from '../server/separator.ts';

const ytdlp: YtDlp = {
  async version() { return 'x'; },
  async probe() { return { id: 'youtube-abc', title: 'T', duration: 100, thumbnail: null }; },
  async download(_u, dir) { const p = join(dir, 'audio.webm'); await writeFile(p, 'A'); return p; },
};

function fakeSeparator(opts: { fail?: (audio: string) => boolean; delay?: number } = {}) {
  const calls: string[] = [];
  let release: (() => void) | null = null;
  const sep: Separator & { calls: string[]; gate: Promise<void> | null; open: () => void } = {
    calls, gate: null,
    open: () => release?.(),
    async probe() { return { device: 'cpu' }; },
    async separate(audio, outDir, onProgress) {
      calls.push(audio);
      onProgress(0.5);
      if (sep.gate) await sep.gate;
      await new Promise((r) => setTimeout(r, opts.delay ?? 10));
      if (opts.fail?.(audio)) throw new Error('demucs exploded');
      const v = join(outDir, 'vocals.flac'), a = join(outDir, 'accomp.flac');
      await writeFile(v, 'V'); await writeFile(a, 'B');
      return { vocals: v, accomp: a };
    },
  };
  sep.gate = new Promise<void>((r) => (release = r));
  sep.open();
  sep.gate = null;
  return sep;
}

let dir: string, server: Server, base: string;
async function start(separator?: Separator) {
  server = createApp({ cacheDir: dir, ytdlp, separator }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const json = async (r: Promise<Response>) => (await r).json();
const status = (id: string) => json(fetch(`${base}/api/stems/${id}`));
const enqueue = (id: string) => fetch(`${base}/api/stems/${id}`, { method: 'POST' });
async function until(id: string, state: string) {
  for (let i = 0; i < 200; i++) { const s = await status(id); if (s.state === state) return s; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error(`never reached ${state}`);
}
async function addSong(id: string) {
  await mkdir(join(dir, id), { recursive: true });
  await writeFile(join(dir, id, 'audio.webm'), 'A');
  await writeFile(join(dir, id, 'meta.json'), JSON.stringify({ id, title: id, duration: 1, thumbnail: null, file: 'audio.webm' }));
}

beforeEach(async () => { dir = join(await mkdtemp(join(tmpdir(), 'rg-')), '.cache'); await mkdir(dir, { recursive: true }); });
afterEach(async () => { server?.close(); await rm(dir, { recursive: true, force: true }); });

describe('stem separation API', () => {
  it('reports AI availability in /api/status', async () => {
    await start(fakeSeparator());
    expect(await json(fetch(`${base}/api/status`))).toEqual({ ytdlp: 'x', ai: { device: 'cpu' } });
  });

  it('goes none → queued/running → done and serves the stems', async () => {
    const sep = fakeSeparator();
    await start(sep);
    await addSong('song-a');
    expect(await status('song-a')).toEqual({ state: 'none' });
    expect((await enqueue('song-a')).status).toBe(202);
    await until('song-a', 'done');
    const v = await fetch(`${base}/api/stems/song-a/vocals`);
    expect(v.status).toBe(200);
    expect(await v.text()).toBe('V');
    expect(await (await fetch(`${base}/api/stems/song-a/accomp`)).text()).toBe('B');
    expect((await fetch(`${base}/api/stems/song-a/drums`)).status).toBe(400);
  });

  it('does not run the same song twice and remembers results on disk', async () => {
    const sep = fakeSeparator({ delay: 50 });
    await start(sep);
    await addSong('song-a');
    await Promise.all([enqueue('song-a'), enqueue('song-a')]);
    await until('song-a', 'done');
    await enqueue('song-a');
    expect(sep.calls.length).toBe(1);
    server.close();
    await start(fakeSeparator()); // fresh process: state comes from disk
    expect(await status('song-a')).toEqual({ state: 'done' });
  });

  it('keeps the queue moving after a failure', async () => {
    const sep = fakeSeparator({ fail: (a) => a.includes('bad') });
    await start(sep);
    await addSong('bad-song');
    await addSong('good-song');
    await enqueue('bad-song');
    await enqueue('good-song');
    const s = await until('bad-song', 'error');
    expect(s.error).toContain('demucs exploded');
    await until('good-song', 'done');
  });

  it('returns 404 for unknown songs and 503 without AI', async () => {
    await start(fakeSeparator());
    expect((await enqueue('nope')).status).toBe(404);
    server.close();
    await start(undefined);
    await addSong('song-a');
    expect((await enqueue('song-a')).status).toBe(503);
    expect((await json(fetch(`${base}/api/status`))).ai).toBeNull();
  });

  it('accepts an uploaded file under its file- id', async () => {
    await start(fakeSeparator());
    const r = await fetch(`${base}/api/upload/file-0123abcd`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent('曲.mp3') }, body: new Uint8Array([1, 2, 3]),
    });
    expect(r.status).toBe(200);
    expect(new Uint8Array(await (await fetch(`${base}/api/audio/file-0123abcd`)).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect((await enqueue('file-0123abcd')).status).toBe(202);
    expect((await fetch(`${base}/api/upload/youtube-x`, { method: 'POST', body: new Uint8Array([1]) })).status).toBe(400);
  });
});

describe('demucs args', () => {
  it('puts the audio path after --', () => {
    const a = buildDemucsArgs('-evil.mp3', '/o', 'cuda');
    expect(a.slice(-2)).toEqual(['--', '-evil.mp3']);
    expect(a).toEqual(expect.arrayContaining(['--two-stems', 'vocals', '-d', 'cuda', '-n', 'htdemucs']));
  });
});
