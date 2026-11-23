import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REVIEW = resolve(import.meta.dir, '../reviewer/review.sh');
const SPEND_LIMIT = "You've hit your org's monthly spend limit";
const ENABLED = JSON.stringify([{ id: 'agentdev@agent-devcontainer', enabled: true }]);

let scratch: string;
let headSha: string;

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, env: gitEnv() });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

function gitEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    HOME: join(scratch, 'home'),
    GIT_CONFIG_GLOBAL: join(scratch, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
}

// The stub records how it was called; STUB_* variables choose what it answers.
const STUB = `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == plugin ]]; then
  printf '%s\\n' "$STUB_PLUGINS"
  exit 0
fi
{ echo "head=$(git rev-parse HEAD)"; echo "origin=$(git config remote.origin.url)"; echo "args=$*"; } > "$STUB_CALLS"
printf '%s\\n' "$STUB_OUTPUT"
exit "$STUB_EXIT"
`;

beforeEach(() => {
  scratch = `/tmp/quill-reviewer-${crypto.randomUUID()}`;
  for (const dir of ['home', 'bin', 'source.git']) {
    mkdirSync(join(scratch, dir), { recursive: true });
  }
  writeFileSync(join(scratch, 'bin/claude'), STUB);
  chmodSync(join(scratch, 'bin/claude'), 0o755);
  const source = join(scratch, 'source.git');
  writeFileSync(
    join(scratch, 'gitconfig'),
    `[url "file://${scratch}/"]\n\tinsteadOf = https://github.com/acme/\n`,
  );
  git(source, 'init', '-q', '-b', 'main');
  git(source, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  writeFileSync(join(source, 'README.md'), 'head\n');
  git(source, 'add', 'README.md');
  git(source, 'commit', '-q', '-m', 'head');
  headSha = git(source, 'rev-parse', 'HEAD');
  writeFileSync(join(source, 'README.md'), 'later\n');
  git(source, 'commit', '-q', '-am', 'later');
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function review({ plugins = ENABLED, output = '', exit = 0 } = {}) {
  const result = Bun.spawnSync(['bash', REVIEW], {
    env: {
      ...gitEnv(),
      PATH: `${join(scratch, 'bin')}:${process.env.PATH}`,
      REPOSITORY: 'acme/source',
      PR_NUMBER: '7',
      HEAD_SHA: headSha,
      STUB_PLUGINS: plugins,
      STUB_OUTPUT: output,
      STUB_EXIT: String(exit),
      STUB_CALLS: join(scratch, 'calls'),
    },
  });
  return { exitCode: result.exitCode, stderr: result.stderr.toString() };
}

const assistantSays = (text: string) =>
  JSON.stringify({
    type: 'assistant',
    message: { type: 'message', role: 'assistant', content: [{ type: 'text', text }] },
  });

describe('reviewer/review.sh', () => {
  test('checks out the head and runs claude headless with the review prompt', () => {
    const { exitCode, stderr } = review({ output: assistantSays('Review posted.') });
    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
    const calls = readFileSync(join(scratch, 'calls'), 'utf8');
    expect(calls).toContain(`head=${headSha}`);
    expect(calls).toContain('origin=https://github.com/acme/source.git');
    expect(calls).toContain('args=-p REPOSITORY: acme/source');
    expect(calls).toContain('ISSUE OR PR NUMBER: 7');
    expect(calls).toContain('skill: "agentdev:pr-review"');
    expect(calls).toContain('--output-format stream-json');
  });

  test("loads no settings, hooks, memory, skills or MCP servers from the pull request's checkout", () => {
    review({ output: assistantSays('Review posted.') });
    const args = readFileSync(join(scratch, 'calls'), 'utf8');
    expect(args).toContain('--setting-sources user');
    expect(args).toContain('--strict-mcp-config');
  });

  test('exits non-zero when claude fails', () => {
    expect(review({ exit: 3 }).exitCode).toBe(3);
  });

  test('exits non-zero on the spend limit', () => {
    const { exitCode, stderr } = review({ output: assistantSays(`${SPEND_LIMIT} · resets Dec 1`) });
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('spend limit');
  });

  test('a spend-limit text that is not an assistant message does not fail the review', () => {
    const toolResult = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', content: SPEND_LIMIT }] },
    });
    expect(review({ output: toolResult }).exitCode).toBe(0);
  });

  test('exits non-zero when the agentdev plugin is missing', () => {
    const disabled = JSON.stringify([{ id: 'agentdev@agent-devcontainer', enabled: false }]);
    for (const plugins of ['[]', disabled]) {
      const { exitCode, stderr } = review({ plugins });
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('agentdev plugin');
      expect(existsSync(join(scratch, 'calls'))).toBe(false);
    }
  });
});
