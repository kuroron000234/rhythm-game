import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../server/app.ts';
import type { YtDlp } from '../server/ytdlp.ts';
import { buildMugArgs, MUG_DIFFICULTIES, type MugRunner } from '../server/mug.ts';

const ytdlp: YtDlp = {
  async version() { return 'x'; },
  async probe() { return { id: 'a', title: 'T', duration: 1, thumbnail: null }; },
  async download() { return ''; },
};

function fakeMug(fail = false) {
  const calls: string[] = [];
  const m: MugRunner & { calls: string[] } = {
    calls,
    async probe() { return { device: 'cuda' }; },
    async generate(audio, outDir, onProgress) {
      calls.push(audio);
      onProgress(0.5);
      await new Promise((r) => setTimeout(r, 10));
      if (fail) throw new Error('mug failed');
      for (const d of MUG_DIFFICULTIES) await writeFile(join(outDir, `${d}.osu`), `chart ${d}`);
    },
  };
  return m;
}

let dir: string, server: Server, base: string;
async function start(mug?: MugRunner) {
  server = createApp({ cacheDir: dir, ytdlp, mug }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function addSong(id: string) {
  await mkdir(join(dir, id), { recursive: true });
  await writeFile(join(dir, id, 'audio.webm'), 'A');
  await writeFile(join(dir, id, 'meta.json'), JSON.stringify({ id, title: id, duration: 1, thumbnail: null, file: 'audio.webm' }));
}
async function until(id: string, state: string) {
  for (let i = 0; i < 200; i++) {
    const s = await (await fetch(`${base}/api/mug/${id}`)).json();
    if (s.state === state) return s;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`never reached ${state}`);
}

beforeEach(async () => { dir = join(await mkdtemp(join(tmpdir(), 'rg-')), '.cache'); await mkdir(dir, { recursive: true }); });
afterEach(async () => { server?.close(); await rm(dir, { recursive: true, force: true }); });

describe('MuG chart API', () => {
  it('reports MuG availability in /api/status', async () => {
    await start(fakeMug());
    expect((await (await fetch(`${base}/api/status`)).json()).mug).toEqual({ device: 'cuda' });
  });

  it('generates once and serves each difficulty', async () => {
    const mug = fakeMug();
    await start(mug);
    await addSong('song-a');
    expect((await fetch(`${base}/api/mug/song-a`, { method: 'POST' })).status).toBe(202);
    await fetch(`${base}/api/mug/song-a`, { method: 'POST' });
    await until('song-a', 'done');
    expect(await (await fetch(`${base}/api/mug/song-a/hard`)).text()).toBe('chart hard');
    expect((await fetch(`${base}/api/mug/song-a/expert`)).status).toBe(400);
    expect(mug.calls.length).toBe(1);
  });

  it('reports failures and 503 without MuG', async () => {
    await start(fakeMug(true));
    await addSong('song-a');
    await fetch(`${base}/api/mug/song-a`, { method: 'POST' });
    expect((await until('song-a', 'error')).error).toContain('mug failed');
    server.close();
    await start(undefined);
    expect((await fetch(`${base}/api/mug/song-a`, { method: 'POST' })).status).toBe(503);
  });
});

describe('mug args', () => {
  it('puts the audio path last and passes one star rating per difficulty', () => {
    const a = buildMugArgs('/x/mug_cli.py', '-evil.mp3', '/out');
    expect(a[0]).toBe('/x/mug_cli.py');
    expect(a).toContain('--sr');
    expect(a.slice(-2)).toEqual(['--', '-evil.mp3']);
  });
});
