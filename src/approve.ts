import type { GitHub } from './github';
import { QUILL_LOGIN } from './review';
import type { PullRequestEvent } from './webhook';

const PUSH_ACTIVITIES = ['branch_creation', 'push', 'force_push'];
const APPROVAL_ACTIONS = ['opened', 'reopened', 'synchronize', 'ready_for_review'];

export interface Activity {
  activity_type: string;
  actor?: { login: string } | null;
  after?: string;
}

export interface Commit {
  sha: string;
  author?: { login: string } | null;
  committer?: { login: string } | null;
  commit?: { verification?: { verified?: boolean; reason?: string } };
}

function commitFailure(commit: Commit, login: string): string {
  if (commit.author?.login !== login) {
    return `author is ${commit.author?.login ?? 'not a GitHub account'}`;
  }
  const committer = commit.committer?.login;
  if (committer !== login && committer !== 'web-flow') {
    return `committer is ${committer ?? 'not a GitHub account'}`;
  }
  if (commit.commit?.verification?.verified !== true) {
    return `signature is not verified (${commit.commit?.verification?.reason ?? 'unknown'})`;
  }
  return '';
}

/**
 * Return why the trusted bot `login` gets no approval, or '' to approve (agent-devcontainer ADR-0102, "The required approval is the only gate of the AI review").
 * `activities` starts with the newest; only those since the branch's latest creation count.
 */
export function botApprovalFailure(login: string, activities: Activity[], commits: Commit[]): string {
  const created = activities.findIndex((activity) => activity.activity_type === 'branch_creation');
  const current = created === -1 ? activities : activities.slice(0, created + 1);
  const foreignPush = current.find(
    (activity) => PUSH_ACTIVITIES.includes(activity.activity_type) && activity.actor?.login !== login,
  );
  if (foreignPush) {
    return `${foreignPush.activity_type} to ${foreignPush.after} by ${foreignPush.actor?.login ?? 'an unknown actor'}`;
  }
  for (const commit of commits) {
    const reason = commitFailure(commit, login);
    if (reason) {
      return `commit ${commit.sha}: ${reason}`;
    }
  }
  return '';
}

/** Return whether the event is a configured trusted bot's pull request that the approval covers. */
export function isTrustedBotPullRequest(event: PullRequestEvent, trustedBots: string[]): boolean {
  const pullRequest = event.pull_request;
  return (
    APPROVAL_ACTIONS.includes(event.action) &&
    pullRequest.user.type === 'Bot' &&
    trustedBots.includes(pullRequest.user.login) &&
    pullRequest.head.repo?.full_name === event.repository.full_name
  );
}

/** Approve the trusted bot's pull request once, or dismiss Quill's approval when it stops holding. */
export async function approveTrustedBot(event: PullRequestEvent, github: GitHub): Promise<string> {
  const login = event.pull_request.user.login;
  const repo = `/repos/${event.repository.full_name}`;
  const pulls = `${repo}/pulls/${event.pull_request.number}`;
  const reviews = await github.paginate<{ id: number; state: string; user: { login: string } | null }>(
    `${pulls}/reviews?per_page=100`,
  );
  const approvals = reviews.filter((review) => review.user?.login === QUILL_LOGIN && review.state === 'APPROVED');
  const ref = encodeURIComponent(`refs/heads/${event.pull_request.head.ref}`);
  const activities = await github.paginate<Activity>(
    `${repo}/activity?ref=${ref}&direction=desc&per_page=100`,
    (page) => page.some((activity) => activity.activity_type === 'branch_creation'),
  );
  const commits = await github.paginate<Commit>(`${pulls}/commits?per_page=100`);
  const failure = botApprovalFailure(login, activities, commits);
  if (failure) {
    for (const review of approvals) {
      await github.request('PUT', `${pulls}/reviews/${review.id}/dismissals`, {
        event: 'DISMISS',
        message: `Trusted-bot approval withdrawn: ${failure}.`,
      });
    }
    return `not approved: ${failure}`;
  }
  if (approvals.length > 0) {
    return 'already approved';
  }
  await github.request('POST', `${pulls}/reviews`, {
    event: 'APPROVE',
    // Bind the approval to the head that was checked, never to a later push.
    commit_id: event.pull_request.head.sha,
    body: `AI review skipped: this pull request is authored by ${login}, a trusted bot. Approving on its behalf.`,
  });
  return 'approved';
}
