import { describe, expect, test } from 'bun:test';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { REQUEST_LABEL, wantsReview } from '../src/decide';
import { type Job, ReviewQueue } from '../src/queue';
import {
  type ContainerOutcome,
  type Docker,
  REVIEW_TIMEOUT_MS,
  REVIEWER_PERMISSIONS,
  reviewerToken,
  runContainer,
  type SetTimer,
} from '../src/reviewer';
import type { PullRequestEvent } from '../src/webhook';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A job that records what happens to it and runs until `finish` or an abort. */
function fakeJob(key: string, events: string[], name = key) {
  let finish!: () => void;
  let signal: AbortSignal | undefined;
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
    async cancel() {
      events.push(`cancel waiting ${name}`);
    },
  };
  return { job, finish: () => finish(), aborted: () => signal?.aborted ?? false };
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
});

/** A Docker whose containers run until `exit` or a stop. */
function fakeDocker() {
  const calls: { args: string[]; env: Record<string, string> }[] = [];
  const stopped: string[] = [];
  let exit!: (status: number) => void;
  const engine: Docker = {
    run(args, env) {
      calls.push({ args, env });
      return { exited: new Promise<number>((resolve) => (exit = resolve)) };
    },
    async stop(name) {
      stopped.push(name);
      exit(143);
    },
  };
  return { engine, calls, stopped, exit: (status: number) => exit(status) };
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
    docker.exit(0);
    expect(await run).toBe('success');
    const { args, env } = docker.calls[0]!;
    expect(args).not.toContain('--rm');
    expect(args.slice(0, 3)).toEqual(['run', '--name', 'quill-images-7']);
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
    docker.exit(status);
    expect(await run).toBe(outcome as ContainerOutcome);
  });

  test('stops a reviewer container still running after 30 minutes', async () => {
    const docker = fakeDocker();
    const clock = fakeClock();
    const run = container(docker.engine, clock.setTimer);
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
    controller.abort();
    expect(await run).toBe('cancelled');
    expect(docker.stopped).toEqual(['quill-images-7']);
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
