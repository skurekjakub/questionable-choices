import { describe, expect, it } from 'vitest';
import { restoreFocusTarget } from '../../src/web/src/focus-restore.js';

/**
 * A stand-in for one element in the chain a restore walks.
 */
interface Node {
  /** Name the assertions read. */
  name: string;
  /** Whether the node is still in the document. */
  connected: boolean;
  /** First control inside it that can take focus, or null when it holds none. */
  control: Node | null;
}

/**
 * Builds a node.
 *
 * @param name - Name the assertions read.
 * @param connected - Whether the node is still in the document.
 * @param control - First focusable control inside it, or null.
 * @returns The node.
 */
function node(name: string, connected: boolean, control: Node | null = null): Node {
  return { name, connected, control };
}

/**
 * Runs the walk over a chain of test nodes.
 *
 * @param chain - The chain, opener first.
 * @returns The name of the node that would be focused, or null.
 */
function restore(chain: Node[]): string | null {
  return (
    restoreFocusTarget(
      chain,
      (candidate) => candidate.connected,
      (candidate) => candidate.control,
    )?.name ?? null
  );
}

describe('restoreFocusTarget', () => {
  it('returns the control that opened the surface when it is still there', () => {
    const opener = node('card button', true);
    expect(restore([opener, node('card', true), node('column', true)])).toBe('card button');
  });

  it('climbs to the trigger when the opener unmounted with its menu', () => {
    const item = node('menu item', false);
    const panel = node('menu panel', false);
    const trigger = node('switcher trigger', true);
    const switcher = node('switcher', true, trigger);
    expect(restore([item, panel, switcher, node('header', true)])).toBe('switcher trigger');
  });

  it('does not stop at a surviving ancestor that holds no control', () => {
    const empty = node('empty wrapper', true, null);
    const trigger = node('trigger', true);
    expect(restore([node('item', false), empty, node('switcher', true, trigger)])).toBe('trigger');
  });

  it('prefers the opener over the ancestor, so focus does not drift up a level', () => {
    const opener = node('opener', true);
    const trigger = node('some other control', true);
    expect(restore([opener, node('switcher', true, trigger)])).toBe('opener');
  });

  it('gives up rather than guessing when the whole chain is gone', () => {
    expect(restore([node('item', false), node('panel', false)])).toBeNull();
    expect(restore([])).toBeNull();
  });

  it('gives up when nothing that survived holds a control', () => {
    expect(restore([node('item', false), node('bare ancestor', true, null)])).toBeNull();
  });
});
