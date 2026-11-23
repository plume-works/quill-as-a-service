import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import type { Config } from '../src/config';
import { handleWebhook, type PullRequestEvent } from '../src/webhook';

const SECRET = 'webhook-secret';
const config: Config = {
  repositories: ['plume-works/images'],
  trustedBots: [],
  paused: false,
  maxConcurrentReviews: 5,
};

const sign = (body: string, secret = SECRET) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

function delivery(event: string, payload: unknown, signature?: string): Request {
  const body = JSON.stringify(payload);
  return new Request('http://quill/webhook', {
    method: 'POST',
    body,
    headers: {
      'x-github-event': event,
      'x-hub-signature-256': signature ?? sign(body),
    },
  });
}

const pullRequest = (repository: string) => ({
  action: 'opened',
  repository: { full_name: repository },
  pull_request: { number: 1 },
});

async function deliver(request: Request) {
  const received: PullRequestEvent[] = [];
  const response = await handleWebhook(request, {
    secret: SECRET,
    config: () => config,
    onPullRequest: (event) => received.push(event),
  });
  return { status: response.status, received };
}

describe('webhook deliveries', () => {
  test('rejects a delivery with a bad signature', async () => {
    const payload = pullRequest('plume-works/images');
    for (const signature of ['', 'sha256=00', sign(JSON.stringify(payload), 'other-secret')]) {
      const { status, received } = await deliver(delivery('pull_request', payload, signature));
      expect(status).toBe(401);
      expect(received).toEqual([]);
    }
  });

  test('takes a signed pull_request event of a configured repository', async () => {
    const { status, received } = await deliver(
      delivery('pull_request', pullRequest('plume-works/images')),
    );
    expect(status).toBe(202);
    expect(received).toHaveLength(1);
  });

  test('ignores an event other than pull_request', async () => {
    for (const event of ['push', 'issue_comment', 'pull_request_review']) {
      const { status, received } = await deliver(delivery(event, pullRequest('plume-works/images')));
      expect(status).toBe(200);
      expect(received).toEqual([]);
    }
  });

  test('ignores a repository outside the configuration', async () => {
    const { status, received } = await deliver(
      delivery('pull_request', pullRequest('plume-works/elsewhere')),
    );
    expect(status).toBe(200);
    expect(received).toEqual([]);
  });
});
