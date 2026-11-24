import { describe, expect, test } from 'bun:test';
import { BLOCK_LABEL, cancelsReview, headIsCurrent, REQUEST_LABEL, wantsReview } from '../src/decide';
import { GitHub } from '../src/github';
import type { PullRequestEvent } from '../src/webhook';

const REPOSITORY = 'plume-works/images';

interface Shape {
  action?: string;
  label?: string;
  labels?: string[];
  draft?: boolean;
  authorType?: string;
  headRepository?: string | null;
}

function event({
  action = 'opened',
  label,
  labels = [],
  draft = false,
  authorType = 'User',
  headRepository = REPOSITORY,
}: Shape = {}): PullRequestEvent {
  return {
    action,
    label: label ? { name: label } : undefined,
    sender: { login: 'dev' },
    installation: { id: 1 },
    repository: { full_name: REPOSITORY, name: 'images', owner: { login: 'plume-works' } },
    pull_request: {
      number: 7,
      draft,
      labels: labels.map((name) => ({ name })),
      user: { login: 'dev', type: authorType },
      head: { sha: 'a'.repeat(40), ref: 'topic', repo: headRepository ? { full_name: headRepository } : null },
    },
  };
}

const reviews = (shape: Shape, facts: { paused?: boolean; senderPermission?: string } = {}) =>
  wantsReview({ event: event(shape), paused: facts.paused ?? false, ...facts });

describe('which events start a review', () => {
  test('reviews on opened, reopened, and ready_for_review', () => {
    for (const action of ['opened', 'reopened', 'ready_for_review']) {
      expect(reviews({ action })).toBe(true);
    }
  });

  test('does not review on other actions', () => {
    for (const action of ['closed', 'edited', 'converted_to_draft', 'unlabeled', 'synchronize']) {
      expect(reviews({ action })).toBe(false);
    }
  });

  test('reviews on the request label from a writer only', () => {
    const added = { action: 'labeled', label: REQUEST_LABEL, labels: [REQUEST_LABEL] };
    for (const senderPermission of ['admin', 'maintain', 'write']) {
      expect(reviews(added, { senderPermission })).toBe(true);
    }
    for (const senderPermission of ['triage', 'read', 'none', undefined]) {
      expect(reviews(added, { senderPermission })).toBe(false);
    }
  });

  test('another label from a writer starts nothing', () => {
    expect(reviews({ action: 'labeled', label: 'bug', labels: ['bug'] }, { senderPermission: 'admin' })).toBe(false);
  });

  test('a push with the request label on reviews the new head', () => {
    expect(reviews({ action: 'synchronize', labels: [REQUEST_LABEL] })).toBe(true);
  });

  test('skips forks, drafts, and bot authors', () => {
    expect(reviews({ headRepository: 'someone/images' })).toBe(false);
    expect(reviews({ headRepository: null })).toBe(false);
    expect(reviews({ draft: true })).toBe(false);
    expect(reviews({ authorType: 'Bot' })).toBe(false);
    const requested = { action: 'labeled', label: REQUEST_LABEL, labels: [REQUEST_LABEL] };
    expect(reviews({ ...requested, draft: true }, { senderPermission: 'admin' })).toBe(false);
    expect(reviews({ ...requested, authorType: 'Bot' }, { senderPermission: 'admin' })).toBe(false);
  });

  test('skips blocked pull requests and a paused service', () => {
    expect(reviews({ labels: [BLOCK_LABEL] })).toBe(false);
    expect(reviews({ action: 'opened' }, { paused: true })).toBe(false);
    const requested = { action: 'labeled', label: REQUEST_LABEL };
    expect(reviews({ ...requested, labels: [REQUEST_LABEL, BLOCK_LABEL] }, { senderPermission: 'admin' })).toBe(false);
    expect(reviews({ ...requested, labels: [REQUEST_LABEL] }, { senderPermission: 'admin', paused: true })).toBe(false);
    expect(reviews({ action: 'synchronize', labels: [REQUEST_LABEL] }, { paused: true })).toBe(false);
  });
});

describe('which events cancel a review', () => {
  const cancels = (shape: Shape, paused = false) => cancelsReview({ event: event(shape), paused });

  test('a push without the request label cancels the review of the old head', () => {
    expect(cancels({ action: 'synchronize' })).toBe(true);
    expect(cancels({ action: 'synchronize', labels: [BLOCK_LABEL] })).toBe(true);
    expect(cancels({ action: 'synchronize', labels: [REQUEST_LABEL] }, true)).toBe(true);
  });

  test('a push that queues a review, or another action, cancels nothing', () => {
    expect(cancels({ action: 'synchronize', labels: [REQUEST_LABEL] })).toBe(false);
    for (const action of ['opened', 'edited', 'labeled', 'unlabeled', 'closed']) {
      expect(cancels({ action })).toBe(false);
    }
  });
});

describe('a review runs on the current head only', () => {
  /** A GitHub whose pull request 7 has head `sha`, recording the paths it is asked for. */
  function pullRequestAt(sha: string) {
    const paths: string[] = [];
    const github = new GitHub('ghs_service', async (url) => {
      paths.push(new URL(url).pathname);
      return Response.json({ head: { sha } });
    });
    return { github, paths };
  }

  test('a delivery of the current head reviews it', async () => {
    const { github, paths } = pullRequestAt('a'.repeat(40));
    expect(await headIsCurrent(event({ action: 'labeled' }), github)).toBe(true);
    expect(paths).toEqual([`/repos/${REPOSITORY}/pulls/7`]);
  });

  test('a delivery of a head a push has moved reviews nothing', async () => {
    const { github } = pullRequestAt('b'.repeat(40));
    expect(await headIsCurrent(event({ action: 'labeled' }), github)).toBe(false);
  });
});
