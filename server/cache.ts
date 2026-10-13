import { mkdir, readFile, rename, rm, writeFile, access } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface SongMeta {
  id: string;
  title: string;
  duration: number;
  thumbnail: string | null;
  /** Audio file name inside the song directory. */
  file: string;
}

export const isValidId = (id: string) => /^[A-Za-z0-9_-]{1,100}$/.test(id);

export class AudioCache {
  constructor(private dir: string) {}

  async get(id: string): Promise<SongMeta | null> {
    try {
      const meta: SongMeta = JSON.parse(await readFile(join(this.dir, id, 'meta.json'), 'utf8'));
      await access(this.audioPath(meta));
      return meta;
    } catch {
      return null;
    }
  }

  audioPath(meta: SongMeta) {
    return join(this.dir, meta.id, meta.file);
  }

  /** Runs fill() in a temp dir, then atomically moves it into place. */
  async put(id: string, fill: (tmpDir: string) => Promise<Omit<SongMeta, 'file'> & { path: string }>) {
    const tmp = join(this.dir, `.tmp-${id}-${randomBytes(4).toString('hex')}`);
    await mkdir(tmp, { recursive: true });
    try {
      const { path, ...rest } = await fill(tmp);
      const meta: SongMeta = { ...rest, file: basename(path) };
      await writeFile(join(tmp, 'meta.json'), JSON.stringify(meta));
      await rm(join(this.dir, id), { recursive: true, force: true });
      await rename(tmp, join(this.dir, id));
      return meta;
    } catch (e) {
      await rm(tmp, { recursive: true, force: true });
      throw e;
    }
  }
}
