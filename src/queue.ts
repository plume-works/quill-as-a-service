/** One review the queue runs; `key` names its pull request. */
export interface Job {
  key: string;
  /** Report the job as waiting; called once any earlier job of the same key has ended. */
  queued(): Promise<void>;
  /** Run the job; `signal` aborts when a newer job of the same key replaces it. */
  run(signal: AbortSignal): Promise<void>;
  /** End a job that was replaced before it started. */
  cancel(): Promise<void>;
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

  constructor(private readonly max: () => number) {}

  /** Queue `job`, after cancelling the job of the same key that waits or runs. */
  enqueue(job: Job): Promise<void> {
    const placed = (this.placing.get(job.key) ?? Promise.resolve()).then(() => this.place(job));
    this.placing.set(job.key, placed.catch(log));
    return placed;
  }

  get size(): { running: number; waiting: number } {
    return { running: this.running.size, waiting: this.waiting.length };
  }

  private async place(job: Job): Promise<void> {
    const index = this.waiting.findIndex((other) => other.key === job.key);
    if (index !== -1) {
      const [earlier] = this.waiting.splice(index, 1);
      await earlier!.cancel().catch(log);
    }
    const running = this.running.get(job.key);
    if (running) {
      running.controller.abort();
      await running.done;
    }
    await job.queued();
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
