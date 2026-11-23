import { describe, expect, test } from 'bun:test';
import { REQUEST_LABEL } from '../src/decide';
import { GitHub } from '../src/github';
import { ReviewQueue } from '../src/queue';
import { CHECK_NAME, PUSHED_SUMMARY, QUILL_LOGIN, Review, STOPPED_SUMMARY } from '../src/review';
import { type ContainerOutcome, type Docker, REVIEW_TIMEOUT_MS, runContainer, type SetTimer } from '../src/reviewer';
import type { PullRequestEvent } from '../src/webhook';

const HEAD = 'c'.repeat(40);
const REPO = '/repos/plume-works/images';

interface Call {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

/**
 * A GitHub that records each call and answers from `reviews` and `labelPresent`; it refuses a
 * posted review when `refuseReview`, and answers it only after `holdReview` resolves.
 */
function fakeGitHub({
  reviews = [] as unknown[],
  labelPresent = true,
  refuseReview = false,
  holdReview = Promise.resolve(),
} = {}) {
  const calls: Call[] = [];
  const fetchFn = async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const method = init?.method ?? 'GET';
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === 'POST' && path.endsWith('/check-runs')) {
      return Response.json({ id: 99 }, { status: 201 });
    }
    if (method === 'POST' && path.endsWith('/reviews')) {
      await holdReview;
      return refuseReview
        ? Response.json({ message: 'Unprocessable Entity' }, { status: 422 })
        : Response.json({ id: 500 });
    }
    if (method === 'GET' && path.endsWith('/reviews')) {
      return Response.json(reviews);
    }
    if (method === 'DELETE' && !labelPresent) {
      return Response.json({ message: 'Label does not exist' }, { status: 404 });
    }
    return Response.json({});
  };
  const github = async () => new GitHub('ghs_service', fetchFn);
  const checkRun = () =>
    calls
      .filter((call) => call.path.includes('/check-runs'))
      .map((call) => call.body?.conclusion ?? call.body?.status);
  const posted = () => calls.filter((call) => call.method === 'POST' && call.path.endsWith('/pulls/7/reviews'));
  return { calls, github, checkRun, posted };
}

const RESULT = {
  event: 'REQUEST_CHANGES',
  body: 'One blocking finding.',
  comments: [{ path: 'src/a.ts', line: 3, side: 'RIGHT', body: 'This throws on an empty list.' }],
};
const readResult = async (): Promise<string | undefined> => JSON.stringify(RESULT);

function event(): PullRequestEvent {
  return {
    action: 'opened',
    sender: { login: 'dev' },
    installation: { id: 42 },
    repository: { full_name: 'plume-works/images', name: 'images', owner: { login: 'plume-works' } },
    pull_request: {
      number: 7,
      draft: false,
      labels: [],
      user: { login: 'dev', type: 'User' },
      head: { sha: HEAD, ref: 'topic', repo: { full_name: 'plume-works/images' } },
    },
  };
}

/** A container that never exits unless stopped, on a clock that moves only when told. */
function hangingContainer() {
  let exit!: (status: number) => void;
  const engine: Docker = {
    create: async () => 0,
    start: () => ({ exited: new Promise<number>((resolve) => (exit = resolve)) }),
    stop: async () => exit(143),
    readFile: async () => undefined,
  };
  const timers: (() => void)[] = [];
  const setTimer: SetTimer = (callback) => {
    timers.push(callback);
    return () => {};
  };
  const run = (signal: AbortSignal) =>
    runContainer({ image: 'reviewer', name: 'quill-images-7', env: {}, signal, docker: engine, setTimer });
  return { run, expire: () => timers.forEach((timer) => timer()), timeout: REVIEW_TIMEOUT_MS };
}

async function reviewEnding(outcome: ContainerOutcome, github = fakeGitHub(), result = readResult) {
  const review = new Review(event(), { github: github.github, readResult: result, runContainer: async () => outcome });
  await review.queued();
  await review.run(new AbortController().signal);
  return github;
}

const labelRemovals = (calls: Call[]) =>
  calls.filter((call) => call.method === 'DELETE' && call.path.endsWith(`/labels/${REQUEST_LABEL}`));

describe('a review reports a Quill Review check run', () => {
  test('the check run follows the review', async () => {
    const queued = fakeGitHub();
    await new Review(event(), { github: queued.github, readResult, runContainer: async () => 'success' }).queued();
    expect(queued.calls).toEqual([
      { method: 'POST', path: `${REPO}/check-runs`, body: { name: CHECK_NAME, head_sha: HEAD, status: 'queued' } },
    ]);

    expect((await reviewEnding('success')).checkRun()).toEqual(['queued', 'in_progress', 'success']);
    expect((await reviewEnding('failure')).checkRun()).toEqual(['queued', 'in_progress', 'failure']);

    const timedOut = fakeGitHub();
    const container = hangingContainer();
    const review = new Review(event(), { github: timedOut.github, readResult, runContainer: container.run });
    await review.queued();
    const running = review.run(new AbortController().signal);
    await Bun.sleep(0);
    expect(timedOut.checkRun()).toEqual(['queued', 'in_progress']);
    container.expire();
    await running;
    expect(timedOut.checkRun()).toEqual(['queued', 'in_progress', 'failure']);

    const replaced = fakeGitHub();
    const queue = new ReviewQueue(() => 5);
    await queue.enqueue(new Review(event(), { github: replaced.github, readResult, runContainer: hangingContainer().run }));
    await Bun.sleep(0);
    await queue.enqueue(new Review(event(), { github: replaced.github, readResult, runContainer: async () => 'success' }));
    await Bun.sleep(0);
    expect(replaced.checkRun()).toEqual([
      'queued',
      'in_progress',
      'cancelled',
      'queued',
      'in_progress',
      'success',
    ]);
  });

  test('the check run of a review cancelled while waiting completes as cancelled', async () => {
    const github = fakeGitHub();
    const review = new Review(event(), { github: github.github, readResult, runContainer: async () => 'success' });
    await review.queued();
    await review.cancel();
    expect(github.checkRun()).toEqual(['queued', 'cancelled']);
  });

  test('the check run completes with the same id it was created with', async () => {
    const { calls } = await reviewEnding('success');
    const updates = calls.filter((call) => call.method === 'PATCH').map((call) => call.path);
    expect(updates).toEqual([`${REPO}/check-runs/99`, `${REPO}/check-runs/99`]);
  });

  test('a starting review dismisses the earlier approval only', async () => {
    const reviews = [
      { id: 1, state: 'APPROVED', user: { login: QUILL_LOGIN } },
      { id: 2, state: 'CHANGES_REQUESTED', user: { login: QUILL_LOGIN } },
      { id: 3, state: 'APPROVED', user: { login: 'maintainer' } },
      { id: 4, state: 'COMMENTED', user: { login: QUILL_LOGIN } },
    ];
    const { calls } = await reviewEnding('success', fakeGitHub({ reviews }));
    const dismissals = calls.filter((call) => call.method === 'PUT');
    expect(dismissals).toEqual([
      {
        method: 'PUT',
        path: `${REPO}/pulls/7/reviews/1/dismissals`,
        body: { event: 'DISMISS', message: 'A new Quill review started.' },
      },
    ]);
    const order = calls.map((call) => `${call.method} ${call.path}`);
    expect(order.indexOf(`PUT ${REPO}/pulls/7/reviews/1/dismissals`)).toBeLessThan(
      order.lastIndexOf(`PATCH ${REPO}/check-runs/99`),
    );
  });

  test('the label is removed after success or failure only', async () => {
    expect(labelRemovals((await reviewEnding('success')).calls)).toHaveLength(1);
    expect(labelRemovals((await reviewEnding('failure')).calls)).toHaveLength(1);
    expect(labelRemovals((await reviewEnding('timeout')).calls)).toHaveLength(1);
    expect(labelRemovals((await reviewEnding('cancelled')).calls)).toHaveLength(0);

    const waiting = fakeGitHub();
    const review = new Review(event(), { github: waiting.github, readResult, runContainer: async () => 'success' });
    await review.queued();
    await review.cancel();
    expect(labelRemovals(waiting.calls)).toHaveLength(0);
  });

  test('a review stopped by the shutdown completes as cancelled and keeps the label', async () => {
    const github = fakeGitHub();
    const queue = new ReviewQueue(() => 1);
    await queue.enqueue(new Review(event(), { github: github.github, readResult, runContainer: hangingContainer().run }));
    await queue.enqueue(new Review({ ...event(), pull_request: { ...event().pull_request, number: 8 } }, {
      github: github.github,
      readResult,
      runContainer: async () => 'success',
    }));
    await Bun.sleep(0);
    await queue.shutdown();
    expect(github.checkRun()).toEqual(['queued', 'in_progress', 'queued', 'cancelled', 'cancelled']);
    const summaries = github.calls
      .filter((call) => call.body?.conclusion === 'cancelled')
      .map((call) => (call.body?.output as { summary: string }).summary);
    expect(summaries).toEqual([STOPPED_SUMMARY, STOPPED_SUMMARY]);
    expect(STOPPED_SUMMARY).toContain(REQUEST_LABEL);
    expect(labelRemovals(github.calls)).toHaveLength(0);
  });

  test('a review cancelled by a push without the label says the head moved', async () => {
    const github = fakeGitHub();
    const queue = new ReviewQueue(() => 1);
    await queue.enqueue(new Review(event(), { github: github.github, readResult, runContainer: hangingContainer().run }));
    await queue.enqueue(new Review({ ...event(), pull_request: { ...event().pull_request, number: 8 } }, {
      github: github.github,
      readResult,
      runContainer: hangingContainer().run,
    }));
    await Bun.sleep(0);
    await queue.cancel('plume-works/images#8');
    await queue.cancel('plume-works/images#7');
    const summaries = github.calls
      .filter((call) => call.body?.conclusion === 'cancelled')
      .map((call) => (call.body?.output as { summary: string }).summary);
    expect(summaries).toEqual([PUSHED_SUMMARY, PUSHED_SUMMARY]);
    expect(PUSHED_SUMMARY).toContain(REQUEST_LABEL);
    // A cancelled review leaves the label on, and adding a present label sends no event.
    expect(PUSHED_SUMMARY).toContain('remove and re-add');
    expect(labelRemovals(github.calls)).toHaveLength(0);
  });

  test('a review cancelled by a push dismisses no approval', async () => {
    const reviews = [{ id: 5, state: 'APPROVED', user: { login: QUILL_LOGIN } }];
    const github = fakeGitHub({ reviews });
    const queue = new ReviewQueue(() => 1);
    await queue.enqueue(new Review(event(), { github: github.github, readResult, runContainer: hangingContainer().run }));
    await Bun.sleep(0);
    const dismissals = () => github.calls.filter((call) => call.path.endsWith('/dismissals'));
    // The starting review dismisses the approval it found; the cancel dismisses nothing more.
    expect(dismissals()).toHaveLength(1);
    await queue.cancel('plume-works/images#7');
    expect(dismissals()).toHaveLength(1);
    expect(github.checkRun().at(-1)).toBe('cancelled');
  });

  test('a review without the label on ends cleanly', async () => {
    const github = await reviewEnding('success', fakeGitHub({ labelPresent: false }));
    expect(github.checkRun()).toEqual(['queued', 'in_progress', 'success']);
  });

  test('a review whose container cannot start completes as failure', async () => {
    const github = fakeGitHub();
    const review = new Review(event(), {
      github: github.github,
      readResult,
      runContainer: async () => {
        throw new Error('no reviewer token');
      },
    });
    await review.queued();
    await review.run(new AbortController().signal);
    expect(github.checkRun()).toEqual(['queued', 'in_progress', 'failure']);
  });
});

describe('the service posts the review', () => {
  test('the service posts the result on the reviewed commit', async () => {
    const github = await reviewEnding('success');
    expect(github.posted()).toEqual([
      { method: 'POST', path: `${REPO}/pulls/7/reviews`, body: { commit_id: HEAD, ...RESULT } },
    ]);
    expect(github.checkRun()).toEqual(['queued', 'in_progress', 'success']);
    const order = github.calls.map((call) => `${call.method} ${call.path}`);
    expect(order.indexOf(`POST ${REPO}/pulls/7/reviews`)).toBeLessThan(
      order.lastIndexOf(`PATCH ${REPO}/check-runs/99`),
    );
  });

  test('a review whose container fails reads and posts nothing', async () => {
    let read = false;
    const github = await reviewEnding('failure', fakeGitHub(), async () => {
      read = true;
      return JSON.stringify(RESULT);
    });
    expect(read).toBe(false);
    expect(github.posted()).toEqual([]);
  });

  test.each([
    ['no result file', undefined],
    ['text that is not JSON', 'Review written.'],
    ['an unknown event', JSON.stringify({ ...RESULT, event: 'MERGE' })],
    ['a body that is not text', JSON.stringify({ ...RESULT, body: 7 })],
    ['comments that are not a list', JSON.stringify({ ...RESULT, comments: {} })],
    ['a comment without a line', JSON.stringify({ ...RESULT, comments: [{ path: 'a', side: 'RIGHT', body: 'b' }] })],
    ['a comment on an unknown side', JSON.stringify({ ...RESULT, comments: [{ ...RESULT.comments[0], side: 'UP' }] })],
  ])('a review without a usable result fails and posts nothing: %s', async (_, text) => {
    const github = await reviewEnding('success', fakeGitHub(), async () => text);
    expect(github.posted()).toEqual([]);
    expect(github.checkRun()).toEqual(['queued', 'in_progress', 'failure']);
  });

  test('a review without a usable result fails and posts nothing: GitHub refuses it', async () => {
    const github = await reviewEnding('success', fakeGitHub({ refuseReview: true }));
    expect(github.posted()).toHaveLength(1);
    expect(github.checkRun()).toEqual(['queued', 'in_progress', 'failure']);
  });

  test('a cancelled review posts nothing', async () => {
    const github = fakeGitHub();
    const queue = new ReviewQueue(() => 1);
    // The container exits 0 just as the cancel stops it.
    const runContainer = (signal: AbortSignal) =>
      new Promise<ContainerOutcome>((resolve) => signal.addEventListener('abort', () => resolve('success')));
    await queue.enqueue(new Review(event(), { github: github.github, readResult, runContainer }));
    await Bun.sleep(0);
    await queue.cancel('plume-works/images#7');
    expect(github.posted()).toEqual([]);
    expect(github.checkRun().at(-1)).toBe('cancelled');
  });

  test('a cancelled review posts nothing: a push during the post leaves the review on its commit', async () => {
    let answer!: () => void;
    const github = fakeGitHub({ holdReview: new Promise<void>((resolve) => (answer = resolve)) });
    const queue = new ReviewQueue(() => 1);
    await queue.enqueue(new Review(event(), { github: github.github, readResult, runContainer: async () => 'success' }));
    while (github.posted().length === 0) {
      await Bun.sleep(0);
    }
    const cancelled = queue.cancel('plume-works/images#7');
    answer();
    await cancelled;
    expect(github.posted()[0]!.body?.commit_id).toBe(HEAD);
    expect(github.checkRun().at(-1)).toBe('success');
    expect(github.calls.filter((call) => call.path.endsWith('/dismissals'))).toEqual([]);
  });
});
