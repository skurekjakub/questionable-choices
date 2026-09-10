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
- Every frame in the product clips rather than scrolls, so anything a row or a
  header cannot fit is gone rather than reachable. What gives way is decided
  rather than left to flex: readings shrink and ellipsise, controls never do.
  On the session header that means the branch and the pending summary give
  their width up and the actions keep theirs, because on a failed session
  _Resume_ is the only control that still does anything.
- Columns are separated by 1 px hairlines, not gutters. The board reads as
  one divided surface.
- Elevation comes from surface lightness only. Nothing is raised by a shadow:
  the only `box-shadow` in the product is the needs-you lamp's glow, and the
  static ring that replaces it under `prefers-reduced-motion`.
- "Editorial" shows up as real prose typesetting for the one piece of human
  writing on screen — the issue summary and description — set in a serif at a
  comfortable measure. On a card the summary is clamped to two lines, because a
  card is an index entry; wherever the text is the subject, in the drawer and
  the session panel, it is set in full.

## Colour

Eight base values, dark cyan-slate ink with warm parchment text. The warmth of
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
lamp, not to text. It clears that bar only against the grounds it was measured
on: the switcher panel sits on `--ink-700`, so the text there steps up to
`--paper-dim`.

Four signal colours, borrowed from indicator lamps rather than from a brand
palette. Their home is the indicators — the lamps, the card rail, the lane dot,
the cache gauge — and they reach text only on short readings that are already
saying the same thing in words: the in-progress and flag chips, the `done` and
`unverified` markers, the lane's alert count, the checked workspace, links and
the danger button. Exactly two surfaces are tinted, both of them small and both
of them saying "you". The needs-you badge in the header and the alerting state
pill sit on a dark amber ground; nothing else does, and no card, lane or panel
is ever tinted by its state.

| Token          | Value     | Meaning                                                   |
| -------------- | --------- | --------------------------------------------------------- |
| `--lamp-cyan`  | `#5ec8d8` | Live and moving: bootstrapping, working                   |
| `--lamp-amber` | `#f0a52e` | Wants the owner: waiting, idle, cache running low         |
| `--lamp-red`   | `#e2664b` | Stopped or spent: failed, cold cache, destructive actions |
| `--lamp-moss`  | `#8fae6a` | Settled: done, marked done                                |

`starting` is the one live state that is not cyan: the launcher has been told to
go and nothing has reported back yet, so it stays dim until it does.

Cache tones map straight onto the lamps: `dim` → `--paper-faint`,
`yellow` → `--lamp-amber`, `red` → `--lamp-red`.

## Typography

Two systems, clearly distinct, both from Google Fonts with a real fallback
stack.

- **Newsreader** (serif) — issue summaries, issue descriptions, column
  headings, dialog and drawer titles, the app name. Screen-cut serif with low
  stroke contrast, so it holds up on a dark ground where a display serif would
  fray. This is the editorial half: the writing itself and the headings that
  frame it, never a control.
- **IBM Plex Sans** — every control, label, button and chip. Engineered,
  slightly squared grotesque drawn for technical equipment; the machine half.
- **IBM Plex Mono** — issue keys, timers, branch names, worktree paths,
  tmux commands, the terminal. Mono is load-bearing here rather than
  decorative: `⏳ 4:07` re-renders every second and must not jitter, and paths
  and keys are machine identifiers.

Both families are fetched from Google Fonts, which a dashboard whose whole point
is running locally will not reach when the machine is offline. That is accepted
rather than overlooked: the fallback stacks are real system faces, and bundling
three families to survive a case where the tracker is unreachable anyway is not
worth the weight.

Type scale (rem, 16 px root): `0.6875` (11 px, chip/meta) · `0.75` (12 px,
labels and session rows) · `0.8125` (13 px, controls) · `0.875` (14 px, body)
· `1` (16 px, card summary) · `1.125` (18 px, wordmark and session side-panel
heading) · `1.375` (22 px, dialog and drawer titles).

Rules the UI keeps: sentence case everywhere, no tracked-out all-caps
eyebrows, no arrows appended to button labels, no middle-dot meta strings on
screen (hairline rules separate meta instead; the one middle dot in the product
is in a desktop notification's title, whose format the spec fixes). Line length
is capped at 66 characters in the drawer and the dialogs; the session side panel
drops the cap, being a narrow column already.

## Spacing and shape

4 px base unit: `--sp-1` 4 · `--sp-2` 8 · `--sp-3` 12 · `--sp-4` 16 ·
`--sp-5` 24 · `--sp-6` 32 · `--sp-7` 48. Card padding is 12, with the left side
inset by the 2 px rail so the text keeps its 12; the gap between a card's blocks
is 8; lane bodies are padded 12 and separated by a 1 px hairline rather than a
gutter.

Radius is hierarchical, not uniform: chips `2px`, buttons and inputs `4px`,
cards `6px`, dialog `8px`. A row inside a menu or the switcher panel takes the
chip radius, being flush to the panel's own edge. Lamps are drawn as shapes
rather than boxes, so they carry their own: a disc and a ring are circles, the
failed square is softened by 1 px, the exited bar is square. The drawer has
square edges because it is flush to the viewport edge.

## How state is signalled

Colour never carries meaning alone. Every state is a shape, a word and a
colour together — which is a claim about the narrowest track the row ever gets,
not about the widest. Flex will take a label to zero width before it clips it,
and `text-overflow` paints nothing at zero, so the state word and the playbook
label both carry a floor in `ch`. When the two of them plus the duration no
longer fit, the cache gauge takes a line of its own rather than any of them
losing their words.

- **Session lamp** — a 9 px indicator to the left of each session row. A
  horizontal bar = exited; a filled square = failed; everything live is a disc
  or a ring, and the silhouette separates the two states that share a colour.
  Cyan is a ring while the worktree is still being built and a disc once the CLI
  is running. Amber is a disc for a permission prompt, which blocks on one
  answer, and a ring for a question or an idle turn, which are open-ended.
  Colour adds the urgency band, and the state word sits right next to it.
- **Unverified marker** — a second, half-height lamp on a session whose state
  the server has not heard confirmed since it restarted. On the card row it sits
  at the right-hand end, with the duration and the done marker rather than next
  to the state lamp, because the row reads left to right as the spec's sentence
  does: playbook, state, compacting, model, time in state, done, unverified,
  may-need-you, gauge.
  In the session
  header it sits inside the state pill, which is the one thing the header says
  about state. It is a marker rather than a word because the sentence it stands
  for is longer than the track it would sit in; the sentence is its accessible
  name and its tooltip, so nothing about it is colour-only. The same rule
  decides where a failed session's tmux hint goes: a tooltip on the row, and
  words in the session panel, which has room for them.
- **May-need-you marker** — a 5 px amber dot, half the lamp's diameter, on a
  session whose last `Notification` suggests it is waiting on the owner. A
  notification lags the dialog it describes by seconds and cannot be placed in a
  turn, so what it says is a hint and not a state: the marker never moves the
  card to _Needs you_, never tints the card rail, and never raises a desktop
  notification. It is the same family as the unverified marker and for the same
  reason — the sentence lives in the accessible name and the tooltip — and it
  sits next to it, at the right of the row and inside the state pill. The next
  real lifecycle event clears it.
- **Card rail** — a 2 px vertical rule down the card's left edge, coloured by
  the card's most urgent session. This is the peripheral-vision signal that
  lets a column be scanned without reading. Cards themselves are never
  tinted.
- **Needs-you pulse** — the lamp breathes at 2 s on a session waiting for one
  specific answer: a permission prompt or a question. An idle turn does not
  pulse; it is where a session rests after it has finished speaking, and a
  column of them would be nothing but motion. Under `prefers-reduced-motion` the
  animation is replaced by a static outer ring, so the distinction survives
  without motion.
- **Model and "compacting"** — two readings rather than signals, so both are
  `--paper-faint` next to the state word and neither gets a colour, a lamp or a
  lane of its own. The model id is mono, being a machine identifier like the
  branch and the key. "compacting" says the dashboard is typing at a session
  that is otherwise sitting at its prompt: the state word stays "your turn",
  because that is still what the session is doing between the keystrokes.
- **Compact** — the one control that appears and disappears with a reading
  rather than with a state. It is offered only on an idle session whose cache
  has gone cold, because what it costs is exactly the re-read that has already
  become unavoidable; on any other session it would be a button that spends
  money for nothing. On the card it sits outside the row's own click target —
  a button inside a button is not a control the browser gives the keyboard —
  and it keeps its width while every reading beside it gives way, because a
  Compact button clipped to its icon is a different button. Its tooltip carries
  the whole sentence, including the model switch, which is the part an owner
  would not expect.
- **Cache gauge** — the one gauge in the product, and the only decorative
  flourish that survives. A 28 px hairline depletes with
  `secondsLeft / ttlSeconds`, falling back to the five-minute default when the
  payload named no TTL, so the bar and the label never disagree. It sits under
  the `⏳ m:ss` countdown wherever the two have a column to themselves; on the
  card row below 1200 px the gauge is the reading that takes a line of its own
  — see the paragraph above — and there the hairline sits beside the countdown
  instead. Nothing else in the UI gets a gauge, so it reads as the instrument's
  needle rather than as chrome.

## The workspace switcher

A workspace is one epic, so the switcher is a custom popover rather than a
`<select>`: each row needs two lines. Line one is the workspace name in the UI
face; line two is the epic key and the repo id in mono, spaced apart rather
than joined by a separator character. The active row's name is tinted
`--lamp-cyan`, the same accent the focus ring and the links carry. The trigger
shows the same pair inline, name then epic key.

Adding and removing a workspace sit at the bottom of that panel, below a
hairline, because they change the list the panel is showing. Removal is
confirmed in a dialog that says in plain words what survives: the epic leaves
the switcher, the repo's sessions and worktrees stay.

## Restraint

One bold element: the cache gauge. Everything around it is quiet — no
gradients, no drop shadows, no hover lifts, no entrance animations, and not one
transition or transform anywhere. The only animation in the product is the
needs-you pulse and the terminal's own cursor; below 1040 px the lane strip
snaps as it is scrolled, which is the browser's motion rather than ours.

Focus rings are a 2 px `--lamp-cyan` outline with a 2 px offset, drawn on
`:focus-visible`: they follow the keyboard, and a pointer click leaves no ring
behind on the control it pressed.

## Known limits

**No `forced-colors` or `prefers-contrast` handling.** `prefers-reduced-motion`
is answered — the needs-you pulse becomes a static ring — and nothing else is.
Every surface, hairline and lamp is a hard-coded custom property, so a viewer in
a forced-colors mode gets the design as written or nothing: the hairlines that
divide the lanes and the lamps that carry state are exactly the elements a
forced palette replaces or flattens. Closing this means auditing every token
against the `forced-colors` system colours and giving the lamps a border in that
mode so their silhouettes survive a flattened fill, which is a design pass
rather than a fix. Recorded here so it is a decision rather than an oversight.

**`Terminal.tsx` has no test, and is the largest untested surface in the SPA.**
Every suite that renders a session replaces the module wholesale, because xterm
does not survive jsdom: it measures a canvas the environment does not implement.
So the xterm and socket construction, the dispose-and-rethrow paths around them,
the reconnect backoff and `onAttached` are all shipped unproven, and only the
boundary around them is covered — which proves the dashboard survives a terminal
that fails, not that the terminal ever works. Closing this means either a
headless-browser test of the attach path or a seam that lets a fake xterm stand
in, both of which are more than a fix. Recorded here so it is a decision rather
than an oversight.
