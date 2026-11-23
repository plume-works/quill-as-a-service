/** Why a job ends early: a newer job of its key replaced it, or the queue shut down. */
export type CancelReason = 'replaced' | 'shutdown';

/** One review the queue runs; `key` names its pull request. */
export interface Job {
  key: string;
  /** Report the job as waiting; called once any earlier job of the same key has ended. */
  queued(): Promise<void>;
  /** Run the job; `signal` aborts with a `CancelReason` as its reason. */
  run(signal: AbortSignal): Promise<void>;
  /** End a job that was cancelled before it started. */
  cancel(reason: CancelReason): Promise<void>;
}

interface Running {
  controller: AbortController;
  done: Promise<void>;
}

const log = (error: unknown) => console.error(error);

/** Run jobs oldest first, at most `max()` at once and one per key. */
export class ReviewQueue {
  private readonly waiting: Job[] = [];
  private readonly running = new Map<string, Running>();
  private readonly placing = new Map<string, Promise<void>>();
  private closed = false;

  constructor(private readonly max: () => number) {}

  /** Queue `job`, after cancelling the job of the same key that waits or runs. */
  enqueue(job: Job): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error(`${job.key}: the review queue is shut down`));
    }
    const placed = (this.placing.get(job.key) ?? Promise.resolve()).then(() => this.place(job));
    this.placing.set(job.key, placed.catch(log));
    return placed;
  }

  /** Refuse new jobs, cancel the waiting ones, and stop the running ones; resolve when all ended. */
  async shutdown(): Promise<void> {
    this.closed = true;
    const running = [...this.running.values()];
    for (const { controller } of running) {
      controller.abort('shutdown' satisfies CancelReason);
    }
    const waiting = this.waiting.splice(0).map((job) => job.cancel('shutdown').catch(log));
    await Promise.all([...waiting, ...running.map(({ done }) => done), ...this.placing.values()]);
  }

  get size(): { running: number; waiting: number } {
    return { running: this.running.size, waiting: this.waiting.length };
  }

  private async place(job: Job): Promise<void> {
    const index = this.waiting.findIndex((other) => other.key === job.key);
    if (index !== -1) {
      const [earlier] = this.waiting.splice(index, 1);
      await earlier!.cancel('replaced').catch(log);
    }
    const running = this.running.get(job.key);
    if (running) {
      running.controller.abort('replaced' satisfies CancelReason);
      await running.done;
    }
    await job.queued();
    if (this.closed) {
      await job.cancel('shutdown');
      return;
    }
    this.waiting.push(job);
    this.pump();
  }

  private pump(): void {
    while (this.running.size < this.max() && this.waiting.length > 0) {
      const job = this.waiting.shift()!;
      const controller = new AbortController();
      const done = job
        .run(controller.signal)
        .catch(log)
        .finally(() => {
          this.running.delete(job.key);
          this.pump();
        });
      this.running.set(job.key, { controller, done });
    }
  }
}
