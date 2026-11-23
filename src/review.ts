import { REQUEST_LABEL } from './decide';
import { GitHub, GitHubError } from './github';
import type { CancelReason, Job } from './queue';
import type { ContainerOutcome } from './reviewer';
import type { PullRequestEvent } from './webhook';

export const CHECK_NAME = 'Quill Review';
export const QUILL_LOGIN = 'plume-works-quill[bot]';

const CONCLUSIONS = {
  success: 'success',
  failure: 'failure',
  timeout: 'failure',
  cancelled: 'cancelled',
} as const;

const SUMMARIES: Record<ContainerOutcome, string> = {
  success: 'The review finished.',
  failure: 'The review failed; the reviewer container keeps its log.',
  timeout: 'The review was stopped after 30 minutes.',
  cancelled: 'A newer review of this pull request replaced this one.',
};

const RERUN_HINT = `Remove and re-add the \`${REQUEST_LABEL}\` label to run it again.`;
export const STOPPED_SUMMARY = `The Quill service stopped before the review finished. ${RERUN_HINT}`;
export const RESTARTED_SUMMARY = `The Quill service restarted before the review finished. ${RERUN_HINT}`;

export interface ReviewDeps {
  /** A client for the pull request's repository. */
  github: () => Promise<GitHub>;
  /** Run the reviewer container for this review's head. */
  runContainer: (signal: AbortSignal) => Promise<ContainerOutcome>;
}

interface PullRequestReview {
  id: number;
  state: string;
  user: { login: string } | null;
}

/** One review of one head, reported as a `Quill Review` check run on that head. */
export class Review implements Job {
  readonly key: string;
  private readonly repo: string;
  private readonly number: number;
  private checkRunId?: number;

  constructor(
    private readonly event: PullRequestEvent,
    private readonly deps: ReviewDeps,
  ) {
    this.repo = `/repos/${event.repository.full_name}`;
    this.number = event.pull_request.number;
    this.key = `${event.repository.full_name}#${this.number}`;
  }

  async queued(): Promise<void> {
    const github = await this.deps.github();
    const checkRun = await github.request<{ id: number }>('POST', `${this.repo}/check-runs`, {
      name: CHECK_NAME,
      head_sha: this.event.pull_request.head.sha,
      status: 'queued',
    });
    this.checkRunId = checkRun.id;
  }

  async run(signal: AbortSignal): Promise<void> {
    let outcome: ContainerOutcome = 'failure';
    try {
      const github = await this.deps.github();
      await this.updateCheckRun(github, { status: 'in_progress', started_at: new Date().toISOString() });
      await this.dismissApprovals(github);
      outcome = await this.deps.runContainer(signal);
    } catch (error) {
      console.error(`${this.key}: the review failed`, error);
      outcome = signal.aborted ? 'cancelled' : 'failure';
    }
    await this.finish(outcome, signal.reason);
  }

  cancel(reason: CancelReason = 'replaced'): Promise<void> {
    return this.finish('cancelled', reason);
  }

  /** agent-devcontainer ADR-0103 ("A review starts on open or on request"): a new review withdraws Quill's approval; a change request stays. */
  private async dismissApprovals(github: GitHub): Promise<void> {
    const reviews = await github.paginate<PullRequestReview>(
      `${this.repo}/pulls/${this.number}/reviews?per_page=100`,
    );
    for (const review of reviews) {
      if (review.user?.login === QUILL_LOGIN && review.state === 'APPROVED') {
        await github.request('PUT', `${this.repo}/pulls/${this.number}/reviews/${review.id}/dismissals`, {
          event: 'DISMISS',
          message: 'A new Quill review started.',
        });
      }
    }
  }

  private async finish(outcome: ContainerOutcome, reason?: CancelReason): Promise<void> {
    const github = await this.deps.github();
    const stopped = outcome === 'cancelled' && reason === 'shutdown';
    await this.updateCheckRun(github, {
      status: 'completed',
      conclusion: CONCLUSIONS[outcome],
      completed_at: new Date().toISOString(),
      output: { title: CHECK_NAME, summary: stopped ? STOPPED_SUMMARY : SUMMARIES[outcome] },
    });
    // A cancelled review leaves the label for the review that replaced it.
    if (outcome !== 'cancelled') {
      await this.removeRequestLabel(github);
    }
  }

  private async updateCheckRun(github: GitHub, fields: Record<string, unknown>): Promise<void> {
    if (this.checkRunId !== undefined) {
      await github.request('PATCH', `${this.repo}/check-runs/${this.checkRunId}`, fields);
    }
  }

  private async removeRequestLabel(github: GitHub): Promise<void> {
    try {
      await github.request(
        'DELETE',
        `${this.repo}/issues/${this.number}/labels/${encodeURIComponent(REQUEST_LABEL)}`,
      );
    } catch (error) {
      // The label was not on the pull request.
      if (!(error instanceof GitHubError && error.status === 404)) {
        throw error;
      }
    }
  }
}
