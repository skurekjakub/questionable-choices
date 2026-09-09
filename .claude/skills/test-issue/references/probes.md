# Probes — safe prompts that drive the state machine

Read before starting any session. A probe is a prompt that replaces the playbook's
prefill in the start dialog and does nothing except produce the hook events the
clause needs.

## Why the prefill has to go

The shipped `implement` template tells the session to work on the issue, commit on
its branch, open a pull request and post a comment on the tracker; the `test`
template tells it to run the repo's own QA skill on a real branch. Both run with
whatever permission mode the picker holds, and the shipped default is
`bypassPermissions`, which the runner launches as `--dangerously-skip-permissions`.
A verification run that presses Start on a prefill has just dispatched a real
unattended agent at the owner's repository.

So the prefill is **read, recorded, checked and then deleted**:

1. Read it in the dialog. It is a clause — check it against the playbook's
   `promptTemplate` in the config and against spec §7: every `{{key}}`,
   `{{summary}}`, `{{branch}}`, `{{worktree}}` substituted, unknown variables left
   literal, `{{description}}` as plain text with no ADF markup left in it.
2. Screenshot it. That screenshot is the evidence for the prefill clause.
3. Select all, delete, paste the probe. Confirm the textarea holds only the probe
   before pressing Start — the dialog asks for confirmation on close once the
   prompt differs from the prefill, which is a useful signal that your edit landed.

## Rules every probe follows

- **No writes.** No file edit, no `git` command that changes anything, no commit,
  no push, no branch, no npm script, no install.
- **No outward traffic.** No comment, no API call, no MCP tool, no web fetch.
- **Bounded.** One turn, one tool at most, then stop. Every probe ends with an
  explicit instruction to stop.
- **Named.** Start each probe with `Probe:` so a stray line in a transcript, a
  worktree, or the owner's history is obviously from a test run.
- **Watched.** If a session does anything a probe did not ask for — touches a file,
  runs a build, posts anywhere — kill it from the UI, capture
  `tmux capture-pane -p -t <session id>` and `git status --porcelain` in its
  worktree, and report it. Do not try to undo its work in the owner's repository.

Before any of them, note what the launch itself should show: a **new** worktree
means the generated `run.sh` posts `bootstrap-start`, runs the repo's `bootstrap`
command in the tmux window (`npm ci` for `docs-workspace`), and the card sits in
`bootstrapping` until it exits 0; a **reused** worktree or a resume announces no
bootstrap and goes straight to `starting`.

## 1. Idle probe — the shortest full lifecycle

```
Probe: this is an automated dashboard test. Do not use any tool, do not read or
write any file. Reply with the single word READY and stop.
```

| Layer          | What it should produce                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------- |
| `events.jsonl` | `claude-start` → `SessionStart` (`source=startup`, records `claudeSessionId`) → `UserPromptSubmit` → `Stop` |
| State          | `starting` → `working` → `idle`                                                                             |
| Card           | Lamp turns to the waiting ring, state word "your turn", card in **Needs you**, time-in-state counting up    |
| Terminal       | `READY` in the pane, prompt returned                                                                        |
| Record         | `lastAssistantMessage` holds the reply; `pending` stays null                                                |

This is also the cheapest way to make a `claudeSessionId` exist, which `resume`
requires — a session that never reached `SessionStart` cannot be resumed and the
Resume button is correctly disabled with a title saying so.

## 2. Question probe — `waiting-question`

```
Probe: this is an automated dashboard test. Use the AskUserQuestion tool exactly
once, asking "Probe question: pick A or B" with the two options A and B. Use no
other tool and change nothing. After I answer, reply with the single word DONE
and stop.
```

| Layer          | What it should produce                                                                                                                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `events.jsonl` | `PreToolUse` with `tool_name: AskUserQuestion` → `waiting-question`, then `PermissionRequest` for the same tool, which must **not** demote it to `waiting-permission`                                       |
| State          | `working` → `waiting-question` → (after the answer) `working` → `idle`                                                                                                                                      |
| Card           | Amber lamp, "has a question", and the question text as the card's pending line — the whole point of the summary being on the card is triaging a full Needs you column without opening each one              |
| Notification   | A `Notification` with `notification_type: permission_prompt` arrives about six seconds later and must be **dropped** by the guard, because a pending is already open. Seeing it change the card is a defect |

Answer it **in the browser terminal**, by pressing Enter on the highlighted
option, so the answer is evidence that keystrokes reach the pty. A question
answered quickly can land its `PostToolUse` before the lagging `Notification`,
which is the other half of the guard.

## 3. Permission probe — `waiting-permission`

Set the permission mode picker to **`manual`** before starting. The README names
`manual` as the mode that makes the session ask about every tool call.

```
Probe: this is an automated dashboard test. Run exactly `echo probe` with the
Bash tool, once. Use no other tool, read nothing and change nothing. Then reply
with the single word DONE and stop.
```

| Layer                                 | What it should produce                                                                                                                                                                                                                               |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `events.jsonl`                        | `PreToolUse` (`Bash`) → `working`, `PermissionRequest` (`Bash`) → `waiting-permission`                                                                                                                                                               |
| Card                                  | Amber lamp, "needs permission", pending summary `Bash: <one-line digest of tool_input>`                                                                                                                                                              |
| After answering "yes" in the terminal | `PostToolUse` → `working` → `Stop` → `idle`                                                                                                                                                                                                          |
| After answering "no"                  | **Nothing at all fires.** `PermissionDenied` does not exist in practice, and no `PostToolUse` follows. The card stays in `waiting-permission` until the next prompt or the interrupt action clears it — accepted, recorded in `docs/verification.md` |

`permissionMode: default` passes **no flag**, leaving the CLI in whatever the
owner's own settings default to; in the last recorded run that was `auto` and two
Bash calls ran with no prompt at all. That is why `waiting-permission` has only
ever been covered by the recorded fixture. If `manual` also produces no prompt,
say so plainly and cite `test/fixtures/hook-events.jsonl` as the only coverage
rather than claiming the path works.

**Read the summary against the event it came from.** `tool_input` is not stable
across a tool's events: `PreToolUse` sees what the model asked for, while
`PermissionRequest` and `PostToolUse` can see a command an owner's own PreToolUse
hook rewrote. A summary that differs from what you typed is not necessarily wrong.

## 4. Long probe — `working`, and something to interrupt

```
Probe: this is an automated dashboard test. Without using any tool at all, write
the numbers 1 to 15, one per line, each followed by one short sentence. Take your
time. Then stop.
```

| Layer     | What it should produce                                                                                                                                                                   |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| State     | `working`, held long enough to watch the card, the lamp and the time-in-state, and to click Interrupt                                                                                    |
| Card      | Cyan lamp (filled disc), "working", cache countdown ticking down client-side once a statusline payload has arrived                                                                       |
| Interrupt | The action sends Escape and moves the record to `idle` itself. **No hook reports it** — no `Stop`, no `PostToolUse` — so `idle` here means the action worked, not that the turn finished |

"Without using any tool at all" is load-bearing: a model that reaches for a shell
to count backgrounds it and returns immediately, and the interrupt then correctly
does nothing to an already-`idle` session. That happened twice in the recorded
run, and it is the reason the interrupt clause is hard to land rather than a
defect. If it still races, record the two timestamps from `events.jsonl` — a
`UserPromptSubmit` and an `interrupt` milliseconds apart is the proof.

## Resuming a probe session

After a kill, Resume regenerates the launcher with `--resume <claudeSessionId>`,
so no prompt is sent at all. The only event is `SessionStart` with
`source: resume`, and the record must move `starting` → `idle` on it — the
transcript is replayed and the CLI stops at the prompt, so nothing else will ever
arrive. A session stuck in `starting` after a resume is the regression `12a45ae`
fixed and is worth checking on every run that touches `src/core/state-machine.ts`.
