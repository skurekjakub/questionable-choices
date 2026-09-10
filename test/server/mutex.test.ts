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
});
