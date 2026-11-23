import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type App, installationToken } from './github';
import type { PullRequestEvent } from './webhook';

export const REVIEW_TIMEOUT_MS = 30 * 60 * 1000;
/** How often a stop is sent again until the container exits; one sent as it starts misses it. */
export const STOP_RESEND_MS = 5 * 1000;
/** Where the reviewer writes the review the service posts. */
export const RESULT_PATH = '/review/result.json';

/** What the reviewer's installation token may do: read the code and the pull request (ADR-0003). */
export const REVIEWER_PERMISSIONS = { contents: 'read', pull_requests: 'read' };

export type ContainerOutcome = 'success' | 'failure' | 'timeout' | 'cancelled';

export interface Docker {
  /** Run `docker` with the `create` `args`; `env` holds values the `--env NAME` arguments pass on. */
  create(args: string[], env: Record<string, string>): Promise<number>;
  /** Start the created container; `exited` resolves to the container's exit status. */
  start(name: string): { exited: Promise<number> };
  stop(name: string): Promise<void>;
  /** Copy the file at `path` out of the container; undefined when it holds none. */
  readFile(name: string, path: string): Promise<string | undefined>;
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
  async readFile(name, path) {
    const dir = await mkdtemp(join(tmpdir(), 'quill-'));
    try {
      const copy = Bun.spawn(['docker', 'cp', `${name}:${path}`, join(dir, 'file')], { stdout: 'ignore' });
      return (await copy.exited) === 0 ? await readFile(join(dir, 'file'), 'utf8') : undefined;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
};

/** Copy the review's result out of the stopped reviewer container `name`. */
export const readResult = (name: string, engine: Docker = docker): Promise<string | undefined> =>
  engine.readFile(name, RESULT_PATH);

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
  let exited = false;
  let stoppedFor: 'timeout' | 'cancelled' | undefined;
  let clearResend = () => {};
  const sendStop = () => {
    clearResend();
    if (!exited) {
      void engine.stop(name);
      clearResend = setTimer(sendStop, STOP_RESEND_MS);
    }
  };
  const stop = (reason: 'timeout' | 'cancelled') => {
    stoppedFor ??= reason;
    // Before the start there is no running container to stop; the start is skipped instead.
    if (started) {
      sendStop();
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
    exited = true;
    clearResend();
    clearTimer();
    signal.removeEventListener('abort', onAbort);
  }
}
