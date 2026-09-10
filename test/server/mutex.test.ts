import { describe, expect, it } from 'vitest';
import { KeyedMutex } from '../../src/server/mutex.js';

/**
 * Builds a promise plus the function that settles it.
 *
 * @returns The promise and its resolver.
 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('KeyedMutex', () => {
  it('runs work queued under one key in submission order, never overlapping', async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];
    const gates = [deferred(), deferred(), deferred()];

    const runs = gates.map((gate, index) =>
      mutex.run('key', async () => {
        order.push(`enter-${String(index)}`);
        await gate.promise;
        order.push(`leave-${String(index)}`);
      }),
    );

    // Only the first section may have started; the other two are queued.
    await Promise.resolve();
    expect(order).toEqual(['enter-0']);
    for (const gate of gates) gate.resolve();
    await Promise.all(runs);

    expect(order).toEqual(['enter-0', 'leave-0', 'enter-1', 'leave-1', 'enter-2', 'leave-2']);
  });

  /**
   * Counts the chains a mutex is still holding.
   *
   * Read through the private field on purpose: a public accessor would be
   * production code with no production caller, which is what the last one was
   * deleted for.
   *
   * @param mutex - The mutex to inspect.
   * @returns The number of keys with a chain.
   */
  function chainCount(mutex: KeyedMutex): number {
    return (mutex as unknown as { chains: Map<string, unknown> }).chains.size;
  }

  it('lets different keys run at the same time', async () => {
    const mutex = new KeyedMutex();
    const held = deferred();
    let secondRan = false;

    const first = mutex.run('a', () => held.promise);
    await mutex.run('b', async () => {
      secondRan = true;
    });

    expect(secondRan).toBe(true);
    held.resolve();
    await first;
  });

  it('answers with whatever the critical section resolved to', async () => {
    await expect(new KeyedMutex().run('key', async () => 42)).resolves.toBe(42);
  });

  it('does not let a rejecting section block the work queued behind it', async () => {
    const mutex = new KeyedMutex();
    const failure = mutex.run('key', () => Promise.reject(new Error('boom')));

    await expect(failure).rejects.toThrow('boom');
    await expect(mutex.run('key', async () => 'after')).resolves.toBe('after');
  });

  it('forgets only the newest chain, so queued work still waits on its predecessor', async () => {
    // Forgetting an older chain would let the next caller start immediately and
    // run beside the work already queued behind it.
    const mutex = new KeyedMutex();
    const first = deferred();
    const second = deferred();
    const order: string[] = [];

    const a = mutex.run('key', async () => {
      order.push('a-enter');
      await first.promise;
      order.push('a-leave');
    });
    const b = mutex.run('key', async () => {
      order.push('b-enter');
      await second.promise;
      order.push('b-leave');
    });

    first.resolve();
    await a;
    const c = mutex.run('key', async () => {
      order.push('c-enter');
    });
    second.resolve();
    await Promise.all([b, c]);

    expect(order).toEqual(['a-enter', 'a-leave', 'b-enter', 'b-leave', 'c-enter']);
  });

  it('holds no chain for a key whose work has finished', async () => {
    // One key per (repo, issue) and one per session id: a map that only grows
    // is a leak the size of the owner's whole issue history.
    const mutex = new KeyedMutex();

    for (let index = 0; index < 50; index += 1) {
      await mutex.run(`key-${String(index)}`, async () => index);
    }
    // The deletion is queued behind the chain's own resolution, so it lands one
    // turn after the caller is answered.
    await new Promise((resolve) => setImmediate(resolve));

    expect(chainCount(mutex)).toBe(0);
  });

  it('holds one chain per key while work is queued on it', async () => {
    const mutex = new KeyedMutex();
    const held = deferred();

    const first = mutex.run('key', () => held.promise);
    const second = mutex.run('key', async () => undefined);
    const other = mutex.run('other', () => held.promise);
    expect(chainCount(mutex)).toBe(2);

    held.resolve();
    await Promise.all([first, second, other]);
    await new Promise((resolve) => setImmediate(resolve));

    expect(chainCount(mutex)).toBe(0);
  });
});
