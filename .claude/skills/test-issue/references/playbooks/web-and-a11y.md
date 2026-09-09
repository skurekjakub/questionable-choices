# Playbook — the screen, the keyboard and the viewport

For a change under `src/web/`. `docs/design-notes.md` is the contract this
playbook checks against: it records the direction the implementation committed to,
so a deviation from it is a defect even when the screen still looks fine.

## The four overlays

`StartDialog`, `AddWorkspaceDialog`, `ConfirmDialog` and `IssueDrawer` all share
one focus trap, and all four carry `role="dialog"` with `aria-modal="true"`, an
`aria-label`, and `tabIndex={-1}` on the surface so focus has somewhere to land.
Check every one of them, because the trap is shared but the contents are not — a
dialog whose only control is disabled behaves differently from one with eight.

| Clause                     | How                                                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Focus moves in on open     | Read `document.activeElement` right after opening: the first focusable control, or the surface itself when there is none                                |
| Tab cycles inside          | Tab from the last control returns to the first; Shift+Tab from the first goes to the last                                                               |
| Focus cannot escape        | Tab repeatedly and confirm `document.activeElement` never leaves the surface                                                                            |
| Escape dismisses           | …**except** in `StartDialog` with an edited prompt, where it raises the discard confirmation instead. That is deliberate, and it is a clause of its own |
| Focus is restored on close | `document.activeElement` returns to the control that opened the overlay — the card button, the menu item                                                |
| Backdrop click closes      | Pressing the scrim closes; pressing inside does not                                                                                                     |

The drawer is flush to the viewport edge with square corners, by design.

## The two menus

The workspace switcher and each card's overflow menu both use the shared menu-key
behaviour, with `role="menu"` and `role="menuitem"` / `role="menuitemradio"`:

- Opening focuses the **checked** item when there is one, else the first.
- ArrowDown / ArrowUp wrap; Home and End jump to the ends.
- Escape closes **and returns focus to the trigger**.
- Tab closes the menu.
- A pointer press outside the anchor closes it.

The switcher's trigger carries `aria-expanded` and `aria-haspopup="menu"`; check
`aria-expanded` actually flips.

## Live regions

The dashboard's whole job is telling the owner something changed, so the
announcements matter as much as the pixels:

- `role="status"` — the needs-you badge, the "stream offline" indicator, and the
  terminal's detached bar. Each wrapper is rendered **always**, with its content
  swapped in and out, which is what makes the announcement fire; a change that
  conditionally renders the wrapper itself silently breaks all three.
- `role="alert"` — board banners (load error, `sourceError`, action error), the
  session view's error note, and each add-workspace field note.
- `aria-label="<column name>, <n> issues"` on every column.
- `data-alert` on the session state pill when the session needs the owner.

## Contrast and the quiet text

`docs/design-notes.md` fixes the palette and says `--paper-faint` carries **real
readings** — the cache countdown, time in state, column counts — and is therefore
held at 4.5:1 against the card and column surfaces rather than tuned by eye. Run
an axe pass (`agent-browser a11y --tags wcag2a,wcag2aa`) and read the contrast
findings against that rule: a violation on `--paper-faint` text is a real defect,
and anything quieter than it is supposed to be a shape or a lamp, not text.

Also check the two motion clauses:

- The needs-you lamp breathes at 2 s.
- Under `prefers-reduced-motion: reduce` the animation is replaced by a **static
  outer ring**, so the distinction survives without motion. Emulate the media
  query rather than reading the stylesheet.

Colour never carries meaning alone: every state is a shape (filled disc / ring /
bar / square), a word, and a colour together. A screenshot in greyscale should
still be readable — if the only difference between "working" and "your turn" is
hue, that is a finding.

## Widths

The one breakpoint is **1040 px** (`src/web/src/styles/board.css`). Above it the
board is `repeat(5, minmax(200px, 1fr))`; at or below it the lanes become a
horizontal scroll-snap strip of `86%`-wide columns with a
`<name> — n of 5` indicator beneath. **The lane count never changes** — a hidden
lane the owner cannot see they have is worse than a swipe — so five dots and five
lanes at every width.

Screenshot at four widths, and look at each:

| Width | Watching for                                                                                                                                   |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 960   | Strip mode: snapping, the indicator's name and index tracking the scroll, no lane dropped                                                      |
| 1045  | Grid mode, just above the breakpoint — the five tracks plus their hairlines must still fit without the page scrolling horizontally             |
| 1280  | The ordinary case                                                                                                                              |
| 1908  | Columns share the extra width; nothing stretches into an unreadable measure. The drawer and dialog line length stays capped near 72 characters |

The board fills the viewport and **never scrolls as a page**: the five columns
scroll independently inside a fixed frame. A page-level scrollbar at any of these
widths is a defect on its own.

## A long backlog must not squash

Load a workspace whose backlog is large — the real epics have dozens of children —
and check that:

- cards keep their height and their two-line summary clamp; nothing compresses to
  fit;
- the column scrolls, the page does not;
- the count in the heading matches the number of cards you can reach by scrolling;
- the other four columns are unaffected by the tall one.

Then the session view's own version of the same hazard: focus the terminal on a
short viewport and confirm the header — state pill, countdown, Interrupt, Kill,
Resume — stays put. The session grid once had no row track, so the xterm's
intrinsic height overflowed the shell and scrolled every control permanently out
of an `overflow: hidden` container (`a915759`). It is invisible to an
accessibility tree and obvious in a screenshot, which is why the screenshot is the
evidence.

## Visual reference

`docs/screenshots/` holds the recorded appearance: `board.png`, `board-live.png`,
`session.png`, and the `live-*.png` set covering bootstrapping, starting, working,
idle, needs-you and the needs-you board. Use them as a **reference for what the
product is supposed to look like** — the lamps, the rail, the gauge, the chrome —
and say when the current build departs from one.

They are not a pixel baseline: they were taken against different data, so a diff
tool will report differences that mean nothing. For a real visual diff, capture
your own baseline earlier in the same run (before the change, or on the before
instance) and diff against that.
