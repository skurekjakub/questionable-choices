import { describe, expect, it } from 'vitest';
import { SESSION_STATES, isPermanentSourceError } from '../../src/core/types.js';

describe('isPermanentSourceError', () => {
  it('recognises an error that marks itself permanent', () => {
    const raised = Object.assign(new Error('the query names no project'), { permanent: true });

    expect(isPermanentSourceError(raised)).toBe(true);
  });

  it('recognises a subclass that declares the marker as a field', () => {
    // The seam exists so a connector author can raise one without importing
    // another connector's class; nothing about the marker is any vendor's.
    class QueryTooWideError extends Error {
      readonly permanent = true;
    }

    expect(isPermanentSourceError(new QueryTooWideError('too many results'))).toBe(true);
  });

  it.each([
    ['permanent: false, which is how a transient failure says so', { permanent: false }],
    ['permanent: undefined', { permanent: undefined }],
    ['a truthy non-boolean', { permanent: 'yes' }],
    ['no marker at all', {}],
  ])('refuses an error carrying %s', (_name, extra) => {
    expect(isPermanentSourceError(Object.assign(new Error('nope'), extra))).toBe(false);
  });

  it.each([
    ['a plain object wearing the marker', { permanent: true }],
    ['null', null],
    ['a string', 'permanent'],
  ])('refuses %s, which is not an error at all', (_name, value) => {
    expect(isPermanentSourceError(value)).toBe(false);
  });
});

describe('SESSION_STATES', () => {
  it('lists every state once, with no duplicates for a lookup to shadow', () => {
    expect(new Set(SESSION_STATES).size).toBe(SESSION_STATES.length);
  });
});
