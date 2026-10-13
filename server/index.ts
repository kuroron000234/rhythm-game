import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';
import { createYtDlp } from './ytdlp.ts';

const port = Number(process.env.PORT ?? 5173);
const cacheDir = process.env.RG_CACHE ?? join(homedir(), '.cache', 'rhythm-game');
const staticDir = fileURLToPath(new URL('../dist', import.meta.url));
const ytdlp = createYtDlp(process.env.YTDLP ?? 'yt-dlp');

const app = createApp({ cacheDir, ytdlp, staticDir: process.env.RG_DEV ? undefined : staticDir });
app.listen(port, '127.0.0.1', async () => {
  const v = await ytdlp.version();
  console.log(`rhythm-game: http://127.0.0.1:${port}`);
  if (!v) console.warn('警告: yt-dlp が見つかりません。URL 取得は使えません(ファイルのドロップは使えます)');
});
