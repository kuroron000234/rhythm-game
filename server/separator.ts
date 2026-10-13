import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

export interface Separator {
  /** null when Demucs/torch are not usable on this machine. */
  probe(): Promise<{ device: 'cuda' | 'cpu' } | null>;
  /** Writes mono 22050Hz FLAC stems into outDir. */
  separate(audio: string, outDir: string, onProgress: (p: number) => void): Promise<{ vocals: string; accomp: string }>;
}

export const buildDemucsArgs = (audio: string, outDir: string, device: string) => [
  '-m', 'demucs', '-n', 'htdemucs', '--two-stems', 'vocals', '-d', device, '-o', outDir, '--', audio,
];

/** RG_PYTHON, else the venv made by `npm run setup-ai`. */
export function findPython(projectRoot: string): string | null {
  if (process.env.RG_PYTHON) return process.env.RG_PYTHON;
  const venv = join(projectRoot, '.venv-ai', 'bin', 'python');
  return existsSync(venv) ? venv : null;
}

function run(bin: string, args: string[], onStderr?: (s: string) => void): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => { err += d; onStderr?.(String(d)); });
    p.on('error', reject);
    p.on('close', (code) => resolve({ code: code ?? 1, out, err }));
  });
}

const lastLine = (s: string) => s.trim().split('\n').filter(Boolean).at(-1)?.slice(0, 300) ?? 'unknown error';

export function createDemucsSeparator(python: string, ffmpeg = 'ffmpeg'): Separator {
  let probed: Promise<{ device: 'cuda' | 'cpu' } | null> | null = null;
  return {
    probe() {
      return (probed ??= run(python, ['-c', "import demucs, torch; print('cuda' if torch.cuda.is_available() else 'cpu')"])
        .then((r) => (r.code === 0 ? { device: r.out.trim().split('\n').at(-1) === 'cuda' ? 'cuda' as const : 'cpu' as const } : null))
        .catch(() => null));
    },
    async separate(audio, outDir, onProgress) {
      const dev = await this.probe();
      if (!dev) throw new Error('Demucs is not available');
      const raw = join(outDir, 'raw');
      const r = await run(python, buildDemucsArgs(audio, raw, dev.device), (s) => {
        // tqdm: " 42%|████"
        const m = [...s.matchAll(/(\d+(?:\.\d+)?)%\|/g)].at(-1);
        if (m) onProgress(Number(m[1]) / 100);
      });
      if (r.code !== 0) throw new Error(lastLine(r.err));
      const modelDir = join(raw, 'htdemucs');
      const [track] = await readdir(modelDir);
      const out = { vocals: join(outDir, 'vocals.flac'), accomp: join(outDir, 'accomp.flac') };
      for (const [src, dst] of [['vocals.wav', out.vocals], ['no_vocals.wav', out.accomp]]) {
        const c = await run(ffmpeg, ['-v', 'error', '-y', '-i', join(modelDir, track, src), '-ac', '1', '-ar', '22050', '-c:a', 'flac', dst]);
        if (c.code !== 0) throw new Error(lastLine(c.err));
      }
      await rm(raw, { recursive: true, force: true });
      return out;
    },
  };
}
