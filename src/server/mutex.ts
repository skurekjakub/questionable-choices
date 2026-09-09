/**
 * Serialises asynchronous work per key.
 *
 * Two requests that read a record, await something and write it back lose each
 * other's write; running them one after another under the same key is what
 * makes a read-modify-write safe. Different keys never wait for each other.
 */
export class KeyedMutex {
  private readonly chains = new Map<string, Promise<void>>();

  /**
   * Runs work once everything already queued under the key has finished.
   *
   * @param key - Identity the work is serialised on, e.g. a session id.
   * @param work - The critical section; it must re-read whatever it changes.
   * @returns Whatever `work` resolved to.
   * @throws {Error} Whatever `work` threw; a failure never blocks the queue.
   */
  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const result = previous.then(work, work);
    const chain = result.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, chain);
    void chain.then(() => {
      // Only the newest chain may be forgotten: an older one still has work
      // queued behind it that must keep waiting.
      if (this.chains.get(key) === chain) this.chains.delete(key);
    });
    return result;
  }

  /**
   * Reports whether any work is queued or running under a key.
   *
   * @param key - Identity to probe.
   * @returns True while the key has a chain.
   */
  busy(key: string): boolean {
    return this.chains.has(key);
  }
}
