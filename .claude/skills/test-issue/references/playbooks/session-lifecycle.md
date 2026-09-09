# Playbook — the session lifecycle

For a change under `src/core/state-machine.ts`, `src/server/session-manager.ts`,
`src/connectors/repos/`, `src/connectors/runners/`, or the start dialog and
session view. This playbook starts real `claude` processes: read
[`../probes.md`](../probes.md) first, and do not press Start on a prefill.

## The start dialog

Open it from a card's primary button. Before replacing the prompt, these are all
clauses, and a screenshot of the open dialog is evidence for all of them:

- **Prefill.** The rendered `promptTemplate` with `{{key}}`, `{{summary}}`,
  `{{type}}`, `{{status}}`, `{{labels}}`, `{{url}}`, `{{description}}`,
  `{{branch}}` and `{{worktree}}` substituted; an unknown variable left exactly as
  written; `{{description}}` as plain text. `{{branch}}` is empty for a `shared`
  playbook, which has no branch at all.
- **Isolation note.** One sentence per mode under the playbook selector, and it
  must match the playbook's actual `isolation`: fresh worktree on a new branch /
  the worktree of the issue's existing branch / the main checkout.
- **Warnings.** `warnings[]` from the prefill route renders as a list, and the
  start is still allowed with any of them. Two exist. One opens with
  "issue text may be stale" and carries the board's source error — induce it by
  breaking the source (see [`board-and-jira.md`](board-and-jira.md)). The other
  says no worktree is registered for the issue and that its branch is resolved
  when the session starts; it appears on an `issue-worktree` playbook whose
  worktree has been removed.
- **Pickers.** Model from `runner.models`, effort from the five levels
  (`low, medium, high, xhigh, max`), permission mode from the seven values
  (`acceptEdits, auto, bypassPermissions, manual, dontAsk, plan, default`).
  Each prefills from the playbook's `defaults` first, then the runner's defaults.
- **Discard guard.** Once the prompt differs from the prefill, closing the dialog
  asks before throwing the edit away. You will hit this on every run, because
  every run replaces the prompt — treat the confirmation as the signal that your
  replacement landed.
- **Empty prompt.** Start stays disabled, and the server refuses an empty prompt
  with 400 independently.

Changing the playbook selector re-fetches the prefill, so an edited prompt is
replaced. Check that the discard guard resets with it.

## The state sequence

Drive it with the probes, one clause per transition, and read three layers for
each: the card in the browser, the record, and
`<dataDir>/sessions/<id>/events.jsonl`.

| Step                                        | Expect                                                                                                                                        |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Start on a **new** worktree                 | `bootstrap-start` → `bootstrapping`, the repo's `bootstrap` command visibly running in the tmux window, then `claude-start` → `starting`      |
| Start on a **reused** worktree, or a resume | No bootstrap announced at all — straight to `starting`                                                                                        |
| First hook                                  | `SessionStart` records `claudeSessionId` and leaves the state at `starting`                                                                   |
| Idle probe                                  | `UserPromptSubmit` → `working`, `Stop` → `idle`, `lastAssistantMessage` set                                                                   |
| Question probe                              | `PreToolUse(AskUserQuestion)` → `waiting-question` with the question as `pending.summary`; the sibling `PermissionRequest` must not demote it |
| Permission probe                            | `PermissionRequest(Bash)` → `waiting-permission`, summary `Bash: <digest>`                                                                    |
| Long probe                                  | `working` held; the lamp is a filled disc and the time-in-state climbs                                                                        |
| Kill                                        | `SessionEnd` → `exited`, `endedAt` set, `exitCode` on the run stays **null**                                                                  |

Every hook and launcher signal is appended to `events.jsonl` with its raw payload
and the resulting state, whether or not it moved the record. The one exception is
a status-line payload that changed nothing — see
[`terminal-and-protocol.md`](terminal-and-protocol.md).

## Needs you: badge, summary, notification

Three separate mechanisms, and they fail separately:

1. **The card's pending line.** A session blocked on the owner shows its pending
   summary as a second line on its row, so a full Needs you column can be triaged
   without opening every card. An `idle` session has no pending, so it correctly
   shows no second line — a board frame carries no assistant snippet.
2. **The header badge**, `document.title` and the favicon — see
   [`board-and-jira.md`](board-and-jira.md).
3. **The desktop notification.** Permission is requested from a header button.
   One notification per session **entering** the needs-you set, titled
   `<KEY> · <state label>`, body = the pending summary or the state label, tagged
   with the session id. The baseline is per workspace and the first board seen of
   a workspace only establishes it: opening the app on three already-waiting
   sessions announces nothing, by design. Test it by watching a session enter the
   set, not by reloading.

## Actions

| Action                  | Route                                        | What to observe                                                                                                                                                                |
| ----------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| interrupt               | `POST /api/sessions/:id/interrupt`           | Sends Escape; the record moves to `idle` **because the action says so** — no hook reports an interrupt                                                                         |
| kill                    | `POST /api/sessions/:id/kill`                | tmux session gone from `tmux ls`, `SessionEnd`, state `exited`, Resume offered                                                                                                 |
| resume                  | `POST /api/sessions/:id/resume`              | Kills any leftover window, relaunches with `--resume <claudeSessionId>`, same cwd; `SessionStart source=resume` must land the record on **`idle`**, not leave it in `starting` |
| resume with no id       | same                                         | Refused; the button is disabled with a title saying the session never reported one                                                                                             |
| mark-done / unmark-done | `POST /api/sessions/:id/mark-done`           | Toggles the **session record's** `done`, shown as a `done` marker on the session row                                                                                           |
| archive                 | `POST /api/sessions/:id/archive`             | Hides the record; **refused with 409 while the session is live**                                                                                                               |
| flags                   | `POST /api/workspaces/:id/issues/:key/flags` | Toggles the **issue's** `review` / `done`, shown as an `in review` / `marked done` chip and moving the card                                                                    |

Session `done` and issue `done` are two different things with similar names. A
change that conflates them shows up as a card that moves when it should not, or a
chip that appears on the wrong row. Test both on the same card.

## Duplicate start

At most one **live** session per (issue, playbook). The card routes around this
deliberately: while a live session exists for the primary playbook, the button
reads `Open <label> session` and navigates instead of starting. So to observe the
refusal you must call the route directly:

```bash
curl -sS -D - -o - -X POST -H 'content-type: application/json' -d '{"playbookId":"implement","prompt":"Probe: no-op.","model":"<id>","effort":"high","permissionMode":"manual"}' http://127.0.0.1:4400/api/workspaces/<ws>/issues/<KEY>/sessions
```

Expect 409, `<KEY> already has a live 'implement' session`, with the detail naming
the clashing session and its state. Both halves are clauses: the status **and**
the card not offering the start in the first place.

A second run of the same playbook after the first has exited gets a **new id**:
the base name `<tmuxPrefix>-<KEY>-<playbookId>` with a compact
`YYYYMMDDTHHMMSS` timestamp appended when the base is already held by a record, so
the earlier run's history is never overwritten. Check the id, and check the older
record still has its own `events.jsonl`.

## The review-column `test` playbook

The `test` playbook is `primaryFor: ["review"]` with isolation `issue-worktree`,
which does **not** create a branch — it finds one. The search order is the
registered worktree, then the newest session record for the issue, then
`git branch -r --list origin/<KEY>-*` resolved to the newest by committer date.

Both outcomes are clauses:

- **A branch exists** → the worktree is recreated from it and bootstrapped, and
  the session runs on that branch, not on the base ref. Confirm with
  `git -C <worktree> branch --show-current`.
- **No branch** → the start is refused, and the message names **everything that
  was searched**. A refusal that just says "no branch" is a regression; the whole
  point is that the owner can see where to look.

## Remove worktree — three refusals

`POST /api/sessions/:id/remove-worktree`, optional `{"force":true}`. All four
failure paths answer 409, and the first three are worth inducing:

1. **The path is the repo's main checkout** — `<path> is the repo's main checkout,
not a worktree`. Reachable from a `shared`-isolation session.
2. **A live session still uses that cwd** — `<id> is still <state> in <path>`, with
   the detail `kill the session before removing its worktree`.
3. **The tree is dirty and `force` is false** — wrapped as `cannot remove <path>`
   with `git status --porcelain` in the message. Induce it by creating an untracked
   file **in the worktree the dashboard made**, never in the owner's main checkout,
   and remove it afterwards.
4. No registered worktree for the issue at all.

**Known defect, already recorded in `docs/verification.md`:** after refusal 2 the
panel offers "Remove anyway, discarding changes", but `force` only overrides a
dirty tree — it cannot override a live session, so the second press earns another 409. The force confirmation belongs on refusal 3 only. Re-observe it; if it is
still there, it is a note, not a new bug, unless the change under test claimed to
fix it.

After a successful removal: gone from `git worktree list`, cleared from
`worktrees.json`, and the card's editor button gone because the issue no longer
has a checkout.

## Failed bootstrap

Set a repo's `bootstrap` to a command that exits non-zero **in the scratch config
only** (`false` is enough), start a session on an issue with no existing worktree,
and expect: `bootstrap-failed` posted with the exit code, state `failed`, the card
carrying a red rail, and the tmux window **still alive** holding the failed shell
so the owner can go and look. `exec bash` at the end of the generated launcher is
what keeps it; a window that vanishes takes the diagnosis with it.

## The cache countdown

`⏳ m:ss` over a depleting gauge, or `❄ cold`. It is absent entirely until
something has reported a cache — a card with no readout is not a bug.

- **Primary source**: the status-line payload's `prompt_cache.expires_at`, which
  only appears once the session has made its first request. The record then holds
  `source: 'statusline'`.
- **Fallback**: on `Stop` with no payload yet, `now + ttlSeconds` with
  `source: 'derived'`. The TTL is read once at boot from the owner's
  `~/.claude/settings.json` `env`: 3600 when `ENABLE_PROMPT_CACHING_1H` is present
  and is not `''`, `'0'` or `'false'`, else 300. Read that file to know which
  number to expect before calling a countdown wrong.
- **Ticking is client-side.** The server broadcasts only when `expiresAt`, `warm`
  or `ttlSeconds` change, so a ticking clock proves nothing about the server.
- **Tones** are fractions of the TTL, not fixed minutes: red at or below `ttl*5/60`,
  yellow at or below `ttl*15/60`, dim above. On a 1 h TTL that is 5 and 15 minutes;
  on a 5 m TTL it is 25 and 75 seconds. A change that hard-codes minutes passes on
  one TTL and fails on the other, so check the one that is **not** in front of you
  by reading the payload's `ttl` label.
- A payload whose `ttl` label the app does not know counts down uncapped and takes
  its bands from the 5 m TTL: the stamped expiry is the fact, the label only bounds it.
