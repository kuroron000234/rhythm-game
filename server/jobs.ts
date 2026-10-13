import { access, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

export type JobState = 'none' | 'queued' | 'running' | 'done' | 'error';
export interface JobStatus { state: JobState; progress?: number; error?: string }

export interface JobSpec {
  /** Results live in <cacheDir>/<id>/<subdir>/. */
  subdir: string;
  /** Files that must all exist for the job to count as done. */
  files: readonly string[];
  run(audio: string, outDir: string, onProgress: (p: number) => void): Promise<void>;
}

/** One job at a time per queue (GPU work); finished results are read back from disk. */
export class FileJobs {
  private jobs = new Map<string, JobStatus & { audio: string }>();
  private queue: string[] = [];
  private running = false;

  constructor(private cacheDir: string, private spec: JobSpec) {}

  path(id: string, file: string) {
    return join(this.cacheDir, id, this.spec.subdir, file);
  }

  private async onDisk(id: string) {
    try {
      await Promise.all(this.spec.files.map((f) => access(this.path(id, f))));
      return true;
    } catch {
      return false;
    }
  }

  async status(id: string): Promise<JobStatus> {
    const j = this.jobs.get(id);
    if (j) return { state: j.state, ...(j.progress !== undefined ? { progress: j.progress } : {}), ...(j.error ? { error: j.error } : {}) };
    return { state: (await this.onDisk(id)) ? 'done' : 'none' };
  }

  async enqueue(id: string, audio: string): Promise<JobStatus> {
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
    const final = join(this.cacheDir, id, this.spec.subdir);
    const tmp = `${final}.tmp-${Date.now()}`;
    try {
      await mkdir(tmp, { recursive: true });
      await this.spec.run(job.audio, tmp, (p) => (job.progress = p));
      await rm(final, { recursive: true, force: true });
      await rename(tmp, final);
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
