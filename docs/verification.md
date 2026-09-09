# Verification run — 2026-09-09

Package 3's integration check: the dashboard driven against the owner's real
configuration, the real DOC-3807 epic on `kentico.atlassian.net`, and one real
`claude` session in tmux on a real git worktree of `docs-workspace`.

Environment: WSL2, node 24.18.0, tmux 3.6, Claude Code 2.1.267 (the runner was
designed against 2.1.266), config at `~/.config/questionable-choices/config.json`,
server on 4400, Vite on 5173. Browser driven through Playwright.

## What was exercised

| Step                                                  | Result                                                  |
| ----------------------------------------------------- | ------------------------------------------------------- |
| `GET /api/config/public`                              | first try; both workspaces, three models, seven modes   |
| `GET /api/workspaces/docs-nextjs/board`               | first try; 72 backlog + 1 review, `sourceError: null`   |
| `GET /api/workspaces/docs-nextjs-migration/board`     | first try; 6 backlog + 1 review                         |
| Board render, workspace switch, back                  | first try; zero console errors                          |
| Start an `implement` session on DOC-3871              | first try; every state reached                          |
| Answer an `AskUserQuestion` from the browser terminal | first try; keystrokes reach tmux                        |
| Interrupt                                             | first try once it caught a `working` turn (see below)   |
| Kill                                                  | first try                                               |
| Resume                                                | **broken** — stuck in `starting`; fixed, then first try |
| Open in VS Code                                       | spawned; outcome unobservable (see below)               |
| Remove worktree                                       | first try, no `--force` needed                          |

## Timeline

All times UTC. One session, `qc-DOC-3871-implement`, playbook `implement`,
model Fable 5.1, effort high, permission mode `default`, on issue DOC-3871
("Indentation of codelinks", To Do, unassigned). The prompt was replaced with
a smoke-test body that writes nothing and posts nothing.

| Time         | What happened                                                                      |
| ------------ | ---------------------------------------------------------------------------------- |
| 19:29:28     | Server boot; both boards prefetched from Jira                                      |
| 19:30:04     | Board opened at `127.0.0.1:5173`; 73 cards                                         |
| 19:30:46     | Switched to DOC-2778 (7 cards) and back                                            |
| 19:32:57     | Start clicked → `bootstrapping`; worktree added, `npm ci` running in tmux          |
| 19:33:14     | `npm ci` done (629 packages, 17 s) → `claude-start` → `starting`                   |
| 19:33:16     | `SessionStart` (`source: startup`) recorded the Claude session id                  |
| 19:33:17     | `UserPromptSubmit` → `working`                                                     |
| 19:33:21     | `PreToolUse` `AskUserQuestion` → `waiting-question`, summary on the card           |
| 19:33:27     | `Notification` `permission_prompt` arrived 6 s later, correctly ignored            |
| 19:35:22     | Question answered by pressing Enter in the browser terminal → `working`            |
| 19:35:24–27  | Two `Bash` calls (`git status`, `git branch --show-current`), no permission prompt |
| 19:35:29     | `Stop` → `idle`, "your turn", assistant snippet stored                             |
| 19:39:54     | Follow-up prompt typed in the browser terminal → `working` → `idle`                |
| 19:42:38.692 | Follow-up prompt → `working`                                                       |
| 19:42:38.734 | Interrupt (42 ms later) → `idle`; Escape cancelled the turn, no `Stop` fired       |
| 19:43:03     | Kill → tmux session gone, `SessionEnd`, `exited`, Resume offered                   |
| 19:43:26     | Resume → `starting`, and **stayed there** (bug, fixed below)                       |
| 19:45:46     | Resume again, with the fix → `idle` 2.5 s later                                    |
| 19:46:04     | Open in VS Code: `cmd.exe /c code --remote wsl+Ubuntu …` spawned, exited at once   |
| 19:50:23     | Remove worktree while the session was live → refused, 409, message shown           |
| 19:50:56     | Kill                                                                               |
| 19:51:58     | Remove worktree → gone from `git worktree list`, registry cleared                  |
| 19:52:25     | `git branch -D DOC-3871-indentation-of-codelinks`                                  |

Elapsed from clicking Start to a session waiting on a question: 24 seconds,
17 of them `npm ci`.

## events.jsonl excerpt

Paths and the Claude session id are scrubbed. Status-line payloads are
omitted; the fix below is why there are now far fewer of them.

```
2026-09-09T19:32:57.964Z  bootstrap-start      bootstrapping
2026-09-09T19:33:14.914Z  claude-start         starting
2026-09-09T19:33:16.928Z  SessionStart         starting           source=startup
2026-09-09T19:33:17.345Z  UserPromptSubmit     working            mode=auto
2026-09-09T19:33:21.881Z  PreToolUse           waiting-question   tool=AskUserQuestion mode=auto
2026-09-09T19:33:21.917Z  PermissionRequest    waiting-question   tool=AskUserQuestion mode=auto
2026-09-09T19:33:27.911Z  Notification         waiting-question   notification=permission_prompt
2026-09-09T19:35:22.012Z  PostToolUse          working            tool=AskUserQuestion mode=auto
2026-09-09T19:35:24.551Z  PreToolUse           working            tool=Bash mode=auto
2026-09-09T19:35:25.478Z  PostToolUse          working            tool=Bash mode=auto
2026-09-09T19:35:27.248Z  PreToolUse           working            tool=Bash mode=auto
2026-09-09T19:35:27.342Z  PostToolUse          working            tool=Bash mode=auto
2026-09-09T19:35:29.423Z  Stop                 idle               mode=auto
2026-09-09T19:40:44.654Z  Stop                 idle               mode=auto
2026-09-09T19:40:51.887Z  interrupt            idle
2026-09-09T19:42:38.692Z  UserPromptSubmit     working            mode=auto
2026-09-09T19:42:38.734Z  interrupt            idle
2026-09-09T19:43:03.187Z  kill                 exited
2026-09-09T19:43:03.954Z  SessionEnd           exited             reason=other
2026-09-09T19:43:26.302Z  bootstrap-start      bootstrapping
2026-09-09T19:43:26.316Z  claude-start         starting
2026-09-09T19:43:29.094Z  SessionStart         starting           source=resume   <- before the fix
2026-09-09T19:45:46.977Z  claude-start         starting
2026-09-09T19:45:49.488Z  SessionStart         idle               source=resume   <- after the fix
2026-09-09T19:50:56.603Z  kill                 exited
2026-09-09T19:50:57.015Z  SessionEnd           exited             reason=other
```

## The prompt-cache countdown

Confirmed as spec §9 describes it. `prompt_cache` is absent from the
status-line payload until the session has made its first request, and present
from then on:

```json
{
  "warm": true,
  "caching_observed": true,
  "ttl": "1h",
  "expires_at": 1788986128,
  "requests": 4,
  "misses": 0,
  "hit_ratio": 0.869,
  "recache_tokens_if_cold": 53753
}
```

The record took `cache = { expiresAt: 1788986128, ttlSeconds: 3600, warm: true,
source: 'statusline' }` from it, and the card's countdown ticked down from
`⏳ 59:55` client-side. The `derived` fallback never had to fire, because the
first payload carrying `prompt_cache` arrived before the first `Stop`.

The owner's own status line kept rendering inside the tmux window, so the
pass-through in the generated `statusline.sh` works. From `tmux capture-pane`
during the run:

```
Fable 5.1 · ⚡high · ⎇ DOC-3871-indentation-of-codelinks · DOC-3871 · 54k/1M (5%) · ⏳ 58:52
⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
```

## What was fixed

| Commit    | Fix                                                                                                                                                                                                                                                                                                                                                               |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `a915759` | `src/web/src/styles/session.css` — the session grid had no row track, so the implicit `auto` row took the xterm's intrinsic height, overflowed the shell, and focusing the terminal scrolled the header out of an `overflow: hidden` container for good. Interrupt, Kill, Resume, the state pill and the countdown all became unreachable.                        |
| `12a45ae` | `src/core/state-machine.ts` — a resumed session sat in `starting` forever. `--resume` replays the transcript and stops at the prompt, so no `UserPromptSubmit` or `Stop` follows; the only event is `SessionStart` with `source: resume`, which repeats the id the record already holds and was being discarded as a duplicate. It now moves `starting` → `idle`. |
| `56c0104` | `src/server/session-manager.ts` — `spawn` reports a missing executable as an asynchronous `error` event, not a throw, so the try/catch around the detached editor launch caught nothing and the unhandled event killed the whole server. A misconfigured `editor.command` took every live session's state tracking with it.                                       |
| `c37dba6` | `src/server/main.ts` — `SIGINT`/`SIGTERM` never completed: `server.close` waits for every open connection and an attached browser holds its event socket, plus one terminal socket per session view, open for the life of the tab. tsx force-killed the dev server on every reload.                                                                               |
| `acbcda9` | `src/server/session-manager.ts` — `refreshInterval: 1` posts a status-line payload every second and each one was logged. This run wrote 870 of them against 47 real events, 1.4 MB in which the lifecycle was unreadable. A payload the reducer rejects as unchanged is no longer logged. Spec §5.3 moved with it.                                                |
| `9072534` | `src/connectors/runners/claude-tmux/index.ts` — the browser was left showing a killed session, reflowed its terminal, and the resize frame reached a pty whose descriptor node-pty had already closed. `ioctl(2) failed, EBADF` went uncaught and took the server down mid-run, losing every other session's tracking. `write` had the same hazard.               |

Three of those six are the same shape: a failure that arrives outside the
request that caused it — an async `spawn` error, an unhandled `error` event, a
throw from a socket handler — and the server has no last-resort guard, so any
one of them ends every session's state tracking at once. There is no
`uncaughtException` handler, deliberately: swallowing these would have hidden
all three rather than fixing them. But the reconciler cannot recover a record
whose events were never received, so a crash is not merely an outage.

## What still does not work

**A live session blocks Remove worktree, but the UI offers the force escape
anyway.** The refusal is correct — "qc-DOC-3871-implement is still idle in
`<path>`, kill the session before removing its worktree" — but the panel then
shows "Remove anyway, discarding changes" / "Keep it". `force` only overrides a
dirty tree; it cannot override a live session, so "Remove anyway" just earns a
second 409. The force confirmation belongs on the dirty-tree refusal only.

**"Open in VS Code" cannot report whether it worked.** `cmd.exe /c code
--remote wsl+Ubuntu <path>` was spawned detached with `stdio: 'ignore'` and
exited immediately; no new `vscode-server` process appeared, which is
consistent both with an existing VS Code window taking the folder and with the
launch failing silently. Since `c37dba6` a spawn failure at least reaches the
server log, but a `cmd.exe` that starts and then fails is still invisible. The
button was pressed once, as instructed, and not retried.

**Interrupt is hard to land on a real turn.** Twice the model backgrounded the
counting shell and returned before the click arrived, so the action correctly
did nothing to an already-`idle` session. It was only proven by racing the API:
`UserPromptSubmit` at 19:42:38.692, interrupt at 19:42:38.734, `idle`. This is
not a defect — it confirms spec §5.3's note that Escape emits no hook, so the
action is the only thing that can move a `working` session — but a card cannot
distinguish "interrupted" from "finished".

**A killed session's run never gets an exit code.** `tmux kill-session` takes
the whole shell down, so the `claude-exit` POST at the end of `run.sh` never
happens and `runs[n].exitCode` stays `null`. Only a `/exit` inside the session
records one.

**`permission mode: default` does not mean "ask me".** Passing no
`--permission-mode` flag leaves the CLI in whatever the owner's settings
default to; here that is `auto`, and the two `git` calls ran with no prompt.
No `PermissionRequest` for a non-question tool was observed in this run, so the
`waiting-permission` path is still only covered by the recorded probe in
`test/fixtures/hook-events.jsonl`.

**The board card does not say what the session is asking.** The card shows
playbook, state and time in state; the pending summary appears only in the
session header and the drawer. With several sessions waiting, the Needs you
column cannot be triaged without opening each one.

**A card with a live session still offers to start another one.** The primary
button stays "Start Implement" while an `implement` session is live; the server
answers 409. It should open the session instead.

**Vite dev logs two WebSocket warnings on load.** React StrictMode mounts the
effect twice, so the first socket is closed before its handshake completes.
Harmless, and absent from a production build.
