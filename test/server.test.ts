import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../server/app.ts';
import type { YtDlp, ProbeResult } from '../server/ytdlp.ts';
import { buildProbeArgs, buildDownloadArgs, YtDlpError } from '../server/ytdlp.ts';

function fakeYtDlp(probe: Partial<ProbeResult> = {}) {
  const calls = { probe: 0, download: 0 };
  const y: YtDlp & { calls: typeof calls; fail?: string } = {
    calls,
    async version() { return '2026.08.19'; },
    async probe() {
      calls.probe++;
      if (y.fail) throw new YtDlpError(y.fail);
      return { id: 'youtube-abc123', title: 'Song', duration: 200, thumbnail: 'http://x/t.jpg', ...probe };
    },
    async download(_url, outDir) {
      calls.download++;
      await new Promise((r) => setTimeout(r, 30));
      const p = join(outDir, 'audio.webm');
      await writeFile(p, Buffer.from('AUDIO'));
      return p;
    },
  };
  return y;
}

let dir: string;
let server: Server;
let base: string;
async function start(y: YtDlp) {
  server = createApp({ cacheDir: dir, ytdlp: y }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const post = (url: string) =>
  fetch(`${base}/api/fetch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) });

// the real cache lives under ~/.cache, so test inside a dot-directory too
beforeEach(async () => { dir = join(await mkdtemp(join(tmpdir(), 'rg-')), '.cache'); });
afterEach(async () => { server?.close(); await rm(dir, { recursive: true, force: true }); });

describe('server', () => {
  it('downloads once and serves from cache afterwards', async () => {
    const y = fakeYtDlp();
    await start(y);
    const r1 = await post('https://youtu.be/abc123');
    expect(r1.status).toBe(200);
    const meta = await r1.json();
    expect(meta).toMatchObject({ id: 'youtube-abc123', title: 'Song', duration: 200 });
    const r2 = await post('https://youtu.be/abc123');
    expect(r2.status).toBe(200);
    expect(y.calls.download).toBe(1);
    const audio = await fetch(`${base}/api/audio/youtube-abc123`);
    expect(audio.status).toBe(200);
    expect(await audio.text()).toBe('AUDIO');
  });

  it('shares an in-flight download between concurrent requests', async () => {
    const y = fakeYtDlp();
    await start(y);
    const [a, b] = await Promise.all([post('https://youtu.be/abc123'), post('https://youtu.be/abc123')]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(y.calls.download).toBe(1);
  });

  it('rejects videos longer than 20 minutes', async () => {
    const y = fakeYtDlp({ duration: 1201 });
    await start(y);
    const r = await post('https://youtu.be/long');
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/20/);
    expect(y.calls.download).toBe(0);
  });

  it('reports yt-dlp failures as 502 with the message', async () => {
    const y = fakeYtDlp();
    y.fail = 'ERROR: Video unavailable';
    await start(y);
    const r = await post('https://youtu.be/x');
    expect(r.status).toBe(502);
    expect((await r.json()).error).toContain('Video unavailable');
  });

  it('rejects missing url and invalid audio ids', async () => {
    await start(fakeYtDlp());
    expect((await post('')).status).toBe(400);
    expect((await fetch(`${base}/api/audio/..%2Fetc`)).status).toBe(400);
    expect((await fetch(`${base}/api/audio/youtube-nothere`)).status).toBe(404);
  });

  it('remembers url → id so a cached song does not need another probe', async () => {
    const y = fakeYtDlp();
    await start(y);
    await post('https://youtu.be/abc123');
    await post('https://youtu.be/abc123');
    expect(y.calls.probe).toBe(1);
  });

  it('gives a specific hint for age-restricted videos', async () => {
    const y = fakeYtDlp();
    y.fail = 'ERROR: [youtube] abc: Sign in to confirm your age. Use --cookies-from-browser or --cookies for the authentication.';
    await start(y);
    const j = await (await post('https://youtu.be/abc')).json();
    expect(j.error).toBe('Sign in to confirm your age.');
    expect(j.hint).toMatch(/年齢制限/);
  });

  it('reports yt-dlp version on /api/status', async () => {
    await start(fakeYtDlp());
    expect(await (await fetch(`${base}/api/status`)).json()).toEqual({ ytdlp: '2026.08.19', ai: null });
  });
});

describe('yt-dlp args', () => {
  it('always places the url after -- to prevent option injection', () => {
    const evil = '--exec=rm -rf ~';
    for (const args of [buildProbeArgs(evil), buildDownloadArgs(evil, '/tmp/o')]) {
      expect(args.at(-1)).toBe(evil);
      expect(args.at(-2)).toBe('--');
      expect(args).toContain('--no-playlist');
    }
  });
});
