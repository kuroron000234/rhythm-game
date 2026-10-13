import express from 'express';
import { AudioCache, isValidId, type SongMeta } from './cache.ts';
import { YtDlpError, type YtDlp } from './ytdlp.ts';
import { FileJobs } from './jobs.ts';
import { MUG_DIFFICULTIES, MUG_SUBDIR, type MugRunner } from './mug.ts';
import type { Separator } from './separator.ts';
import { writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

export const MAX_DURATION = 20 * 60;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Turns yt-dlp's stderr into a short message plus a hint that fits the failure. */
export function describeYtDlpError(raw: string): { error: string; hint: string } {
  const error = raw
    .replace(/^ERROR:\s*(\[[^\]]+\]\s*)?([\w-]+:\s)?/, '')
    .replace(/\s*Use --cookies.*$/s, '')
    .trim();
  const hint = /confirm your age|age-restricted|Sign in/i.test(raw)
    ? '年齢制限やログインが必要な動画は取得できません'
    : /not a valid URL|Unsupported URL/i.test(raw)
      ? 'URL が正しいか確認してください'
      : /unavailable|private|removed/i.test(raw)
        ? '動画が非公開・削除済み、または地域制限の可能性があります'
        : 'yt-dlp -U で更新すると直ることがあります';
  return { error: error || raw, hint };
}

const STEMS = ['vocals', 'accomp'] as const;

export function createApp(opts: { cacheDir: string; ytdlp: YtDlp; separator?: Separator; mug?: MugRunner; staticDir?: string }) {
  const cache = new AudioCache(opts.cacheDir);
  const inflight = new Map<string, Promise<SongMeta>>();
  /** url → id, so replaying a cached song skips the (slow, networked) probe. */
  const known = new Map<string, string>();
  const sep = opts.separator;
  const jobs = sep ? new FileJobs(opts.cacheDir, {
    subdir: 'stems', files: STEMS.map((s) => `${s}.flac`),
    run: async (audio, out, progress) => { await sep.separate(audio, out, progress); },
  }) : null;
  const mug = opts.mug;
  const mugJobs = mug ? new FileJobs(opts.cacheDir, {
    subdir: MUG_SUBDIR, files: MUG_DIFFICULTIES.map((d) => `${d}.osu`), run: (audio, out, progress) => mug.generate(audio, out, progress),
  }) : null;
  const app = express();
  app.use(express.json());

  async function fetchSong(url: string): Promise<SongMeta> {
    const knownId = known.get(url);
    const hit = knownId && (await cache.get(knownId));
    if (hit) return hit;
    const info = await opts.ytdlp.probe(url);
    known.set(url, info.id);
    const cached = await cache.get(info.id);
    if (cached) return cached;
    if (info.duration > MAX_DURATION) throw new HttpError(400, '20 分を超える動画は扱えません');
    let p = inflight.get(info.id);
    if (!p) {
      p = cache
        .put(info.id, async (tmp) => ({ ...info, path: await opts.ytdlp.download(url, tmp) }))
        .finally(() => inflight.delete(info.id));
      inflight.set(info.id, p);
    }
    return p;
  }

  app.post('/api/fetch', async (req, res) => {
    const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    try {
      if (!url) throw new HttpError(400, 'URL を入力してください');
      const { file: _file, ...meta } = await fetchSong(url);
      res.json(meta);
    } catch (e) {
      if (e instanceof HttpError) res.status(e.status).json({ error: e.message });
      else if (e instanceof YtDlpError) res.status(502).json(describeYtDlpError(e.message));
      else res.status(500).json({ error: String((e as Error)?.message ?? e) });
    }
  });

  app.get('/api/audio/:id', async (req, res) => {
    const { id } = req.params;
    if (!isValidId(id)) return void res.status(400).json({ error: 'invalid id' });
    const meta = await cache.get(id);
    if (!meta) return void res.status(404).json({ error: 'not found' });
    // the default cache dir is ~/.cache, which send() would otherwise refuse as a dotfile path
    res.sendFile(cache.audioPath(meta), { dotfiles: 'allow' });
  });

  app.get('/api/status', async (_req, res) => {
    const [ytdlp, ai, mugStatus] = await Promise.all([opts.ytdlp.version(), opts.separator?.probe() ?? null, mug?.probe() ?? null]);
    res.json({ ytdlp, ai, mug: mugStatus });
  });

  // dropped files are uploaded so they can be separated too
  app.post('/api/upload/:id', express.raw({ type: () => true, limit: '300mb' }), async (req, res) => {
    const { id } = req.params;
    if (!isValidId(id) || !id.startsWith('file-')) return void res.status(400).json({ error: 'invalid id' });
    if (!(await cache.get(id))) {
      const name = decodeURIComponent(String(req.headers['x-filename'] ?? 'audio'));
      const ext = (extname(name) || '.bin').replace(/[^.\w]/g, '').slice(0, 8);
      await cache.put(id, async (tmp) => {
        const path = join(tmp, `audio${ext}`);
        await writeFile(path, req.body as Buffer);
        return { id, title: name.replace(/\.[^.]+$/, ''), duration: 0, thumbnail: null, path };
      });
    }
    res.json({ ok: true });
  });

  app.get('/api/stems/:id', async (req, res) => {
    const { id } = req.params;
    if (!isValidId(id)) return void res.status(400).json({ error: 'invalid id' });
    if (!jobs) return void res.json({ state: 'none' });
    res.json(await jobs.status(id));
  });

  app.post('/api/stems/:id', async (req, res) => {
    const { id } = req.params;
    if (!isValidId(id)) return void res.status(400).json({ error: 'invalid id' });
    if (!jobs || !(await opts.separator!.probe())) return void res.status(503).json({ error: 'AI 分離は使えません' });
    const meta = await cache.get(id);
    if (!meta) return void res.status(404).json({ error: 'not found' });
    res.status(202).json(await jobs.enqueue(id, cache.audioPath(meta)));
  });

  app.get('/api/stems/:id/:stem', async (req, res) => {
    const { id, stem } = req.params;
    if (!isValidId(id) || !(STEMS as readonly string[]).includes(stem)) return void res.status(400).json({ error: 'invalid' });
    if (!jobs || (await jobs.status(id)).state !== 'done') return void res.status(404).json({ error: 'not ready' });
    res.sendFile(jobs.path(id, `${stem}.flac`), { dotfiles: 'allow' });
  });

  // MuG Diffusion: charts learned from human-made 4K maps
  app.get('/api/mug/:id', async (req, res) => {
    const { id } = req.params;
    if (!isValidId(id)) return void res.status(400).json({ error: 'invalid id' });
    res.json(mugJobs ? await mugJobs.status(id) : { state: 'none' });
  });

  app.post('/api/mug/:id', async (req, res) => {
    const { id } = req.params;
    if (!isValidId(id)) return void res.status(400).json({ error: 'invalid id' });
    if (!mugJobs || !(await mug!.probe())) return void res.status(503).json({ error: 'MuG は使えません' });
    const meta = await cache.get(id);
    if (!meta) return void res.status(404).json({ error: 'not found' });
    res.status(202).json(await mugJobs.enqueue(id, cache.audioPath(meta)));
  });

  app.get('/api/mug/:id/:difficulty', async (req, res) => {
    const { id, difficulty } = req.params;
    if (!isValidId(id) || !(MUG_DIFFICULTIES as readonly string[]).includes(difficulty)) return void res.status(400).json({ error: 'invalid' });
    if (!mugJobs || (await mugJobs.status(id)).state !== 'done') return void res.status(404).json({ error: 'not ready' });
    res.type('text/plain').sendFile(mugJobs.path(id, `${difficulty}.osu`), { dotfiles: 'allow' });
  });

  if (opts.staticDir) app.use(express.static(opts.staticDir));
  return app;
}
