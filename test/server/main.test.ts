import { afterEach, describe, expect, it, vi } from 'vitest';

// Belt as well as braces for the entry gate below. `main` reads
// `QC_CONFIG` before it touches anything else, so even a gate that has been
// broken cannot reach the owner's real configuration, data directory or port
// from a test run.
const GUARD_CONFIG = vi.hoisted(() => {
  const path = '/nonexistent/questionable-choices-test-guard.json';
  process.env['QC_CONFIG'] = path;
  return path;
});

// The one observable side effect a boot would have. Importing the module must
// not produce it, which is what `isProcessEntry` is there to guarantee.
const serve = vi.hoisted(() => vi.fn());
vi.mock('@hono/node-server', () => ({ serve, upgradeWebSocket: vi.fn() }));

const { FLUSH_DEADLINE_MS, guardTheProcess, listenErrorHandler, shutdown } =
  await import('../../src/server/main.js');
const { isProcessEntry } = await import('../../src/server/util.js');

/**
 * Builds a listen error carrying an errno code.
 *
 * @param code - The errno name, e.g. `EADDRINUSE`.
 * @returns The error.
 */
function listenError(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`listen ${code} 127.0.0.1:4400`);
  error.code = code;
  return error;
}

/**
 * Runs work with `console.error` captured.
 *
 * @param work - What to run.
 * @returns The captured lines.
 */
function captureErrors(work: () => void): string[] {
  const logged: string[] = [];
  const original = console.error;
  console.error = (line: string) => logged.push(line);
  try {
    work();
  } finally {
    console.error = original;
  }
  return logged;
}

describe('listenErrorHandler', () => {
  it('names the port and the remedy when it is already in use', () => {
    const exits: number[] = [];

    const logged = captureErrors(() => {
      listenErrorHandler(4400, (code) => exits.push(code))(listenError('EADDRINUSE'));
    });

    expect(logged.join('\n')).toContain('4400');
    expect(logged.join('\n')).toContain("change 'port'");
    expect(exits).toEqual([1]);
  });

  it.each(['EACCES', 'EADDRNOTAVAIL'])('exits non-zero for %s too', (code) => {
    // Without a socket the process serves nothing, and the signal handlers keep
    // the event loop referenced: a re-throw would leave a live, silent process.
    const exits: number[] = [];

    const logged = captureErrors(() => {
      listenErrorHandler(4400, (status) => exits.push(status))(listenError(code));
    });

    expect(logged.join('\n')).toContain('127.0.0.1:4400');
    expect(logged.join('\n')).toContain(code);
    expect(exits).toEqual([1]);
  });
});

describe('importing the entry module', () => {
  it('boots nothing, because the module is not the process entry under vitest', () => {
    // The gate is the only thing between this suite and the owner's live
    // dashboard: with it gone, importing the module opens their real data
    // directory, binds their real port and shells out to tmux.
    const mainUrl = new URL('../../src/server/main.ts', import.meta.url).href;
    expect(isProcessEntry(mainUrl)).toBe(false);
    expect(serve).not.toHaveBeenCalled();
  });

  it('is guarded by QC_CONFIG, which points at a path that cannot exist', () => {
    // The gate is not the only line of defence and must not be the only one: a
    // gate that breaks reaches the owner's real config unless this is set
    // before any module-level code can read it. Any test file that imports
    // `src/server/main.js` has to hoist the same guard — see AGENTS.md § Tests.
    expect(process.env['QC_CONFIG']).toBe(GUARD_CONFIG);
    expect(GUARD_CONFIG.startsWith('/nonexistent/')).toBe(true);
  });
});

describe('shutdown', () => {
  /**
   * Builds the four things a shutdown closes, plus the trace it writes to.
   *
   * @param flush - Stand-in for the store's queue drain.
   * @returns The targets, the ordered trace and the sockets that were dropped.
   */
  function targets(flush: () => Promise<void>): {
    trace: string[];
    dropped: string[];
    args: Parameters<typeof shutdown>[0];
  } {
    const trace: string[] = [];
    const dropped: string[] = [];
    return {
      trace,
      dropped,
      args: {
        manager: {
          stop: () => {
            trace.push('manager.stop');
          },
        },
        store: {
          flush: () => {
            trace.push('flush');
            return flush();
          },
        },
        server: {
          close: (callback: () => void) => {
            trace.push('server.close');
            callback();
          },
          closeAllConnections: () => {
            trace.push('closeAllConnections');
          },
        },
        websocketServer: {
          clients: [
            {
              terminate: () => {
                dropped.push('event socket');
              },
            },
          ],
          close: () => {
            trace.push('websocketServer.close');
          },
        },
        exit: (code: number) => {
          trace.push(`exit:${code}`);
        },
      },
    };
  }

  it('drops the sockets that would hold the close open, in the order that lets it close', async () => {
    // An attached browser holds its event socket for as long as the tab lives,
    // and idle keep-alive sockets hold the close open too, so a close that
    // waits for them never returns.
    const { trace, dropped, args } = targets(() => Promise.resolve());

    await shutdown(args);

    expect(dropped).toEqual(['event socket']);
    expect(trace).toEqual([
      'manager.stop',
      'websocketServer.close',
      'closeAllConnections',
      'server.close',
      'flush',
      'exit:0',
    ]);
  });

  it('waits for the store to drain before it ends the process', async () => {
    // A hook answered 204 has its write on the store's queue; exiting before
    // the queue drains loses the record change it was answered for.
    let release = (): void => undefined;
    const drained = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { trace, args } = targets(() => drained);

    const done = shutdown(args);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(trace).toContain('flush');
    expect(trace).not.toContain('exit:0');

    trace.push('the queue drained');
    release();
    await done;

    expect(trace.slice(-2)).toEqual(['the queue drained', 'exit:0']);
  });

  it('gives up on a queue that never drains, so a wedged write cannot cost a SIGKILL', async () => {
    // `flush` awaits the write queue, which a write hanging on a wedged
    // filesystem never resolves. Both signals that could interrupt the wait are
    // handled, so without the deadline nothing short of SIGKILL ends it.
    vi.useFakeTimers();
    const errors: string[] = [];
    const original = console.error;
    console.error = (line: string) => errors.push(line);
    try {
      const { trace, args } = targets(() => new Promise<void>(() => undefined));

      const done = shutdown(args);
      await vi.advanceTimersByTimeAsync(FLUSH_DEADLINE_MS - 1);
      expect(trace).not.toContain('exit:0');

      await vi.advanceTimersByTimeAsync(1);
      await done;

      expect(trace).toContain('exit:0');
      expect(errors.join('\n')).toContain('did not drain');
    } finally {
      console.error = original;
      vi.useRealTimers();
    }
  });
});

describe('guardTheProcess', () => {
  const listeners = { uncaught: [] as unknown[], unhandled: [] as unknown[] };

  afterEach(() => {
    for (const listener of listeners.uncaught) {
      process.off('uncaughtException', listener as () => void);
    }
    for (const listener of listeners.unhandled) {
      process.off('unhandledRejection', listener as () => void);
    }
    listeners.uncaught = [];
    listeners.unhandled = [];
  });

  /**
   * Installs the guards and records the listeners so they can be removed.
   *
   * @param exit - Stand-in for the process exit.
   * @returns Nothing.
   */
  function install(exit: (code: number) => void): void {
    const uncaughtBefore = process.listeners('uncaughtException');
    const unhandledBefore = process.listeners('unhandledRejection');
    guardTheProcess(exit);
    listeners.uncaught = process
      .listeners('uncaughtException')
      .filter((entry) => !uncaughtBefore.includes(entry));
    listeners.unhandled = process
      .listeners('unhandledRejection')
      .filter((entry) => !unhandledBefore.includes(entry));
  }

  it('exits non-zero on an uncaught exception, which may be mid-invariant', () => {
    const exits: number[] = [];
    install((code) => exits.push(code));

    const logged = captureErrors(() => {
      (listeners.uncaught[0] as (cause: unknown) => void)(new Error('torn state'));
    });

    expect(logged.join('\n')).toContain('torn state');
    expect(exits).toEqual([1]);
  });

  it('keeps serving after an unhandled rejection, which usually costs one stack trace', () => {
    // Losing every session's state tracking is worse than losing one trace:
    // the rejection usually arrives outside the request that caused it.
    const exits: number[] = [];
    install((code) => exits.push(code));

    const logged = captureErrors(() => {
      (listeners.unhandled[0] as (cause: unknown) => void)(new Error('a socket gave up'));
    });

    expect(logged.join('\n')).toContain('still serving');
    expect(exits).toEqual([]);
  });
});
