import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_MAX_CONCURRENT_REVIEWS, loadConfig } from '../src/config';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function write(content: unknown): string {
  const dir = mkdtempSync(`/tmp/quill-config-${crypto.randomUUID()}-`);
  dirs.push(dir);
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify(content));
  return path;
}

test('reads the repositories, trusted bots, pause switch, and maximum', () => {
  const path = write({
    repositories: ['plume-works/images'],
    trustedBots: ['renovate[bot]'],
    paused: true,
    maxConcurrentReviews: 2,
  });
  expect(loadConfig(path)).toEqual({
    repositories: ['plume-works/images'],
    trustedBots: ['renovate[bot]'],
    paused: true,
    maxConcurrentReviews: 2,
  });
});

test('defaults to 5 concurrent reviews, not paused, and no bots', () => {
  expect(DEFAULT_MAX_CONCURRENT_REVIEWS).toBe(5);
  expect(loadConfig(write({ repositories: ['a/b'] }))).toEqual({
    repositories: ['a/b'],
    trustedBots: [],
    paused: false,
    maxConcurrentReviews: 5,
  });
});

test.each([
  [{ repositories: 'a/b' }, 'repositories'],
  [{ trustedBots: [1] }, 'trustedBots'],
  [{ paused: 'yes' }, 'paused'],
  [{ maxConcurrentReviews: 0 }, 'maxConcurrentReviews'],
  [{ maxConcurrentReviews: 1.5 }, 'maxConcurrentReviews'],
])('refuses a malformed setting: %p', (content, key) => {
  expect(() => loadConfig(write(content))).toThrow(key);
});

test('picks up an edit on the next read', () => {
  const path = write({ paused: false });
  writeFileSync(path, JSON.stringify({ paused: true }));
  expect(loadConfig(path).paused).toBe(true);
});
