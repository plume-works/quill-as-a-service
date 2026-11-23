import { type App, installationToken } from './github';
import type { PullRequestEvent } from './webhook';

export const REVIEW_TIMEOUT_MS = 30 * 60 * 1000;

/** What the reviewer's installation token may do: read the code, post the review and comments. */
export const REVIEWER_PERMISSIONS = { contents: 'read', pull_requests: 'write', issues: 'write' };

export type ContainerOutcome = 'success' | 'failure' | 'timeout' | 'cancelled';

export interface Docker {
  /** Run `docker` with the `create` `args`; `env` holds values the `--env NAME` arguments pass on. */
  create(args: string[], env: Record<string, string>): Promise<number>;
  /** Start the created container; `exited` resolves to the container's exit status. */
  start(name: string): { exited: Promise<number> };
  stop(name: string): Promise<void>;
}

export const docker: Docker = {
  create(args, env) {
    return Bun.spawn(['docker', ...args], {
      env: { ...process.env, ...env },
      stdout: 'ignore',
      stderr: 'inherit',
    }).exited;
  },
  start(name) {
    const process_ = Bun.spawn(['docker', 'start', '--attach', name], { stdout: 'ignore', stderr: 'inherit' });
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

/** The `docker create` arguments; no `--rm`, so the stopped container keeps the review's log. */
export const createArgs = (name: string, image: string, env: Record<string, string>): string[] => [
  'create',
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
  let started = false;
  let stoppedFor: 'timeout' | 'cancelled' | undefined;
  const stop = (reason: 'timeout' | 'cancelled') => {
    stoppedFor ??= reason;
    // Before the start there is no running container to stop; the start is skipped instead.
    if (started) {
      void engine.stop(name);
    }
  };
  const clearTimer = setTimer(() => stop('timeout'), REVIEW_TIMEOUT_MS);
  const onAbort = () => stop('cancelled');
  signal.addEventListener('abort', onAbort);
  try {
    const created = await engine.create(createArgs(name, image, env), env);
    if (stoppedFor) {
      return stoppedFor;
    }
    if (created !== 0) {
      return 'failure';
    }
    started = true;
    const status = await engine.start(name).exited;
    return stoppedFor ?? (status === 0 ? 'success' : 'failure');
  } finally {
    clearTimer();
    signal.removeEventListener('abort', onAbort);
  }
}
