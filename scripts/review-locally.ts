#!/usr/bin/env bun
/**
 * Run one live review of a pull request on this machine's Docker engine, the way the service
 * runs it, and check the result it writes instead of posting it.
 *
 *   bun scripts/review-locally.ts <owner/name> <number> [--image <ref>]
 *
 * CLAUDE_CODE_OAUTH_TOKEN is the Claude token the review runs on. GH_TOKEN is the token the
 * reviewer reads the pull request with; give it read access only, as the service does.
 */
import { GitHub } from '../src/github';
import { parseResult, type ReviewResult } from '../src/review';
import { readResult, runContainer } from '../src/reviewer';

type Comment = ReviewResult['comments'][number];

/** The lines of each file a review comment can be placed on, by side, read from a unified diff. */
export function commentableLines(diff: string): Map<string, Record<Comment['side'], Set<number>>> {
  const files = new Map<string, Record<Comment['side'], Set<number>>>();
  let lines: Record<Comment['side'], Set<number>> | undefined;
  let oldPath = '';
  let left = 0;
  let right = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      lines = undefined;
    } else if (line.startsWith('--- ') && !lines) {
      oldPath = line.slice(4).replace(/^a\//, '');
    } else if (line.startsWith('+++ ') && !lines) {
      // A deleted file keeps its old path; its comments go on the left side.
      const path = line.slice(4) === '/dev/null' ? oldPath : line.slice(4).replace(/^b\//, '');
      lines = { LEFT: new Set(), RIGHT: new Set() };
      files.set(path, lines);
    } else if (line.startsWith('@@')) {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
      [left, right] = [Number(hunk?.[1]), Number(hunk?.[2])];
    } else if (lines && line.startsWith('+')) {
      lines.RIGHT.add(right++);
    } else if (lines && line.startsWith('-') && !line.startsWith('---')) {
      lines.LEFT.add(left++);
    } else if (lines && line.startsWith(' ')) {
      lines.LEFT.add(left++);
      lines.RIGHT.add(right++);
    }
  }
  return files;
}

/** The comments of `result` that GitHub would refuse because they are not on a line of `diff`. */
export function offTheDiff(result: ReviewResult, diff: string): Comment[] {
  const files = commentableLines(diff);
  return result.comments.filter((comment) => !files.get(comment.path)?.[comment.side].has(comment.line));
}

function fail(message: string): never {
  console.error(`review-locally: ${message}`);
  process.exit(1);
}

async function main(args: string[]): Promise<void> {
  const imageAt = args.indexOf('--image');
  const image = imageAt === -1 ? undefined : args.splice(imageAt, 2)[1];
  const [repository, number] = args;
  if (!repository?.includes('/') || !/^\d+$/.test(number ?? '')) {
    fail('usage: bun scripts/review-locally.ts <owner/name> <number> [--image <ref>]');
  }
  const claudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? fail('set CLAUDE_CODE_OAUTH_TOKEN');
  const ghToken = process.env.GH_TOKEN ?? fail('set GH_TOKEN, a token that can only read the repository');

  let reviewer = image;
  if (!reviewer) {
    reviewer = 'quill-reviewer:local';
    const build = Bun.spawn(['docker', 'build', '-f', 'reviewer/Dockerfile', '-t', reviewer, '.'], {
      cwd: `${import.meta.dir}/..`,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    if ((await build.exited) !== 0) {
      fail('building the reviewer image failed');
    }
  }

  const github = new GitHub(ghToken);
  const pull = await github.request<{ head: { sha: string } }>('GET', `/repos/${repository}/pulls/${number}`);
  const diffResponse = await fetch(`https://api.github.com/repos/${repository}/pulls/${number}`, {
    headers: { accept: 'application/vnd.github.diff', authorization: `Bearer ${ghToken}` },
  });
  const diff = await diffResponse.text();

  const name = `quill-local-${repository.replace('/', '-')}-${number}-${Date.now()}`;
  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort('shutdown'));
  console.log(`reviewing ${repository}#${number} at ${pull.head.sha} in ${name}`);
  console.log(`follow it with: docker logs -f ${name}`);
  const outcome = await runContainer({
    image: reviewer,
    name,
    env: {
      REPOSITORY: repository,
      PR_NUMBER: number!,
      HEAD_SHA: pull.head.sha,
      GH_TOKEN: ghToken,
      CLAUDE_CODE_OAUTH_TOKEN: claudeToken,
    },
    signal: controller.signal,
  });
  if (outcome !== 'success') {
    fail(`the review ended as ${outcome}; its log: docker logs ${name}`);
  }
  const text = await readResult(name);
  const result = text === undefined ? undefined : parseResult(text);
  if (!result) {
    fail(`no usable result; the reviewer wrote: ${text ?? 'nothing'}`);
  }
  console.log(JSON.stringify(result, null, 2));
  const off = offTheDiff(result, diff);
  for (const comment of off) {
    console.error(`off the diff, GitHub would refuse the review: ${comment.path} ${comment.side} ${comment.line}`);
  }
  if (off.length > 0) {
    process.exit(1);
  }
  console.log(`usable: the service would post this ${result.event} review on ${pull.head.sha}`);
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
