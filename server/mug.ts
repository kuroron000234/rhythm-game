import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Star ratings (osu!) requested per difficulty; tuned so densities land near ~2 / 4.5 / 7 notes/s. */
export const MUG_DIFFICULTIES = ['easy', 'normal', 'hard'] as const;
export const MUG_STAR_RATINGS = [1.3, 2.2, 3.2];
/** Cache subdir; changes with the ratings so retuned difficulties are regenerated. */
export const MUG_SUBDIR = `mug-${MUG_STAR_RATINGS.join('-')}`;

export interface MugRunner {
  probe(): Promise<{ device: 'cuda' | 'cpu' } | null>;
  /** Writes <difficulty>.osu for each of MUG_DIFFICULTIES into outDir. */
  generate(audio: string, outDir: string, onProgress: (p: number) => void): Promise<void>;
}

export const buildMugArgs = (cli: string, audio: string, outDir: string) => [
  cli, '--out', outDir, '--sr', ...MUG_STAR_RATINGS.map(String), '--names', ...MUG_DIFFICULTIES, '--', audio,
];

/** The checkout made by `npm run setup-mug`: <root>/.mug with its own venv and weights. */
export function findMug(projectRoot: string): { python: string; cli: string } | null {
  const dir = process.env.RG_MUG_DIR ?? join(projectRoot, '.mug');
  const python = join(dir, '.venv', 'bin', 'python');
  const cli = join(dir, 'mug_cli.py');
  return existsSync(python) && existsSync(cli) && existsSync(join(dir, 'models', 'ckpt', 'model.ckpt')) ? { python, cli } : null;
}

function run(bin: string, args: string[], onLine?: (l: string) => void) {
  return new Promise<{ code: number; err: string }>((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1' } });
    let out = '', err = '';
    p.stdout.on('data', (d) => {
      out += d;
      const lines = out.split('\n');
      out = lines.pop()!;
      lines.forEach((l) => onLine?.(l));
    });
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => resolve({ code: code ?? 1, err }));
  });
}

export function createMugRunner(python: string, cli: string): MugRunner {
  let probed: Promise<{ device: 'cuda' | 'cpu' } | null> | null = null;
  return {
    probe() {
      return (probed ??= new Promise((resolve) => {
        const p = spawn(python, ['-c', "import torch; print('cuda' if torch.cuda.is_available() else 'cpu')"]);
        let out = '';
        p.stdout.on('data', (d) => (out += d));
        p.on('error', () => resolve(null));
        p.on('close', (code) => resolve(code === 0 ? { device: out.trim() === 'cuda' ? 'cuda' : 'cpu' } : null));
      }));
    },
    async generate(audio, outDir, onProgress) {
      const r = await run(python, buildMugArgs(cli, audio, outDir), (line) => {
        try {
          const m = JSON.parse(line);
          if (m.stage === 'loaded') onProgress(0.1);
          if (m.stage === 'chart') onProgress(0.1 + (0.9 * (m.index + 1)) / m.total);
        } catch { /* not a progress line */ }
      });
      if (r.code !== 0) throw new Error(r.err.trim().split('\n').filter(Boolean).at(-1)?.slice(0, 300) ?? 'MuG failed');
    },
  };
}
