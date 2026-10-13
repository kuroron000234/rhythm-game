import express from 'express';
import { AudioCache, isValidId, type SongMeta } from './cache.ts';
import { YtDlpError, type YtDlp } from './ytdlp.ts';

export const MAX_DURATION = 20 * 60;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function createApp(opts: { cacheDir: string; ytdlp: YtDlp; staticDir?: string }) {
  const cache = new AudioCache(opts.cacheDir);
  const inflight = new Map<string, Promise<SongMeta>>();
  const app = express();
  app.use(express.json());

  async function fetchSong(url: string): Promise<SongMeta> {
    const info = await opts.ytdlp.probe(url);
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
      else if (e instanceof YtDlpError) res.status(502).json({ error: e.message, hint: 'yt-dlp -U で更新すると直ることがあります' });
      else res.status(500).json({ error: String((e as Error)?.message ?? e) });
    }
  });

  app.get('/api/audio/:id', async (req, res) => {
    const { id } = req.params;
    if (!isValidId(id)) return void res.status(400).json({ error: 'invalid id' });
    const meta = await cache.get(id);
    if (!meta) return void res.status(404).json({ error: 'not found' });
    res.sendFile(cache.audioPath(meta));
  });

  app.get('/api/status', async (_req, res) => {
    res.json({ ytdlp: await opts.ytdlp.version() });
  });

  if (opts.staticDir) app.use(express.static(opts.staticDir));
  return app;
}
