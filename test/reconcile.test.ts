import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { GitHub } from '../src/github';
import { reconcile } from '../src/reconcile';
import { CHECK_NAME, RESTARTED_SUMMARY } from '../src/review';

interface Call {
  token: string;
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

const run = (id: number, status: string) => ({ id, status });

/** A GitHub where only plume-works/images has the App, with two open pull requests. */
function fakeGitHub({ failing = false } = {}) {
  const calls: Call[] = [];
  const fetchFn = async (url: string, init?: RequestInit) => {
    const { pathname, searchParams } = new URL(url);
    const method = init?.method ?? 'GET';
    const token = new Headers(init?.headers).get('authorization')!.slice('Bearer '.length);
    calls.push({ token, method, path: pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (failing) {
      return new Response('unavailable', { status: 503 });
    }
    if (pathname === '/repos/plume-works/images/installation') {
      return Response.json({ id: 42 });
    }
    if (pathname.endsWith('/installation')) {
      return Response.json({ message: 'Not Found' }, { status: 404 });
    }
    if (pathname === '/repos/plume-works/images/pulls') {
      expect(searchParams.get('state')).toBe('open');
      return Response.json([{ head: { sha: 'a'.repeat(40) } }, { head: { sha: 'b'.repeat(40) } }]);
    }
    if (pathname.endsWith('/check-runs') && method === 'GET') {
      expect(searchParams.get('check_name')).toBe(CHECK_NAME);
      const runs = pathname.includes('a'.repeat(40))
        ? [run(1, 'queued'), run(2, 'in_progress'), run(3, 'completed')]
        : [run(4, 'completed')];
      return Response.json({ total_count: runs.length, check_runs: runs });
    }
    return Response.json({});
  };
  const deps = {
    appGitHub: () => new GitHub('app-jwt', fetchFn),
    repoGitHub: async (installationId: number, name: string) => new GitHub(`ghs-${installationId}-${name}`, fetchFn),
  };
  return { calls, deps };
}

/** Reviewer containers left running on the engine. */
function fakeEngine(names: string[], { failing = false } = {}) {
  const stopped: string[] = [];
  return {
    stopped,
    engine: {
      running: async () => {
        if (failing) {
          throw new Error('docker is down');
        }
        return names;
      },
      stop: async (name: string) => {
        stopped.push(name);
      },
    },
  };
}

afterEach(() => {
  spyOn(console, 'log').mockRestore();
  spyOn(console, 'error').mockRestore();
});

describe('reconciling after a restart', () => {
  test('completes only the open Quill Review check runs as cancelled', async () => {
    const github = fakeGitHub();
    const docker = fakeEngine([]);
    await reconcile(['plume-works/images'], { ...github.deps, docker: docker.engine });
    const writes = github.calls.filter((call) => call.method !== 'GET');
    expect(writes.map((call) => `${call.method} ${call.path}`)).toEqual([
      'PATCH /repos/plume-works/images/check-runs/1',
      'PATCH /repos/plume-works/images/check-runs/2',
    ]);
    for (const { body, token } of writes) {
      expect(token).toBe('ghs-42-images');
      expect(body).toMatchObject({
        status: 'completed',
        conclusion: 'cancelled',
        output: { title: CHECK_NAME, summary: RESTARTED_SUMMARY },
      });
    }
    const lookup = github.calls.find((call) => call.path.endsWith('/installation'))!;
    expect(lookup.token).toBe('app-jwt');
  });

  test('skips a repository the App is not installed on', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const github = fakeGitHub();
    await reconcile(['plume-works/other'], { ...github.deps, docker: fakeEngine([]).engine });
    expect(github.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /repos/plume-works/other/installation',
    ]);
    expect(log.mock.calls.flat().join(' ')).toContain('plume-works/other');
  });

  test('stops the reviewer containers a crashed service left running', async () => {
    const docker = fakeEngine(['0123456789ab', 'ba9876543210']);
    await reconcile([], { ...fakeGitHub().deps, docker: docker.engine });
    expect(docker.stopped).toEqual(['0123456789ab', 'ba9876543210']);
  });

  test('a failing GitHub or Docker is logged and ends the reconciliation', async () => {
    const error = spyOn(console, 'error').mockImplementation(() => {});
    const github = fakeGitHub({ failing: true });
    const docker = fakeEngine([], { failing: true });
    await reconcile(['plume-works/images', 'plume-works/other'], { ...github.deps, docker: docker.engine });
    expect(github.calls.filter((call) => call.path.endsWith('/installation'))).toHaveLength(2);
    expect(error).toHaveBeenCalledTimes(3);
  });
});
