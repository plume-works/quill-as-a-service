import type { GitHub } from './github';
import type { PullRequestEvent } from './webhook';

export const REQUEST_LABEL = 'request-ai-review';
export const BLOCK_LABEL = 'block-ai-reviews';

const WRITERS = ['admin', 'maintain', 'write'];

export interface Decision {
  event: PullRequestEvent;
  paused: boolean;
  /** The sender's permission on the repository; read only when the request label is added. */
  senderPermission?: string;
}

/** Return whether the sender's permission must be read before deciding. */
export const needsSenderPermission = (event: PullRequestEvent): boolean =>
  event.action === 'labeled' && event.label?.name === REQUEST_LABEL;

const hasLabel = (event: PullRequestEvent, name: string): boolean =>
  event.pull_request.labels.some((label) => label.name === name);

/** Decide whether this event queues a review of the pull request's head (agent-devcontainer ADR-0103, "A review starts on open or on request"). */
export function wantsReview({ event, paused, senderPermission }: Decision): boolean {
  const pullRequest = event.pull_request;
  if (
    paused ||
    pullRequest.head.repo?.full_name !== event.repository.full_name ||
    pullRequest.draft ||
    pullRequest.user.type === 'Bot' ||
    hasLabel(event, BLOCK_LABEL)
  ) {
    return false;
  }
  switch (event.action) {
    case 'opened':
    case 'reopened':
    case 'ready_for_review':
      return true;
    case 'labeled':
      return needsSenderPermission(event) && WRITERS.includes(senderPermission ?? '');
    case 'synchronize':
      // A push while the request label is on restarts the review on the new head.
      return hasLabel(event, REQUEST_LABEL);
    default:
      return false;
  }
}

/** Decide whether this event cancels the pull request's review: a push that queues none leaves it on an old head. */
export const cancelsReview = (decision: Decision): boolean =>
  decision.event.action === 'synchronize' && !wantsReview(decision);

/** Return whether the event's head is still the pull request's head; a newer delivery carries a moved one. */
export async function headIsCurrent(event: PullRequestEvent, github: GitHub): Promise<boolean> {
  const { head } = await github.request<{ head: { sha: string } }>(
    'GET',
    `/repos/${event.repository.full_name}/pulls/${event.pull_request.number}`,
  );
  return head.sha === event.pull_request.head.sha;
}
