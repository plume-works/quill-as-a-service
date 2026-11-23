import { describe, expect, test } from 'bun:test';
import { PerKey } from '../src/serial';

/** A task that records its start and runs until `finish` or `fail`. */
function task(name: string, events: string[]) {
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const fn = () => {
    events.push(`start ${name}`);
    return new Promise<string>((resolve, reject) => {
      finish = () => {
        events.push(`end ${name}`);
        resolve(name);
      };
      fail = reject;
    });
  };
  return { fn, finish: () => finish(), fail: (error: Error) => fail(error) };
}

describe('work serialized per key', () => {
  test('runs work of the same key in order', async () => {
    const events: string[] = [];
    const serial = new PerKey();
    const opened = task('opened', events);
    const pushed = task('pushed', events);
    const first = serial.run('acme/app#1', opened.fn);
    const second = serial.run('acme/app#1', pushed.fn);
    await Bun.sleep(0);
    expect(events).toEqual(['start opened']);
    opened.finish();
    expect(await first).toBe('opened');
    await Bun.sleep(0);
    pushed.finish();
    expect(await second).toBe('pushed');
    expect(events).toEqual(['start opened', 'end opened', 'start pushed', 'end pushed']);
  });

  test('runs work of different keys at once', async () => {
    const events: string[] = [];
    const serial = new PerKey();
    const one = task('one', events);
    const two = task('two', events);
    const first = serial.run('acme/app#1', one.fn);
    const second = serial.run('acme/app#2', two.fn);
    await Bun.sleep(0);
    expect(events).toEqual(['start one', 'start two']);
    two.finish();
    one.finish();
    expect(await Promise.all([first, second])).toEqual(['one', 'two']);
  });

  test('continues after work that fails', async () => {
    const events: string[] = [];
    const serial = new PerKey();
    const failing = task('failing', events);
    const next = task('next', events);
    const first = serial.run('acme/app#1', failing.fn);
    const second = serial.run('acme/app#1', next.fn);
    await Bun.sleep(0);
    failing.fail(new Error('GitHub is down'));
    await expect(first).rejects.toThrow('GitHub is down');
    await Bun.sleep(0);
    next.finish();
    expect(await second).toBe('next');
  });
});
