import { type App, installationToken } from './github';
import type { PullRequestEvent } from './webhook';

export const REVIEW_TIMEOUT_MS = 30 * 60 * 1000;

/** What the reviewer's installation token may do: read the code, post the review and comments. */
export const REVIEWER_PERMISSIONS = { contents: 'read', pull_requests: 'write', issues: 'write' };

export type ContainerOutcome = 'success' | 'failure' | 'timeout' | 'cancelled';

export interface Docker {
  /** Start `docker` with `args`; `env` holds values the `-e NAME` arguments pass on. */
  run(args: string[], env: Record<string, string>): { exited: Promise<number> };
  stop(name: string): Promise<void>;
}

export const docker: Docker = {
  run(args, env) {
    const process_ = Bun.spawn(['docker', ...args], {
      env: { ...process.env, ...env },
      stdout: 'ignore',
      stderr: 'inherit',
    });
    return { exited: process_.exited };
  },
  async stop(name) {
    await Bun.spawn(['docker', 'stop', '--time', '30', name], { stdout: 'ignore' }).exited;
  },
};

export type SetTimer = (callback: () => void, ms: number) => () => void;

const realTimer: SetTimer = (callback, ms) => {
  const handle = setTimeout(callback, ms);
  return () => clearTimeout(handle);
};

/** Ask for an installation token limited to the pull request's one repository. */
export const reviewerToken = (app: App, event: PullRequestEvent): Promise<string> =>
  installationToken(app, event.installation.id, [event.repository.name], REVIEWER_PERMISSIONS);

export interface ContainerRun {
  image: string;
  name: string;
  env: Record<string, string>;
  signal: AbortSignal;
  docker?: Docker;
  setTimer?: SetTimer;
}

/** The `docker run` arguments; no `--rm`, so the stopped container keeps the review's log. */
export const runArgs = (name: string, image: string, env: Record<string, string>): string[] => [
  'run',
  '--name',
  name,
  ...Object.keys(env).flatMap((key) => ['--env', key]),
  image,
];

/** Run one reviewer container to its end, stopping it at the timeout or on cancel. */
export async function runContainer({
  image,
  name,
  env,
  signal,
  docker: engine = docker,
  setTimer = realTimer,
}: ContainerRun): Promise<ContainerOutcome> {
  if (signal.aborted) {
    return 'cancelled';
  }
  const { exited } = engine.run(runArgs(name, image, env), env);
  let stoppedFor: 'timeout' | 'cancelled' | undefined;
  const stop = (reason: 'timeout' | 'cancelled') => {
    stoppedFor ??= reason;
    void engine.stop(name);
  };
  const clearTimer = setTimer(() => stop('timeout'), REVIEW_TIMEOUT_MS);
  const onAbort = () => stop('cancelled');
  signal.addEventListener('abort', onAbort);
  try {
    const status = await exited;
    return stoppedFor ?? (status === 0 ? 'success' : 'failure');
  } finally {
    clearTimer();
    signal.removeEventListener('abort', onAbort);
  }
}
