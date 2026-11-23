import { describe, expect, test } from 'bun:test';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { DEFAULT_MAX_CONCURRENT_REVIEWS } from '../src/config';
import { REQUEST_LABEL, wantsReview } from '../src/decide';
import { type CancelReason, type Job, ReviewQueue } from '../src/queue';
import {
  type ContainerOutcome,
  type Docker,
  REVIEW_TIMEOUT_MS,
  REVIEWER_PERMISSIONS,
  reviewerToken,
  runContainer,
  type SetTimer,
  STOP_RESEND_MS,
} from '../src/reviewer';
import type { PullRequestEvent } from '../src/webhook';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A job that records what happens to it and runs until `finish` or an abort. */
function fakeJob(key: string, events: string[], name = key) {
  let finish!: () => void;
  let signal: AbortSignal | undefined;
  let cancelReason: CancelReason | undefined;
  const job: Job = {
    key,
    async queued() {
      events.push(`queued ${name}`);
    },
    run(runSignal) {
      signal = runSignal;
      events.push(`start ${name}`);
      return new Promise<void>((resolve) => {
        finish = () => {
          events.push(`end ${name}`);
          resolve();
        };
        runSignal.addEventListener('abort', () => {
          events.push(`cancel ${name}`);
          resolve();
        });
      });
    },
    async cancel(reason) {
      cancelReason = reason;
      events.push(`cancel waiting ${name}`);
    },
  };
  return {
    job,
    finish: () => finish(),
    aborted: () => signal?.aborted ?? false,
    abortReason: () => signal?.reason,
    cancelReason: () => cancelReason,
  };
}

const REPOSITORY = 'plume-works/images';

function pushEvent(labels: string[], sha: string): PullRequestEvent {
  return {
    action: 'synchronize',
    sender: { login: 'dev' },
    installation: { id: 42 },
    repository: { full_name: REPOSITORY, name: 'images', owner: { login: 'plume-works' } },
    pull_request: {
      number: 7,
      draft: false,
      labels: labels.map((name) => ({ name })),
      user: { login: 'dev', type: 'User' },
      head: { sha, ref: 'topic', repo: { full_name: REPOSITORY } },
    },
  };
}

describe('the review queue', () => {
  test('runs at most the maximum and starts the oldest waiting', async () => {
    const events: string[] = [];
    const queue = new ReviewQueue(() => 2);
    const jobs = ['pr-1', 'pr-2', 'pr-3', 'pr-4'].map((key) => fakeJob(key, events));
    for (const { job } of jobs) {
      await queue.enqueue(job);
    }
    expect(queue.size).toEqual({ running: 2, waiting: 2 });
    expect(events.filter((event) => event.startsWith('start'))).toEqual(['start pr-1', 'start pr-2']);
    jobs[1]!.finish();
    await settle();
    expect(events.filter((event) => event.startsWith('start'))).toEqual([
      'start pr-1',
      'start pr-2',
      'start pr-3',
    ]);
    expect(queue.size).toEqual({ running: 2, waiting: 1 });
  });

  test('defaults to five at once through the configured maximum', async () => {
    const events: string[] = [];
    const queue = new ReviewQueue(() => 5);
    for (let pr = 1; pr <= 7; pr++) {
      await queue.enqueue(fakeJob(`pr-${pr}`, events).job);
    }
    expect(queue.size).toEqual({ running: 5, waiting: 2 });
  });

  test('a new review of a pull request cancels its earlier review', async () => {
    const events: string[] = [];
    const queue = new ReviewQueue(() => 5);
    const opened = fakeJob('pr-7', events, 'opened');
    await queue.enqueue(opened.job);
    const requested = fakeJob('pr-7', events, 'requested');
    await queue.enqueue(requested.job);
    expect(opened.aborted()).toBe(true);
    expect(events).toEqual([
      'queued opened',
      'start opened',
      'cancel opened',
      'queued requested',
      'start requested',
    ]);
  });

  test('a new review cancels the earlier review that still waits', async () => {
    const events: string[] = [];
    const queue = new ReviewQueue(() => 1);
    await queue.enqueue(fakeJob('pr-1', events).job);
    await queue.enqueue(fakeJob('pr-7', events, 'opened').job);
    await queue.enqueue(fakeJob('pr-7', events, 'requested').job);
    expect(events).toEqual([
      'queued pr-1',
      'start pr-1',
      'queued opened',
      'cancel waiting opened',
      'queued requested',
    ]);
    expect(queue.size).toEqual({ running: 1, waiting: 1 });
  });

  test('a push with the label on restarts the review on the new head', async () => {
    const events: string[] = [];
    const queue = new ReviewQueue(() => 5);
    const first = fakeJob('pr-7', events, 'head-1');
    await queue.enqueue(first.job);
    const push = pushEvent([REQUEST_LABEL], 'b'.repeat(40));
    expect(wantsReview({ event: push, paused: false })).toBe(true);
    await queue.enqueue(fakeJob('pr-7', events, 'head-2').job);
    expect(first.aborted()).toBe(true);
    expect(events).toEqual(['queued head-1', 'start head-1', 'cancel head-1', 'queued head-2', 'start head-2']);
  });

  test('a push with the label on replaces the waiting review too', async () => {
    const events: string[] = [];
    const queue = new ReviewQueue(() => 1);
    await queue.enqueue(fakeJob('pr-1', events).job);
    await queue.enqueue(fakeJob('pr-7', events, 'head-1').job);
    expect(wantsReview({ event: pushEvent([REQUEST_LABEL], 'b'.repeat(40)), paused: false })).toBe(true);
    await queue.enqueue(fakeJob('pr-7', events, 'head-2').job);
    expect(events).toContain('cancel waiting head-1');
    expect(events.at(-1)).toBe('queued head-2');
  });

  test('a shutdown cancels the waiting reviews and waits for the running ones to stop', async () => {
    const events: string[] = [];
    const queue = new ReviewQueue(() => 1);
    let abortReason: unknown;
    const running: Job = {
      key: 'pr-1',
      async queued() {},
      run: (signal) =>
        new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => {
            abortReason = signal.reason;
            setTimeout(() => {
              events.push('stopped pr-1');
              resolve();
            }, 5);
          }),
        ),
      async cancel() {},
    };
    const waiting = fakeJob('pr-2', events);
    await queue.enqueue(running);
    await queue.enqueue(waiting.job);
    await queue.shutdown();
    expect(abortReason).toBe('shutdown');
    expect(events).toContain('stopped pr-1');
    expect(waiting.cancelReason()).toBe('shutdown');
    expect(events).not.toContain('start pr-2');
    expect(queue.size).toEqual({ running: 0, waiting: 0 });
  });

  test('a review replaced by a newer one is cancelled as replaced', async () => {
    const events: string[] = [];
    const roomy = new ReviewQueue(() => 5);
    const running = fakeJob('pr-7', events);
    await roomy.enqueue(running.job);
    await roomy.enqueue(fakeJob('pr-7', events).job);
    expect(running.abortReason()).toBe('replaced');

    const full = new ReviewQueue(() => 1);
    await full.enqueue(fakeJob('pr-1', events).job);
    const waiting = fakeJob('pr-7', events);
    await full.enqueue(waiting.job);
    await full.enqueue(fakeJob('pr-7', events).job);
    expect(waiting.cancelReason()).toBe('replaced');
  });

  test('a push without the label cancels the running review as pushed', async () => {
    const events: string[] = [];
    const queue = new ReviewQueue(() => 5);
    const running = fakeJob('pr-7', events);
    await queue.enqueue(running.job);
    await queue.cancel('pr-7');
    expect(running.abortReason()).toBe('pushed');
    expect(queue.size).toEqual({ running: 0, waiting: 0 });
  });

  test('a push without the label cancels the waiting review as pushed', async () => {
    const events: string[] = [];
    const queue = new ReviewQueue(() => 1);
    const other = fakeJob('pr-1', events);
    await queue.enqueue(other.job);
    const waiting = fakeJob('pr-7', events);
    await queue.enqueue(waiting.job);
    await queue.cancel('pr-7');
    expect(waiting.cancelReason()).toBe('pushed');
    expect(other.aborted()).toBe(false);
    expect(queue.size).toEqual({ running: 1, waiting: 0 });
  });

  test('a cancel waits for the placement of the same pull request', async () => {
    const events: string[] = [];
    const queue = new ReviewQueue(() => 5);
    const placing = fakeJob('pr-7', events);
    const placed = queue.enqueue(placing.job);
    await queue.cancel('pr-7');
    await placed;
    expect(placing.abortReason()).toBe('pushed');
    expect(queue.size).toEqual({ running: 0, waiting: 0 });
  });

  test('an unreadable maximum before any good read uses the default', async () => {
    const events: string[] = [];
    const queue = new ReviewQueue(() => {
      throw new Error('config: maxConcurrentReviews must be a positive integer');
    });
    for (let pr = 1; pr <= DEFAULT_MAX_CONCURRENT_REVIEWS + 1; pr++) {
      await queue.enqueue(fakeJob(`pr-${pr}`, events).job);
    }
    expect(queue.size).toEqual({ running: DEFAULT_MAX_CONCURRENT_REVIEWS, waiting: 1 });
  });

  test('an unreadable maximum keeps the last good one', async () => {
    const events: string[] = [];
    let broken = false;
    const queue = new ReviewQueue(() => {
      if (broken) {
        throw new SyntaxError('JSON Parse error');
      }
      return 1;
    });
    await queue.enqueue(fakeJob('pr-1', events).job);
    broken = true;
    await queue.enqueue(fakeJob('pr-2', events).job);
    expect(queue.size).toEqual({ running: 1, waiting: 1 });
  });

  test('a review ending while the maximum is unreadable starts the next one', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      const events: string[] = [];
      let broken = false;
      const queue = new ReviewQueue(() => {
        if (broken) {
          throw new SyntaxError('JSON Parse error');
        }
        return 1;
      });
      const first = fakeJob('pr-1', events);
      await queue.enqueue(first.job);
      await queue.enqueue(fakeJob('pr-2', events).job);
      broken = true;
      first.finish();
      await settle();
      expect(events).toContain('start pr-2');
      await queue.shutdown();
      expect(queue.size).toEqual({ running: 0, waiting: 0 });
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  test('a shut-down queue refuses new reviews', async () => {
    const events: string[] = [];
    const queue = new ReviewQueue(() => 5);
    await queue.shutdown();
    await expect(queue.enqueue(fakeJob('pr-1', events).job)).rejects.toThrow('shut down');
    expect(events).toEqual([]);
  });
});

/**
 * A Docker whose create ends with `created`, or waits for `finishCreate` while it is
 * 'pending', and whose containers run until `exit` or a stop; a stop before `land` misses.
 */
function fakeDocker({ created = 0 as number | 'pending', landed = true } = {}) {
  const calls: { args: string[]; env: Record<string, string> }[] = [];
  const started: string[] = [];
  const stopped: string[] = [];
  let exit!: (status: number) => void;
  let finishCreate!: (status: number) => void;
  const engine: Docker = {
    create(args, env) {
      calls.push({ args, env });
      return created === 'pending' ? new Promise<number>((resolve) => (finishCreate = resolve)) : Promise.resolve(created);
    },
    start(name) {
      started.push(name);
      return { exited: new Promise<number>((resolve) => (exit = resolve)) };
    },
    async stop(name) {
      stopped.push(name);
      if (landed) {
        exit(143);
      }
    },
  };
  return {
    engine,
    calls,
    started,
    stopped,
    land: () => (landed = true),
    exit: (status: number) => exit(status),
    finishCreate: (status: number) => finishCreate(status),
  };
}

/** A clock that fires its timers only when told to advance. */
function fakeClock() {
  let now = 0;
  const timers: { at: number; callback: () => void; cleared: boolean }[] = [];
  const setTimer: SetTimer = (callback, ms) => {
    const timer = { at: now + ms, callback, cleared: false };
    timers.push(timer);
    return () => {
      timer.cleared = true;
    };
  };
  const advance = (ms: number) => {
    now += ms;
    for (const timer of timers) {
      if (!timer.cleared && timer.at <= now) {
        timer.cleared = true;
        timer.callback();
      }
    }
  };
  return { setTimer, advance };
}

const container = (engine: Docker, setTimer: SetTimer, signal = new AbortController().signal) =>
  runContainer({
    image: 'ghcr.io/plume-works/quill-reviewer:edge',
    name: 'quill-images-7',
    env: { HEAD_SHA: 'a'.repeat(40), GH_TOKEN: 'secret' },
    signal,
    docker: engine,
    setTimer,
  });

describe('reviewer containers', () => {
  test('a reviewer container is started without --rm', async () => {
    const docker = fakeDocker();
    const run = container(docker.engine, fakeClock().setTimer);
    await settle();
    docker.exit(0);
    expect(await run).toBe('success');
    const { args, env } = docker.calls[0]!;
    expect(args).not.toContain('--rm');
    expect(args.slice(0, 3)).toEqual(['create', '--name', 'quill-images-7']);
    expect(docker.started).toEqual(['quill-images-7']);
    expect(args.at(-1)).toBe('ghcr.io/plume-works/quill-reviewer:edge');
    // Secrets travel in the environment, never on the command line.
    expect(args.join(' ')).not.toContain('secret');
    expect(args).toContain('GH_TOKEN');
    expect(env.GH_TOKEN).toBe('secret');
  });

  test.each([
    [0, 'success'],
    [1, 'failure'],
  ])('a container that exits %p ends as %p', async (status, outcome) => {
    const docker = fakeDocker();
    const run = container(docker.engine, fakeClock().setTimer);
    await settle();
    docker.exit(status);
    expect(await run).toBe(outcome as ContainerOutcome);
  });

  test('stops a reviewer container still running after 30 minutes', async () => {
    const docker = fakeDocker();
    const clock = fakeClock();
    const run = container(docker.engine, clock.setTimer);
    await settle();
    clock.advance(REVIEW_TIMEOUT_MS - 1);
    expect(docker.stopped).toEqual([]);
    clock.advance(1);
    expect(docker.stopped).toEqual(['quill-images-7']);
    expect(await run).toBe('timeout');
    expect(REVIEW_TIMEOUT_MS).toBe(30 * 60 * 1000);
  });

  test('a cancelled review stops its container', async () => {
    const docker = fakeDocker();
    const controller = new AbortController();
    const run = container(docker.engine, fakeClock().setTimer, controller.signal);
    await settle();
    controller.abort();
    expect(await run).toBe('cancelled');
    expect(docker.stopped).toEqual(['quill-images-7']);
  });

  test('a cancel that hits before the start lands is re-sent until the container stops', async () => {
    const docker = fakeDocker({ landed: false });
    const clock = fakeClock();
    const controller = new AbortController();
    const run = container(docker.engine, clock.setTimer, controller.signal);
    await settle();
    controller.abort();
    expect(docker.stopped).toEqual(['quill-images-7']);
    clock.advance(STOP_RESEND_MS);
    expect(docker.stopped).toHaveLength(2);
    docker.land();
    clock.advance(STOP_RESEND_MS);
    expect(docker.stopped).toHaveLength(3);
    expect(await run).toBe('cancelled');
  });

  test('a stop is re-sent only until the container exits', async () => {
    const docker = fakeDocker();
    const clock = fakeClock();
    const controller = new AbortController();
    const run = container(docker.engine, clock.setTimer, controller.signal);
    await settle();
    controller.abort();
    expect(await run).toBe('cancelled');
    clock.advance(10 * STOP_RESEND_MS);
    expect(docker.stopped).toEqual(['quill-images-7']);
  });

  test('a review cancelled while its container is created never starts it', async () => {
    const docker = fakeDocker({ created: 'pending' });
    const controller = new AbortController();
    const run = container(docker.engine, fakeClock().setTimer, controller.signal);
    await settle();
    controller.abort();
    docker.finishCreate(0);
    expect(await run).toBe('cancelled');
    expect(docker.started).toEqual([]);
    expect(docker.stopped).toEqual([]);
  });

  test('a review that times out while its container is created never starts it', async () => {
    const docker = fakeDocker({ created: 'pending' });
    const clock = fakeClock();
    const run = container(docker.engine, clock.setTimer);
    await settle();
    clock.advance(REVIEW_TIMEOUT_MS);
    docker.finishCreate(0);
    expect(await run).toBe('timeout');
    expect(docker.started).toEqual([]);
    expect(docker.stopped).toEqual([]);
  });

  test('a container that cannot be created ends as failure', async () => {
    const docker = fakeDocker({ created: 125 });
    expect(await container(docker.engine, fakeClock().setTimer)).toBe('failure');
    expect(docker.started).toEqual([]);
  });

  test('asks for an installation token limited to the one repository', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const requests: { url: string; body: unknown; authorization: string | null }[] = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      requests.push({
        url,
        body: JSON.parse(String(init?.body)),
        authorization: new Headers(init?.headers).get('authorization'),
      });
      return Response.json({ token: 'ghs_scoped' }, { status: 201 });
    };
    const app = {
      clientId: 'Iv1.quill',
      privateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
      fetchFn,
    };
    const token = await reviewerToken(app, pushEvent([], 'a'.repeat(40)));
    expect(token).toBe('ghs_scoped');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('https://api.github.com/app/installations/42/access_tokens');
    expect(requests[0]!.body).toEqual({ repositories: ['images'], permissions: REVIEWER_PERMISSIONS });
    expect(requests[0]!.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    const [header, claims, signature] = requests[0]!.authorization!.slice('Bearer '.length).split('.');
    const verified = createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(publicKey, signature!, 'base64url');
    expect(verified).toBe(true);
    expect(JSON.parse(Buffer.from(claims!, 'base64url').toString()).iss).toBe('Iv1.quill');
  });
});
