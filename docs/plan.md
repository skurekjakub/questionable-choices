# Implementation plan

Companion to [`spec.md`](./spec.md). Work packages are sized for one agent
each; the order is the dependency order. Every package ends with
`npm run verify` green for the parts it owns and a commit.

House rules for every package:

- TypeScript strict, ESM, no `any` without a comment saying why.
- JSDoc on every exported function and type: summary, `@param`, `@returns`,
  `@throws`. Inline comments only at gotchas. No section banners, no
  narrative.
- Prettier formatting (`npm run format`).
- Tests in `test/` with vitest; no network, no tmux, no filesystem outside a
  temp dir.
- Do not edit `package.json` dependencies without saying so in the commit
  message; the scaffold already installs everything the spec needs.
- Commit messages: `type(scope): what changed`, rationale in the body.

## Package 0 — hook facts, empirically (runner agent, first hour)

Before the runner is written, confirm on this machine with a throwaway
session (cwd: a scratch directory, not a real repo):

1. Write a settings file with the hook set from spec §8.1 whose command
   appends stdin plus the event name to a log file.
2. `claude --settings <file> "say hi, then ask me one question with AskUserQuestion, then run ls"`.
3. Answer the question, allow the permission, type `/exit`.
4. Record which events arrived, in what order, with which fields
   (`notification_type`, `tool_name`, `last_assistant_message`,
   `permission_mode`). Keep the log as
   `test/fixtures/hook-events.jsonl` (scrub paths).
5. Confirm the statusline override: a `statusLine` command in the same
   settings file receives the payload with `prompt_cache.expires_at`.

Deviations from spec §5.3 get written into the spec in the same commit.

## Package 1 — core (one agent, sequential, blocks everything else)

Files: `src/core/*`, `test/core/*`.

- `types.ts` — every domain type from spec §2, §5.1, §6, §7.
- `config.ts` — zod schema for spec §4 + `loadConfig(path)`; `~` expansion;
  cross-checks (board → workspace exists, playbook ids unique, `primaryFor`
  column ids valid, env vars named exist at load time → warning list, not
  failure).
- `state-machine.ts` — `reduce(record, event, now) → { record, changed,
notify }` implementing spec §5.3; `notify` is true on entry into the
  needs-you set.
- `prompt.ts` — `renderTemplate`, `slug`, `branchName`.
- `projection.ts` — `project(issues, records, flags, config) → BoardView`.
- `cache-clock.ts` — `cacheFromStatusline(payload, now)`,
  `cacheDerived(now, ttl)`, `describeCache(cache, now)` (label + tone).
- `api.ts` — wire types for spec §11 (REST bodies, `BoardView`, `Card`,
  WS frames). `src/web` may import only this file from core.
- Tests per spec §15. `config.example.json` must validate.

Done when: `npm run typecheck`, `npm test` green; contracts frozen.

## Package 2a — connectors (one agent)

Files: `src/connectors/**`, `test/connectors/**`.

- `issues/jira/` — `JiraIssueSource` per spec §10, `map.ts` (REST → Issue,
  ADF → text) tested on fixtures; `client.ts` with fetch, basic auth, paging.
- `workspaces/git/` — `GitWorkspace` per spec §5.5 step 2: `prepare()`,
  `removeWorktree()`, `listWorktrees()`, `findIssueBranch()`; shell out with
  `execFile`, never `exec` with string interpolation. Pure parsing helpers
  tested.
- `runners/claude-tmux/` — `ClaudeTmuxRunner` per spec §8: `writeSessionDir`
  (prompt.txt, settings.json, statusline.sh, run.sh), `start`, `resume`,
  `attach(cols, rows) → IPty`, `interrupt`, `kill`, `isAlive`. Generated
  files tested as strings (snapshot the settings JSON and run.sh for a
  sample record).
- `index.ts` per connector family: `createIssueSource(config)`, etc.

## Package 2b — server (one agent, parallel with 2a and 2c)

Files: `src/server/**`, `test/server/**`.

- `store.ts` — JSON files per spec §13, atomic writes, load on boot.
- `session-manager.ts` — start/resume/interrupt/kill/flags/remove-worktree,
  reconciler, board cache + polling, event fan-out (EventEmitter).
- `hooks.ts` — ingress route, event log, state-machine call, broadcast.
- `terminal-ws.ts` — pty bridge per spec §8.3.
- `app.ts` — Hono routes per spec §11; static serving of `dist/web` in
  production; in dev the Vite server proxies `/api` and `/ws` to 4400.
- `main.ts` — boot.
- Until 2a lands, code against the connector interfaces from core with
  in-memory fakes (`test/server/fakes.ts`); those fakes are also the test
  doubles.

## Package 2c — web (one agent, parallel)

Files: `src/web/**`.

- Vite config with `/api` and `/ws` proxy to `http://127.0.0.1:4400`.
- `frontend-design` skill first; record the direction in
  `docs/design-notes.md`.
- Board, card, issue drawer, start dialog, session view with xterm.js,
  notifications, title badge, cache countdown ticking client-side.
- State: one `useBoard(boardId)` hook (fetch + WS), one `useSession(id)`.
- Until 2b lands, run against `src/web/dev-mock.ts` (a tiny mock of the API
  contract with sample cards in every state) behind `VITE_MOCK=1`.

## Package 3 — integration (one agent, after 2a–2c)

- Wire real connectors into the server; delete nothing from the fakes.
- `npm run verify` green, `npm run build` produces `dist/`, `npm start`
  serves the SPA and API on 4400.
- Real run: start an `implement` session on a DOC-3807 child in
  `~/repositories/worktrees/<KEY>`, watch bootstrapping → starting → working
  → idle, trigger and answer a permission prompt from the browser, interrupt,
  kill, resume, remove the worktree. Record what happened in
  `docs/verification.md` with timestamps and the events.jsonl excerpt.
- README: what it is, prerequisites (tmux, claude, node ≥ 22, env vars),
  `cp config.example.json ~/.config/questionable-choices/config.json`,
  `npm run dev`, `npm run build && npm start`, how to add a board.
- `docs/connectors.md` per spec §16.

## Package 4 — review

One reviewer per package 2a/2b/2c against the spec, then a final
whole-repo review: contract drift between `core/api.ts` and its consumers,
error paths from spec §14, comment policy, dead code.
