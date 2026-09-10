import { describe, expect, it } from 'vitest';
import { listenErrorHandler } from '../../src/server/main.js';

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

describe('listenErrorHandler', () => {
  it('names the port and the remedy when it is already in use', () => {
    const exits: number[] = [];
    const logged: string[] = [];
    const original = console.error;
    console.error = (line: string) => logged.push(line);

    try {
      listenErrorHandler(4400, (code) => exits.push(code))(listenError('EADDRINUSE'));
    } finally {
      console.error = original;
    }

    expect(logged.join('\n')).toContain('4400');
    expect(logged.join('\n')).toContain("change 'port'");
    expect(exits).toEqual([1]);
  });

  it.each(['EACCES', 'EADDRNOTAVAIL'])('exits non-zero for %s too', (code) => {
    // Without a socket the process serves nothing, and the signal handlers keep
    // the event loop referenced: a re-throw would leave a live, silent process.
    const exits: number[] = [];
    const logged: string[] = [];
    const original = console.error;
    console.error = (line: string) => logged.push(line);

    try {
      listenErrorHandler(4400, (status) => exits.push(status))(listenError(code));
    } finally {
      console.error = original;
    }

    expect(logged.join('\n')).toContain('127.0.0.1:4400');
    expect(logged.join('\n')).toContain(code);
    expect(exits).toEqual([1]);
  });
});
