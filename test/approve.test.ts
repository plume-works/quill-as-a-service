import { describe, expect, test } from 'bun:test';
import {
  type Activity,
  approveTrustedBot,
  botApprovalFailure,
  type Commit,
  isTrustedBotPullRequest,
} from '../src/approve';
import { GitHub } from '../src/github';
import { QUILL_LOGIN } from '../src/review';
import type { PullRequestEvent } from '../src/webhook';

const BOT = 'acme-bot[bot]';
const SHA = 'a'.repeat(40);

const commit = (
  sha: string,
  { author = BOT as string | null, committer = BOT as string | null, verified = true, reason = undefined as string | undefined } = {},
): Commit => ({
  sha,
  author: author ? { login: author } : null,
  committer: committer ? { login: committer } : null,
  commit: { verification: { verified, reason } },
});
const activity = (type: string, actor = BOT): Activity => ({ activity_type: type, actor: { login: actor }, after: SHA });
const created = [activity('branch_creation')];

// The cases of .github/actions/ai-review-status/review-gate.test.js that cover botApprovalFailure.
describe('trusted-bot pull requests are approved without an AI review', () => {
  test.each([
    ['own commits', [commit('1'), commit('2', { committer: 'web-flow' })], ''],
    ['foreign author', [commit('1', { author: 'dev' })], 'commit 1: author is dev'],
    ['no author', [commit('1', { author: null })], 'commit 1: author is not a GitHub account'],
    ['foreign committer', [commit('1', { committer: 'dev' })], 'commit 1: committer is dev'],
    ['unsigned', [commit('1', { verified: false, reason: 'unsigned' })], 'commit 1: signature is not verified (unsigned)'],
  ])('approval covers only the own commits: %s', (_, commits, expected) => {
    expect(botApprovalFailure(BOT, created, commits)).toBe(expected);
  });

  test.each(['push', 'force_push', 'branch_creation'])('a foreign %s refuses the approval', (type) => {
    const activities = [activity('push'), activity(type, 'dev')];
    if (type !== 'branch_creation') {
      activities.push(activity('branch_creation'));
    }
    expect(botApprovalFailure(BOT, activities, [commit('1')])).toBe(`${type} to ${SHA} by dev`);
  });

  test('a reused branch starts clean at its latest creation', () => {
    const activities = [activity('push'), activity('branch_creation'), activity('push', 'dev')];
    expect(botApprovalFailure(BOT, activities, [commit('1')])).toBe('');
  });
});

function event({ login = BOT, type = 'Bot', action = 'synchronize', head = 'plume-works/images' } = {}): PullRequestEvent {
  return {
    action,
    sender: { login },
    installation: { id: 42 },
    repository: { full_name: 'plume-works/images', name: 'images', owner: { login: 'plume-works' } },
    pull_request: {
      number: 9,
      draft: false,
      labels: [],
      user: { login, type },
      head: { sha: SHA, ref: 'renovate/core', repo: { full_name: head } },
    },
  };
}

describe('which pull requests the approval covers', () => {
  test.each([
    ['a trusted bot', {}, true],
    ['a bot not in the configuration', { login: 'other[bot]' }, false],
    ['a user with a trusted login', { type: 'User' }, false],
    ['a fork', { head: 'someone/images' }, false],
    ['a label event', { action: 'labeled' }, false],
  ])('%s: %p', (_, shape, expected) => {
    expect(isTrustedBotPullRequest(event(shape), [BOT])).toBe(expected);
  });
});

/** A GitHub that holds a pull request's reviews, push activities, and commits. */
function fakeGitHub(state: { reviews: unknown[]; activities: Activity[]; commits: Commit[] }) {
  const writes: { method: string; path: string; body: Record<string, unknown> }[] = [];
  const fetchFn = async (url: string, init?: RequestInit) => {
    const { pathname, searchParams } = new URL(url);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      const body = JSON.parse(String(init?.body));
      writes.push({ method, path: pathname, body });
      if (method === 'POST') {
        state.reviews.push({ id: 100 + writes.length, state: 'APPROVED', user: { login: QUILL_LOGIN } });
      }
      return Response.json({});
    }
    if (pathname.endsWith('/activity')) {
      expect(searchParams.get('ref')).toBe('refs/heads/renovate/core');
      return Response.json(state.activities);
    }
    return Response.json(pathname.endsWith('/commits') ? state.commits : state.reviews);
  };
  return { github: new GitHub('ghs_service', fetchFn), writes };
}

describe('the approval on GitHub', () => {
  test('approves a trusted bot and withdraws on a foreign push', async () => {
    const state = { reviews: [] as unknown[], activities: [...created], commits: [commit('1')] };
    const { github, writes } = fakeGitHub(state);

    expect(await approveTrustedBot(event(), github)).toBe('approved');
    expect(writes).toEqual([
      {
        method: 'POST',
        path: '/repos/plume-works/images/pulls/9/reviews',
        body: expect.objectContaining({ event: 'APPROVE', commit_id: SHA }),
      },
    ]);

    expect(await approveTrustedBot(event(), github)).toBe('already approved');
    expect(writes).toHaveLength(1);

    state.activities.unshift(activity('push', 'dev'));
    expect(await approveTrustedBot(event(), github)).toBe(`not approved: push to ${SHA} by dev`);
    expect(writes.at(-1)).toEqual({
      method: 'PUT',
      path: '/repos/plume-works/images/pulls/9/reviews/101/dismissals',
      body: { event: 'DISMISS', message: `Trusted-bot approval withdrawn: push to ${SHA} by dev.` },
    });
  });

  test('a foreign commit withdraws the approval', async () => {
    const state = {
      reviews: [{ id: 5, state: 'APPROVED', user: { login: QUILL_LOGIN } }] as unknown[],
      activities: [...created],
      commits: [commit('1'), commit('2', { author: 'dev' })],
    };
    const { github, writes } = fakeGitHub(state);
    expect(await approveTrustedBot(event(), github)).toBe('not approved: commit 2: author is dev');
    expect(writes).toEqual([
      {
        method: 'PUT',
        path: '/repos/plume-works/images/pulls/9/reviews/5/dismissals',
        body: { event: 'DISMISS', message: 'Trusted-bot approval withdrawn: commit 2: author is dev.' },
      },
    ]);
  });
});
