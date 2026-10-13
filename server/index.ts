import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';
import { createYtDlp } from './ytdlp.ts';
import { createDemucsSeparator, findPython } from './separator.ts';

const port = Number(process.env.PORT ?? 5173);
const cacheDir = process.env.RG_CACHE ?? join(homedir(), '.cache', 'rhythm-game');
const staticDir = fileURLToPath(new URL('../dist', import.meta.url));
const ytdlp = createYtDlp(process.env.YTDLP ?? 'yt-dlp');
const python = findPython(fileURLToPath(new URL('..', import.meta.url)));
const separator = python ? createDemucsSeparator(python) : undefined;

const app = createApp({ cacheDir, ytdlp, separator, staticDir: process.env.RG_DEV ? undefined : staticDir });
app.listen(port, '127.0.0.1', async () => {
  const v = await ytdlp.version();
  console.log(`rhythm-game: http://127.0.0.1:${port}`);
  if (!v) console.warn('警告: yt-dlp が見つかりません。URL 取得は使えません(ファイルのドロップは使えます)');
  const ai = await separator?.probe();
  console.log(ai ? `AI 譜面: 有効 (${ai.device === 'cuda' ? 'GPU' : 'CPU'})` : 'AI 譜面: 無効 (npm run setup-ai で有効化できます)');
});
