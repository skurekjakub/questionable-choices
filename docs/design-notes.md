# Design notes — questionable-choices web UI

The direction the implementation commits to, so later changes extend it
instead of re-litigating it.

## The thing being designed

A single-owner control room for `claude` sessions that run unattended in
tmux. One person, at one desk, glancing at it between other work. The
questions it has to answer in under a second are, in order:

1. Does anything need me right now?
2. How long is that session's prompt cache still warm?
3. What is each session doing, and for how long?

Everything else — descriptions, labels, worktree paths — is reference
material that is one click away, not headline material.

## Direction: instrument panel, not dashboard

The reference is a rack-mounted studio console: one continuous dark face
divided into channels by hairlines, engraved labels, small signal lamps, and
one real gauge. Not a page of floating cards. Concretely:

- The board fills the viewport and never scrolls as a page; the five columns
  scroll independently inside a fixed frame. Below 1040 px five readable
  tracks stop fitting, so the frame becomes a horizontal scroll-snap strip of
  the same five lanes with an "n of 5" indicator under it. The lane count
  never changes: a hidden lane the owner cannot see they have is worse than a
  swipe.
- Columns are separated by 1 px hairlines, not gutters. The board reads as
  one divided surface.
- Elevation comes from surface lightness only. No drop shadows anywhere.
- "Editorial" shows up as real prose typesetting for the one piece of human
  writing on screen — the issue summary and description — set in a serif at
  a comfortable measure, not clipped UI chrome.

## Colour

Six base values, dark cyan-slate ink with warm parchment text. The warmth of
the text against the cool ground is what keeps it from reading as a generic
near-black terminal theme.

| Token           | Value     | Role                              |
| --------------- | --------- | --------------------------------- |
| `--ink-900`     | `#0e1418` | Page ground, column wells         |
| `--ink-850`     | `#131b20` | Column ground                     |
| `--ink-800`     | `#182228` | Card surface, panels              |
| `--ink-700`     | `#1f2c33` | Raised surface, hover, inputs     |
| `--ink-600`     | `#2b3a42` | Hairlines, borders                |
| `--paper`       | `#e8e3d7` | Primary text (warm, never `#fff`) |
| `--paper-dim`   | `#93a1a6` | Secondary text                    |
| `--paper-faint` | `#7d8d94` | Tertiary text, disabled           |

`--paper-faint` carries real readings — the cache countdown, time in state,
column counts — so it is held at 4.5:1 against the card and column surfaces
rather than tuned by eye. Anything quieter than this belongs to a shape or a
lamp, not to text.

Three signal colours, borrowed from indicator lamps rather than from a brand
palette. They appear only on indicators, never as surfaces:

| Token          | Value     | Meaning                                                   |
| -------------- | --------- | --------------------------------------------------------- |
| `--lamp-cyan`  | `#5ec8d8` | Live and moving: bootstrapping, starting, working         |
| `--lamp-amber` | `#f0a52e` | Wants the owner: waiting, idle, cache running low         |
| `--lamp-red`   | `#e2664b` | Stopped or spent: failed, cold cache, destructive actions |
| `--lamp-moss`  | `#8fae6a` | Settled: done, marked done                                |

Cache tones map straight onto the lamps: `dim` → `--paper-faint`,
`yellow` → `--lamp-amber`, `red` → `--lamp-red`.

## Typography

Two systems, clearly distinct, both from Google Fonts with a real fallback
stack.

- **Newsreader** (serif) — issue summaries, issue descriptions, column
  headings, the app name. Screen-cut serif with low stroke contrast, so it
  holds up on a dark ground where a display serif would fray. This is the
  editorial half, and it is used only for text a human wrote.
- **IBM Plex Sans** — every control, label, button and chip. Engineered,
  slightly squared grotesque drawn for technical equipment; the machine half.
- **IBM Plex Mono** — issue keys, timers, branch names, worktree paths,
  tmux commands, the terminal. Mono is load-bearing here rather than
  decorative: `⏳ 4:07` re-renders every second and must not jitter, and paths
  and keys are machine identifiers.

Type scale (rem, 16 px root): `0.6875` (11 px, chip/meta) · `0.75` (12 px,
labels and session rows) · `0.8125` (13 px, controls) · `0.875` (14 px, body)
· `1` (16 px, card summary) · `1.125` (18 px, drawer heading) · `1.375`
(22 px, dialog and drawer titles).

Rules the UI keeps: sentence case everywhere, no tracked-out all-caps
eyebrows, no arrows appended to button labels, no middle-dot meta strings
(hairline rules separate meta instead). Line length in the drawer and dialog
is capped near 72 characters.

## Spacing and shape

4 px base unit: `--sp-1` 4 · `--sp-2` 8 · `--sp-3` 12 · `--sp-4` 16 ·
`--sp-5` 24 · `--sp-6` 32 · `--sp-7` 48. Card padding is 12; the gap between
a card's blocks is 8; the column gutter is 16.

Radius is hierarchical, not uniform: chips and lamps `2px`, buttons and
inputs `4px`, cards `6px`, dialog `8px`. The drawer has square edges because
it is flush to the viewport edge.

## How state is signalled

Colour never carries meaning alone. Every state is a shape, a word and a
colour together.

- **Session lamp** — a 9 px indicator to the left of each session row.
  Filled disc = the machine is working; ring = the machine has stopped and is
  waiting; a horizontal bar = exited; a filled square = failed. Colour adds
  the urgency band, and the state word sits right next to it.
- **Card rail** — a 2 px vertical rule down the card's left edge, coloured by
  the card's most urgent session. This is the peripheral-vision signal that
  lets a column be scanned without reading. Cards themselves are never
  tinted.
- **Needs-you pulse** — the lamp on a waiting session breathes at 2 s. Under
  `prefers-reduced-motion` the animation is replaced by a static outer ring,
  so the distinction survives without motion.
- **Cache gauge** — the one gauge in the product, and the only decorative
  flourish that survives. Under the `⏳ m:ss` countdown sits a 28 px hairline
  that depletes with `secondsLeft / ttlSeconds`. Nothing else in the UI gets
  a gauge, so it reads as the instrument's needle rather than as chrome.

## The workspace switcher

A workspace is one epic, so the switcher is a custom popover rather than a
`<select>`: each row needs two lines. Line one is the workspace name in the UI
face; line two is the epic key and the repo id in mono, spaced apart rather
than joined by a separator character. The active row's name is tinted
`--lamp-cyan`, the only place that colour appears outside a state lamp. The
trigger shows the same pair inline, name then epic key.

Adding and removing a workspace sit at the bottom of that panel, below a
hairline, because they change the list the panel is showing. Removal is
confirmed in a dialog that says in plain words what survives: the epic leaves
the switcher, the repo's sessions and worktrees stay.

## Restraint

One bold element: the cache gauge. Everything around it is quiet — no
gradients, no shadows, no hover lifts, no entrance animations. The only
motion in the product is the needs-you pulse and the terminal's own cursor.
Focus rings are a 2 px `--lamp-cyan` outline with a 2 px offset, visible on
every interactive element.
