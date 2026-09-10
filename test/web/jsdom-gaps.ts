/**
 * Fills the two jsdom gaps the web suites walk into, so the run's last lines
 * are its own.
 *
 * jsdom implements neither `HTMLCanvasElement.getContext` nor `Window.focus`
 * and answers a call to either by printing a "Not implemented" notice through
 * its virtual console. Neither is the subject of any test.
 *
 * The stubs answer exactly what jsdom answers — `getContext` returns null, so
 * the "this browser cannot paint the icon" path is still the one taken — and
 * only the notice goes. Importing this module installs them; importing it again
 * replaces them with the same values, so any file may import it.
 */

// Defined rather than assigned: jsdom installs `getContext` as a non-writable
// own property of the prototype, which a plain assignment silently drops.
if (typeof HTMLCanvasElement !== 'undefined') {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    writable: true,
    value: () => null,
  });
}

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'focus', {
    configurable: true,
    writable: true,
    value: () => {},
  });
}
