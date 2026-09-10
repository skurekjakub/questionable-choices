import type { JSX } from 'react';

/**
 * Shared geometry for every glyph in the set, so they optically match.
 *
 * @param children - Path elements drawn on a 16-unit grid.
 * @returns The wrapped SVG element.
 */
function Glyph({ children }: { children: JSX.Element | JSX.Element[] }): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/**
 * Circular arrow, used for the manual board refresh.
 *
 * @returns The refresh glyph.
 */
export function RefreshIcon(): JSX.Element {
  return (
    <Glyph>
      <path d="M13.5 8a5.5 5.5 0 1 1-1.7-3.9" />
      <path d="M13.5 2.2v3h-3" />
    </Glyph>
  );
}

/**
 * Editor window with a caret, used for "Open in VS Code".
 *
 * @returns The editor glyph.
 */
export function EditorIcon(): JSX.Element {
  return (
    <Glyph>
      <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.4" />
      <path d="M6.2 6.4 4.4 8l1.8 1.6" />
      <path d="M9.4 6.4 11.2 8 9.4 9.6" />
    </Glyph>
  );
}

/**
 * Three stacked dots, used for the card overflow menu.
 *
 * @returns The overflow glyph.
 */
export function OverflowIcon(): JSX.Element {
  return (
    <Glyph>
      <circle cx="8" cy="3.2" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="8" cy="12.8" r="1.2" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

/**
 * Bell, used for the notification-permission button.
 *
 * @returns The bell glyph.
 */
export function BellIcon(): JSX.Element {
  return (
    <Glyph>
      <path d="M4 6.6a4 4 0 0 1 8 0c0 2.6.9 3.6 1.4 4.2H2.6C3.1 10.2 4 9.2 4 6.6Z" />
      <path d="M6.6 13.2a1.6 1.6 0 0 0 2.8 0" />
    </Glyph>
  );
}

/**
 * Two overlapping sheets, used for copy-to-clipboard buttons.
 *
 * @returns The copy glyph.
 */
export function CopyIcon(): JSX.Element {
  return (
    <Glyph>
      <rect x="5.4" y="5.4" width="8" height="8" rx="1.2" />
      <path d="M10.6 5.4v-1a1.2 1.2 0 0 0-1.2-1.2H3.8a1.2 1.2 0 0 0-1.2 1.2v5.6a1.2 1.2 0 0 0 1.2 1.2h1" />
    </Glyph>
  );
}

/**
 * Cross, used to dismiss the drawer and the dialog.
 *
 * @returns The close glyph.
 */
export function CloseIcon(): JSX.Element {
  return (
    <Glyph>
      <path d="m3.8 3.8 8.4 8.4" />
      <path d="m12.2 3.8-8.4 8.4" />
    </Glyph>
  );
}

/**
 * Two arrows closing on a rule, used for the Compact action.
 *
 * @returns The compact glyph.
 */
export function CompactIcon(): JSX.Element {
  return (
    <Glyph>
      <path d="M2.6 8h10.8" />
      <path d="M8 2.2v3.4" />
      <path d="M6.2 3.8 8 5.6l1.8-1.8" />
      <path d="M8 13.8v-3.4" />
      <path d="M6.2 12.2 8 10.4l1.8 1.8" />
    </Glyph>
  );
}

/**
 * Arrow pointing out of a box, used for links that leave the app.
 *
 * @returns The external-link glyph.
 */
export function ExternalIcon(): JSX.Element {
  return (
    <Glyph>
      <path d="M12.8 9.2v3.2a1.2 1.2 0 0 1-1.2 1.2H3.8a1.2 1.2 0 0 1-1.2-1.2V4.6a1.2 1.2 0 0 1 1.2-1.2H7" />
      <path d="M10 2.6h3.4V6" />
      <path d="M7.4 8.6 13.2 2.8" />
    </Glyph>
  );
}
