import { readFileSync } from 'node:fs';

export interface Config {
  /** `owner/name` of each repository whose pull requests are reviewed. */
  repositories: string[];
  /** Logins of bots whose pull requests are approved without a review. */
  trustedBots: string[];
  /** While true, no review starts. */
  paused: boolean;
  maxConcurrentReviews: number;
}

export const DEFAULT_MAX_CONCURRENT_REVIEWS = 5;

const strings = (value: unknown, key: string): string[] => {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`config: ${key} must be a list of strings`);
  }
  return value;
};

/** Parse the configuration JSON, filling in the defaults. */
export function parseConfig(text: string): Config {
  const raw = JSON.parse(text) as Record<string, unknown>;
  const paused = raw.paused ?? false;
  if (typeof paused !== 'boolean') {
    throw new Error('config: paused must be true or false');
  }
  const max = raw.maxConcurrentReviews ?? DEFAULT_MAX_CONCURRENT_REVIEWS;
  if (!Number.isInteger(max) || (max as number) < 1) {
    throw new Error('config: maxConcurrentReviews must be a positive integer');
  }
  return {
    repositories: strings(raw.repositories, 'repositories'),
    trustedBots: strings(raw.trustedBots, 'trustedBots'),
    paused,
    maxConcurrentReviews: max as number,
  };
}

/** Read the configuration file; each delivery reads it again, so an edit needs no restart. */
export function loadConfig(path: string): Config {
  return parseConfig(readFileSync(path, 'utf8'));
}
