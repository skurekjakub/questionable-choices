# Driving the dashboard in a browser

Read before Phase 6a. Everything the owner sees is a claim about a browser, so
this is where verdict evidence for the UI comes from.

## The driver

Either works; pick one and say which in the report.

- **`agent-browser`** on PATH — has viewport and device emulation, media
  emulation (`dark`, `reduced-motion`), an axe accessibility pass, recording,
  visual diffing against a baseline, and isolated `--session`s so two tabs can be
  driven independently. Run `agent-browser skills get core` for the command
  surface rather than working from memory; it moves.
- **The Playwright MCP tools** — `browser_navigate`, `browser_snapshot`,
  `browser_take_screenshot`, `browser_click`, `browser_type`, `browser_press_key`,
  `browser_resize`, `browser_console_messages`, `browser_network_requests`,
  `browser_tabs`, `browser_evaluate`.

Open the URL for the mode you chose — `http://127.0.0.1:5173` in `dev`,
`http://127.0.0.1:4400` in `built`.

## Non-negotiables

1. **Look at the result.** Take a screenshot and open it. A snapshot lists roles
   and names; it does not show a lamp that never turned amber, a card rail with no
   colour, a cache gauge that renders at 100 % forever, or a session header that
   scrolled out of an `overflow: hidden` container — which is exactly the class of
   bug `a915759` fixed and which no accessibility tree would have caught.
2. **Read the console after every step, not once at the end.** Messages are lost
   on navigation. Take a baseline before the first action; whatever was already
   there is not your finding. In `dev`, two WebSocket warnings on load are
   expected: StrictMode mounts the effect twice and closes the first socket before
   its handshake completes. They are absent from a production build, so seeing
   them in `built` mode **is** a finding.
3. **Both tabs stay in sync — this is a standing clause on every run.** The board
   and a session view are two views of one stream. Open the board in one tab and
   `/session/<id>` in another, drive a state change from either, and both must
   move without a reload: `/ws/events` pushes a `board` frame (debounced 250 ms)
   and a `session` frame, and the client multiplexes every hook over one shared
   socket. A change that shows in one tab and not the other is a defect even when
   both are individually correct.
4. **Assert on roles, text and data attributes, not classes.** The board is plain
   CSS with custom properties and no test ids: `role="menu"` and
   `role="menuitemradio"` on the workspace switcher, `role="dialog"` +
   `aria-modal="true"` on the three dialogs and the drawer, `role="alert"` on
   banners and field notes, `role="status"` on the needs-you badge, the stream
   indicator and the detached bar, `aria-label="<column name>, <n> issues"` on each
   column, `data-tone` on the card rail and the cache readout, `data-alert` on the
   session state pill. Classes drift; these are the contract.
5. **Attribute behaviour from the exchange, not by inference.** The network panel
   says whether a value came from the server or from client state. A countdown
   that ticks is client-side by design — the server broadcasts only when
   `expiresAt` or `warm` changes — so a ticking clock proves nothing about the
   server.
6. **Record every anomaly** — a layout jump, a control that needed two clicks, a
   slow frame — as "noticed, not investigated". Do not drop it.

## The terminal

The xterm.js terminal in the browser is the **primary** interaction surface, and
typing into it is the only evidence that the whole path works: keystroke →
`/ws/terminal/:sessionId` binary frame → node-pty → `tmux attach` → the `claude`
TUI. Answer questions and permission prompts there.

`tmux send-keys -t <session id> <keys>` is a **labelled fallback**, used when the
browser control fails twice, and it must be labelled as such in the report — it
skips the WebSocket entirely, so it proves the session, not the dashboard.

For pane evidence, independent of the browser:

```bash
tmux capture-pane -p -t <session id>
```

That is the right way to prove what the TUI actually showed — including that the
owner's own statusline is still rendering beneath the generated one.

Terminal mechanics worth knowing:

- The attach URL carries `?cols=` and `?rows=` from the fitted xterm, and a
  `{"type":"resize","cols":n,"rows":n}` text frame follows on open and on every
  layout change. Resizing the window is therefore a real test of the resize path.
- Reconnect walks the shared backoff (500 ms doubling to 15 s) and **stops** once
  the session is no longer live, once the server sends an `error` frame, or after
  six attempts — then it prints "not reattaching; use Reconnect to try again" and
  the detached bar offers a Reconnect button. A killed session that keeps retrying
  forever would be the defect.
- tmux is set to `window-size latest`, so several viewers can attach and the pane
  follows the most recent resize. Two browser tabs on the same session is a
  supported case, not an edge case.

## Mechanics

- **Refs go stale after any navigation.** Re-snapshot; never reuse an element
  reference across a route change.
- Routing is a hand-rolled `pushState` switch over two routes (`/` and
  `/session/:id`) with a `popstate` listener. Browser Back is a real code path and
  belongs in the plan whenever the change touches `App.tsx`.
- A card is a nest of buttons: the card body, one button per session row, the
  primary action, an editor icon button, and an overflow menu. Target by
  accessible name (`Open DOC-1234`, `Start Implement`, `More actions for DOC-1234`)
  rather than by position.
- The primary button reads **`Open <label> session`**, not `Start <label>`, when a
  live session already exists for that playbook — the card deliberately routes
  around the 409 the server would answer.
- Focus rings are a 2 px outline with a 2 px offset on every interactive element;
  `document.activeElement` after a dialog closes is the check that focus was
  restored.
- The favicon is painted into a canvas and swapped as a data URL, and
  `document.title` becomes `(n) questionable choices` when something is waiting.
  Both are readable through an evaluate call and are cheap, reliable evidence for
  the needs-you badge.
- Notifications need permission, granted from the header button, and the baseline
  is per workspace: the **first** board seen of a workspace only establishes it, so
  opening the app with three sessions already waiting announces nothing. That is
  by design; test it by making a session enter the needs-you set while you watch.

## Stopping

Close every browser session you opened, including each named `--session`. A
browser left open holds an events socket and a terminal socket, which is exactly
what used to keep the server from shutting down, and it pollutes the next run's
baseline.
