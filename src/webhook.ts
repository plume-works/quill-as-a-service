import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Config } from './config';

export interface Label {
  name: string;
}

export interface PullRequestEvent {
  action: string;
  label?: Label;
  sender: { login: string; type?: string };
  installation: { id: number };
  repository: { full_name: string; name: string; owner: { login: string } };
  pull_request: {
    number: number;
    draft: boolean;
    labels: Label[];
    user: { login: string; type: string };
    head: { sha: string; ref: string; repo: { full_name: string } | null };
  };
}

export interface WebhookOptions {
  secret: string;
  config: () => Config;
  onPullRequest: (event: PullRequestEvent) => void;
}

/** Return whether `signature` is GitHub's X-Hub-Signature-256 of `body` under `secret`. */
export function signatureMatches(secret: string, body: string, signature: string | null): boolean {
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`);
  const given = Buffer.from(signature ?? '');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Answer one webhook delivery; only a signed pull_request event of a configured repository acts. */
export async function handleWebhook(request: Request, options: WebhookOptions): Promise<Response> {
  const body = await request.text();
  if (!signatureMatches(options.secret, body, request.headers.get('x-hub-signature-256'))) {
    return new Response('bad signature\n', { status: 401 });
  }
  if (request.headers.get('x-github-event') !== 'pull_request') {
    return new Response('ignored: not a pull_request event\n', { status: 200 });
  }
  const event = JSON.parse(body) as PullRequestEvent;
  if (!options.config().repositories.includes(event.repository.full_name)) {
    return new Response('ignored: repository not configured\n', { status: 200 });
  }
  options.onPullRequest(event);
  return new Response('accepted\n', { status: 202 });
}
