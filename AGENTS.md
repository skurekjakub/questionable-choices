# PRIMARY INSTRUCTIONS

1. Ask, don't assume. If something is unclear, ask before writing a single
   line. Never make silent assumptions about intent, architecture, or
   requirements. When running unattended, pick the most reasonable
   interpretation, proceed, and record the assumption rather than blocking.
2. Anything addressed to the user — an answer, a question, a status report, a
   proposal — goes out as a text block on its own, with no tool calls in the
   same message. The harness drops text that is batched with tool calls, so
   the user never sees it. Do the tool work first, then reply.
3. Python is banned as an editing mechanism. No `python3` heredocs, no
   `write_text`, no scripted string replacement, no exception for a mechanical
   sweep across many files. Every file change goes through the Read/Edit/Write
   tools so the edit is visible as a diff and reviewable. Reading a range with
   `sed -n` or `cat` is fine; anything that writes is not.

# AGENTS.md — questionable-choices

Primary place for agent instructions. A local dashboard that turns a Jira
epic into a board of Claude Code sessions: a real `claude` runs in tmux inside
a git worktree, the browser renders it through xterm.js, and the session's
state comes from Claude Code hooks. This file is the index; the design lives
in the linked documents.

## Read before writing code

| File                                             | Why                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`docs/spec.md`](./docs/spec.md)                 | The source of truth. Config schema (§4), the session record and state machine (§5), projection (§6), hook injection and ingress (§8), the cache countdown (§9), the HTTP/WS contract (§11), the UI (§12), persistence (§13), errors (§14), testing rules (§15). Read the sections your change touches, end to end, before touching them. |
| [`docs/connectors.md`](./docs/connectors.md)     | How an issue source, repo or runner is added. Read before touching `src/connectors/` or the interfaces in `src/core/types.ts`.                                                                                                                                                                                                           |
| [`docs/verification.md`](./docs/verification.md) | What a real run looks like, the empirical hook timeline, and the known limits that are deliberate. Read before filing a "bug" against hook timing.                                                                                                                                                                                       |
| [`docs/design-notes.md`](./docs/design-notes.md) | The visual language of the SPA: palette, type, spacing scale, lamp shapes, what colour may and may not carry. Read before touching `src/web/src/styles/`.                                                                                                                                                                                |
| [`docs/plan.md`](./docs/plan.md)                 | Build order and phases. Tells you whether a feature freeze is in force.                                                                                                                                                                                                                                                                  |
| `test/fixtures/hook-events.jsonl`                | The empirical record of what Claude Code hooks actually send. It is evidence, never edited to make a test pass. `statusline-payload.json` likewise.                                                                                                                                                                                      |

## Architecture (one-screen summary)

- **Stack**: single ESM TypeScript package, strict. Hono 4 + `@hono/node-server`
  `upgradeWebSocket` + `ws`, zod 4, node-pty, tmux; React 19 + Vite +
  `@xterm/xterm`; vitest; prettier.
- **Layers**: `src/core` (types, config schema, state machine, prompt builder,
  projection; pure, imports nothing but `zod`), `src/connectors` (jira, git
  worktrees, claude-tmux runner), `src/server` (manager, store, routes, hook
  ingress, terminal sockets), `src/web` (the SPA).
- **Invariants**:
  - `core` never imports `server` or `connectors`.
  - `web` imports only `src/core/api.ts` and `src/core/cache-clock.ts`. Every
    wire type lives in `api.ts`; a new field on the wire is a change there
    first.
  - Every record mutation goes through the manager's per-key `KeyedMutex`;
    never write a record you read outside the lock.
  - Store writes are atomic (write temp, rename); a document that fails the
    shape check is preserved, never overwritten.
  - Hook facts are empirical: `Stop` fires per turn, `PermissionRequest` fires
    for `AskUserQuestion`, `Notification` lags and is generic,
    `PermissionDenied` never fires, Escape emits nothing. Do not design
    against a hook behaviour the fixture does not show.
  - Sessions launch with `--dangerously-skip-permissions` by design; the
    permission mode is the owner's choice per session.
- **Extend by config or connector, never by forking**: another tracker, repo
  or runner is a connector; another epic is a workspace entry.

### Ports

| Port | Process                                   |
| ---- | ----------------------------------------- |
| 4400 | the server (`npm run dev` / `npm start`)  |
| 5173 | Vite dev server for the SPA, mock or real |

Both bind `127.0.0.1`. Never start a second server on 4400 without checking
`ss -ltnp` first, and stop only processes you started, by PID.

## Comments

Two shapes, nothing else:

1. **JSDoc on every function** — summary sentence, then `@param name - text`
   (hyphen, no type), `@returns`, `@throws {Type} When …`. Written as API
   documentation for an unknown caller. Exported types, class members and
   props get the same treatment.
2. **Inline comments at gotchas** — directly above the line where
   correct-looking code is wrong, as long as the point needs.

Write API, not narrative. The test: would the sentence still be true if a
different caller used this function tomorrow? If not, cut it. No flow tracing,
no caller lists, no facts about today's data, no design rationale, no section
banners. Why you chose it goes in the commit message; a behaviour that must
keep working goes in a test name; history stays in `git log`. A comment naming
an old version or a rejected design must not ship.

## Verifying a change

`npm run verify` runs the whole gate in fastest-failure order: typecheck (both
projects), prettier check, the vitest suite, the build. Use it instead of the
four scripts by hand. Prettier runs over Markdown too, so run it on any doc you
edit.

### Tests

North star: **would this test fail if the code under test were broken?** A
test that stays green with the fix reverted is theatre. When you add or change
a test, apply the mutation it exists for, watch the named test go red, revert,
watch it go green, and record the mutation and the red test names in the
commit body.

- Fakes, not mocks of the unit under test: the suite has a fake runner, repo,
  issue source, terminal and `upgradeWebSocket` in `test/server/fakes.ts` and
  the connector tests. Mock Jira through fetch injection, git/tmux/pty through
  the interfaces in `src/core/types.ts`, the clock through `nowMs` parameters
  and fake timers, the filesystem through `mkdtemp` under `os.tmpdir()` with
  `afterEach` cleanup.
- Never, from a test: the owner's config or data dir, port 4400, a real
  `claude`, a real tmux session, the network (one sanctioned loopback probe in
  `test/connectors/git-repo.test.ts`).
- `src/server/main.ts` boots only when it is the process entry. The test that
  proves that is the one thing standing between the suite and the owner's live
  dashboard.
- `.claude/agents/rubber-duk-tests.md` is the auditor for all of this; run it
  in AUDIT mode before claiming coverage.

## Safety rules for anything that runs the product

- The owner's live config is `~/.config/questionable-choices/config.json`
  (or `QC_CONFIG`) and their data lives in `~/.local/share/questionable-choices`.
  A QA run, a probe, a mutation run: copy the config to scratch, point
  `dataDir` and `worktreeDir` at scratch paths, run with `QC_CONFIG` set to the
  copy. Never edit or overwrite the live files.
- Jira credentials come from the env vars the config names. Never print them,
  never write them to a file, never post to Jira from a test session unless
  the run's brief says so.
- A session started for QA runs the real `claude` with bypassed permissions
  and a prefilled prompt that tells it to implement an issue. Replace the
  whole prompt with a harmless probe before starting, and kill any session
  that begins editing files or posting.
- The repos registered in the config belong to the owner. Never check out,
  stash, reset or run scripts inside them; worktrees the product creates under
  a scratch `worktreeDir` are yours to remove.

## Committing

`type(scope): what changed`, rationale in the body, explicit paths staged,
never `-A`. When more than one agent shares a worktree, commit with
`git commit -- <paths>` so a stranger's staged change is never swept in, and
check `git show --stat HEAD` afterwards. Trailers on their own lines:

```
Co-Authored-By: <model name> <noreply@anthropic.com>
```

Fix waves run in a scratch `git worktree` on a `fix/wave-N` branch, never in
the working tree, because the owner's dev server may be serving from it.

## Agents and skills in this repo

| Path                                    | Use                                                                                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.claude/agents/rubber-duk-review.md`   | Hostile read-only reviewer tailored to this repo: hook assumptions, mutex-less mutation, shell quoting in generated scripts, spec drift, theatre. |
| `.claude/agents/rubber-duk-tests.md`    | Mutation-minded test writer and auditor.                                                                                                          |
| `.claude/skills/test-issue/`            | The QA-verification flow, adapted to the dashboard: preflight, scratch config, probes, browser checks, report template.                           |
| `.claude/skills/bootstrap-environment/` | Sets a fresh machine up: tools, config, first run.                                                                                                |

Every implementer or reviewer report ends with three lists: deviations from
`docs/spec.md`, unknown issues hit, and what the next agent must know. The
orchestrator writes them back into the spec or the next brief; they are never
dropped.

When you add a doc that other agents will need to find, link it here.
