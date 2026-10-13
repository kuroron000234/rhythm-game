import { access, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Separator } from './separator.ts';

export type StemState = 'none' | 'queued' | 'running' | 'done' | 'error';
export interface StemStatus { state: StemState; progress?: number; error?: string }
export const STEMS = ['vocals', 'accomp'] as const;

/** One Demucs job at a time; results live in <cacheDir>/<id>/stems/. */
export class StemJobs {
  private jobs = new Map<string, StemStatus & { audio: string }>();
  private queue: string[] = [];
  private running = false;

  constructor(private cacheDir: string, private separator: Separator) {}

  stemPath(id: string, stem: (typeof STEMS)[number]) {
    return join(this.cacheDir, id, 'stems', `${stem}.flac`);
  }

  private async onDisk(id: string) {
    try {
      await Promise.all(STEMS.map((s) => access(this.stemPath(id, s))));
      return true;
    } catch {
      return false;
    }
  }

  async status(id: string): Promise<StemStatus> {
    const j = this.jobs.get(id);
    if (j) return { state: j.state, ...(j.progress !== undefined ? { progress: j.progress } : {}), ...(j.error ? { error: j.error } : {}) };
    return { state: (await this.onDisk(id)) ? 'done' : 'none' };
  }

  async enqueue(id: string, audio: string): Promise<StemStatus> {
    const cur = await this.status(id);
    if (cur.state === 'queued' || cur.state === 'running' || cur.state === 'done') return cur;
    // re-check after the await: a concurrent request may have queued it meanwhile
    const again = this.jobs.get(id);
    if (again && again.state !== 'error') return this.status(id);
    this.jobs.set(id, { state: 'queued', audio });
    this.queue.push(id);
    void this.pump();
    return { state: 'queued' };
  }

  private async pump() {
    if (this.running) return;
    const id = this.queue.shift();
    if (!id) return;
    const job = this.jobs.get(id);
    if (!job || job.state !== 'queued') return void this.pump();
    this.running = true;
    job.state = 'running';
    job.progress = 0;
    const tmp = join(this.cacheDir, id, `.stems-tmp-${Date.now()}`);
    try {
      await mkdir(tmp, { recursive: true });
      await this.separator.separate(job.audio, tmp, (p) => (job.progress = p));
      await rm(join(this.cacheDir, id, 'stems'), { recursive: true, force: true });
      await rename(tmp, join(this.cacheDir, id, 'stems'));
      this.jobs.delete(id); // disk is the source of truth from now on
    } catch (e) {
      job.state = 'error';
      job.error = String((e as Error)?.message ?? e);
      delete job.progress;
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    } finally {
      this.running = false;
      void this.pump();
    }
  }
}
