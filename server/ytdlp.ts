import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface ProbeResult {
  id: string;
  title: string;
  duration: number;
  thumbnail: string | null;
}

export interface YtDlp {
  version(): Promise<string | null>;
  probe(url: string): Promise<ProbeResult>;
  /** Downloads the best audio stream into outDir and returns the file path. */
  download(url: string, outDir: string): Promise<string>;
}

export class YtDlpError extends Error {}

// The URL always goes after `--` so a value starting with `-` can never be read as an option.
export const buildProbeArgs = (url: string) => ['--no-playlist', '--no-warnings', '-J', '--', url];
export const buildDownloadArgs = (url: string, outDir: string) => [
  '--no-playlist', '--no-warnings', '-f', 'bestaudio', '-o', join(outDir, 'audio.%(ext)s'), '--', url,
];

export const sanitizeId = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100);

function run(bin: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', reject);
    p.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function errorSummary(stderr: string): string {
  const lines = stderr.split('\n').filter((l) => l.startsWith('ERROR'));
  return (lines.at(-1) ?? stderr.trim().split('\n').at(-1) ?? 'yt-dlp failed').slice(0, 300);
}

export function createYtDlp(bin = 'yt-dlp'): YtDlp {
  return {
    async version() {
      try {
        const r = await run(bin, ['--version']);
        return r.code === 0 ? r.stdout.trim() : null;
      } catch {
        return null;
      }
    },
    async probe(url) {
      const r = await run(bin, buildProbeArgs(url));
      if (r.code !== 0) throw new YtDlpError(errorSummary(r.stderr));
      const j = JSON.parse(r.stdout);
      if (j._type === 'playlist') throw new YtDlpError('プレイリストではなく単一の動画の URL を指定してください');
      return {
        id: sanitizeId(`${j.extractor_key ?? 'x'}-${j.id}`),
        title: String(j.title ?? j.id),
        duration: Number(j.duration ?? 0),
        thumbnail: j.thumbnail ?? null,
      };
    },
    async download(url, outDir) {
      const r = await run(bin, buildDownloadArgs(url, outDir));
      if (r.code !== 0) throw new YtDlpError(errorSummary(r.stderr));
      const f = (await readdir(outDir)).find((n) => n.startsWith('audio.') && !n.endsWith('.part'));
      if (!f) throw new YtDlpError('音声ファイルが見つかりませんでした');
      return join(outDir, f);
    },
  };
}
