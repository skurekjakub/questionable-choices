# questionable-choices — design spec

Local dashboard that turns an issue-tracker epic into a board of Claude Code
sessions. Click an issue, start a session in tmux inside a git worktree, watch
it in the browser, answer it when it needs you. One person, one machine (WSL),
no auth, bound to `127.0.0.1`.

Status: approved design, 2026-09-09. Decisions below were taken with the owner
in the brainstorm; anything marked _assumption_ was taken unattended.

## 1. Goals and non-goals

Goals

- Board of the open children of one Jira epic, organised by what the owner
  needs to do next: Backlog · Working · Needs you · Review · Done.
- One click starts a real `claude` CLI session (full TUI, plugins, skills,
  statusline) in a tmux session, in a fresh git worktree of the target repo.
- The session renders in the browser (xterm.js attached to tmux) and its
  state (working / waiting for permission / asked a question / your turn /
  exited) is tracked through Claude Code hooks, not screen scraping.
- Playbooks: an issue can be dispatched with different kickoff prompts —
  `implement` on a fresh worktree, `test` on the issue's existing branch with
  the repo's `test-issue` skill. Model, effort and permission mode are
  pickable per session.
- Connector architecture: issue source, workspace and runner are pluggable
  behind small interfaces, configured in a JSON file, so another epic, repo or
  tracker is a config entry, not a fork.
- Prompt-cache countdown per session card, same semantics as the owner's
  statusline (`~/.claude/statusline.sh`).

Non-goals (MVP)

- Writing to Jira from the dashboard (the session does that through the repo's
  Jira MCP when the playbook tells it to).
- Multi-user, remote access, auth.
- Sessions not started by the dashboard.
- Merging, PR creation, worktree cleanup automation.
- Cost / token accounting beyond what the statusline payload already carries.

## 2. Vocabulary

| Term          | Meaning                                                                                                                           |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Workspace     | One Jira epic, read through one connector and worked in one repo. The header dropdown switches workspaces; a board is its view.   |
| Board         | The dashboard view of one workspace: its epic projected onto columns. Same id as the workspace.                                   |
| Connector     | An issue-tracker account (Jira site + credential env vars). Workspaces reference it by id; several may share one.                 |
| Repo          | A git repository plus its worktree policy, bootstrap command and playbooks. Workspaces reference it by id; several may share one. |
| Issue source  | The connector-backed reader that lists a workspace's issues (Jira epic today).                                                    |
| Runner        | Connector that launches, attaches, interrupts and kills sessions (`claude` in tmux today).                                        |
| Playbook      | Named kickoff recipe on a repo: prompt template, isolation mode, defaults, which board columns show it as the primary action.     |
| Session       | One tmux session running one `claude` process for one issue and one playbook. Has a persistent record.                            |
| Session state | Where the session is in its lifecycle — see §5.                                                                                   |
| Column        | Board lane derived from session state and issue status — see §6.                                                                  |

## 3. Repository layout

Single npm package, TypeScript, ESM. No monorepo.

```
src/
  core/                 pure domain; no I/O, no node built-ins beyond types
    types.ts            Issue, SessionRecord, SessionState, Playbook, Board…
    config.ts           zod schema for config.json, ~ expansion, defaults
    state-machine.ts    hook event → state transition (pure function)
    prompt.ts           template rendering ({{key}} … ) and slug()
    projection.ts       issues + sessions → columns/cards for the board
    cache-clock.ts      prompt-cache expiry derivation
    api.ts              wire types shared with src/web (REST + WS payloads),
                        plus NEEDS_YOU_STATES / LIVE_STATES, which the reducer
                        imports from here so the SPA never reaches into it
  connectors/
    issues/jira/        IssueSource over Jira Cloud REST v3
    repos/git/          Repo over git worktrees (worktree | issue-worktree | shared)
    runners/claude-tmux/Runner: tmux + claude + generated hook settings + node-pty attach
  server/
    main.ts             boot: load config, build connectors, start Hono + WS
    app.ts              routes
    session-manager.ts  orchestration, persistence, event fan-out
    store.ts            JSON persistence under dataDir
    config-file.ts      reads config.json off disk and hands it to the schema
    config-check.ts     `npm run config:check`: validates the config and exits
    connectors.ts       the server's only import of the connector package
    hooks.ts            hook ingress → state machine → broadcast
    terminal-ws.ts      WS ↔ node-pty bridge
    mutex.ts            per-key serialisation of read-modify-write sequences
    util.ts             shared JSON-body reader, error-message helper, and the
                        process-entry gate and drain-safe exit both entry
                        points use
  web/                  Vite + React SPA (vite.config.ts, index.html, src/,
                        including dev-mock.ts, which VITE_MOCK=1 installs)
test/                   vitest: core/, connectors/, server/ and web/, plus
                        fixtures/. `test/web` holds the SPA's own suites,
                        including component suites that opt into jsdom with a
                        per-file `@vitest-environment jsdom` docblock; every
                        other file runs in the node environment
docs/                   spec.md, plan.md, connectors.md, design-notes.md,
                        verification.md, screenshots/
config.example.json     the owner's real shape, minus secrets
```

Dependency direction: `web → core/api.ts` and `core/cache-clock.ts` (both of
which import only types from `core/types.ts`, and neither of which imports the
reducer) only; `server → core, connectors`;
`connectors → core`. `core` imports nothing from the other three, and reads no
files: `loadConfig` lives in `server/config-file.ts` so `core/config.ts` stays
a pure schema.

## 4. Configuration

File: `~/.config/questionable-choices/config.json` (override with
`QC_CONFIG=/path`). Validated with zod at boot; a bad config fails boot with
the zod issue list. `config.example.json` in the repo is the owner's real
shape. Credentials are never in the file: `emailEnv` / `tokenEnv` name the
environment variables that hold them.

Shape (see `config.example.json` for the live values):

```
port                       number, default 4400
dataDir                    default ~/.local/share/questionable-choices
editor
  command                  default 'code'
  args[]                   default ['{{path}}']; `{{path}}` is replaced by the worktree path.
                           Under WSL the Windows CLI is the one that reaches the desktop:
                           command 'cmd.exe', args ['/c','code','--remote','wsl+<distro>','{{path}}']
runner
  type                     'claude-tmux'
  claudeBin                default 'claude'
  tmuxPrefix               default 'qc' → tmux session names qc-<KEY>-<playbook>,
                           suffixed with a timestamp when that name is taken (§5.1)
  models[]                 {id,label} shown in the picker
  defaultModel / defaultEffort / defaultPermissionMode
connectors{id}
  type                     'jira'
  site, emailEnv, tokenEnv
workspaces{id}             what the header dropdown switches between
  name                     shown in the switcher
  epic                     parent key (`DOC-3807`) or numeric issue id; the shape is
                           validated, and a key (never a numeric id, which JQL would
                           then resolve as a key first) is quoted into the default JQL
                           parent = "<epic>" AND statusCategory != Done ORDER BY Rank ASC
  jql?                     raw override of the whole query
  connector                connector id
  repo                     repo id
  reviewStatuses[]         Jira status names that land in the Review column; default ['Ready for review']
  pollSeconds              default 120
repos{id}
  path                     absolute path of the main checkout
  worktreeDir              where worktrees go; worktree path = <worktreeDir>/<KEY>
  baseRef                  'origin/main'; its remote is fetched at the start of every
                           non-shared `prepare`, before the reuse check, under a kill
                           deadline (`GIT_NETWORK_TIMEOUT_MS`) because it runs inside the
                           caller's checkout lock. The fetch is an attempt: an unreachable
                           remote leaves the refs stale and the start dialog says so, it
                           never refuses the start. Before the first fetch of a process the
                           dialog warns that nothing has checked the refs yet, which is a
                           different answer from "they are current"
  branchPattern            '{{key}}-{{slug}}'
  bootstrap                shell string run in the tmux session after a NEW worktree
  playbooks[]
    id, label, description
    isolation              'worktree' | 'issue-worktree' | 'shared'
    primaryFor[]           column ids where this playbook is the card's primary action
    defaults?              {model?, effort?, permissionMode?}
    promptTemplate         see §7
```

`epic` is required even when `jql` overrides the query: a workspace is one
epic, and its key is what the switcher and the header show.

Workspaces are added and removed from the UI (§12); the server validates the
request with the same zod schema, writes the whole config back to the file
(tmp + rename; the file is JSON, so no comments to preserve) and applies it
live. A rewritten file carries absolute paths: `~` is expanded while parsing
and is not restored. A connector may be created inline from the same dialog.
Repos stay file-only: a playbook set is not a form.

`npm run config:check` loads the same file the server would, prints the
resolved path, one line per workspace and repo and one line per named
credential variable that does not resolve, and exits 1 on a zod failure or a
repo path that is not a git checkout.

Valid `effort`: low, medium, high, xhigh, max. Valid `permissionMode`:
acceptEdits, auto, bypassPermissions, manual, dontAsk, plan, plus `default`
meaning "pass no flag". These are the values `claude --help` listed at 2.1.266,
which is the release every empirical claim in this document was measured on;
the picker offers exactly these. `bypassPermissions` is launched as
`--dangerously-skip-permissions`, not as `--permission-mode
bypassPermissions`: only the flag skips the prompts an unattended session has
nobody to answer. It is the shipped default, and the picker can still change
it per session.

## 5. Session lifecycle and state machine

### 5.1 Record

```ts
interface SessionRecord {
  id: string; // tmux session name, e.g. qc-DOC-3847-implement; a compact
  // timestamp is appended when a record already holds that name, so a second
  // run of the same playbook cannot overwrite the first one's history
  issueKey: string;
  playbookId: string;
  repoId: string; // sessions belong to a repo and an issue, not to a workspace
  cwd: string;
  branch: string | null; // null for isolation 'shared'
  model: string;
  effort: Effort;
  permissionMode: PermissionModeSetting; // includes 'default', which passes no flag
  prompt: string; // exactly what was sent
  claudeSessionId: string | null; // from the SessionStart hook
  state: SessionState;
  stateSince: string; // ISO
  pending: { kind: 'permission' | 'question'; summary: string } | null;
  // What the last Notification said. It never moves `state` (§5.3); the next
  // lifecycle event clears it.
  hint: { summary: string; at: string } | null;
  lastAssistantMessage: string | null; // snippet, from Stop hook when present
  lastExitCode: number | null; // bootstrap's or the CLI's, whichever ended last
  // Server start that found this live record already older than itself, or
  // null when the state is current (§5.5). Never set from a status-line
  // payload, which carries no state.
  staleSince: string | null;
  lastEventAt: string | null; // last accepted event that carried lifecycle information
  cache: {
    expiresAt: number | null;
    ttlSeconds: number;
    warm: boolean;
    source: 'statusline' | 'derived';
  } | null;
  createdAt: string;
  endedAt: string | null;
  done: boolean;
  archived: boolean;
  // exitCode stays null on a killed run: kill takes the whole tmux shell down,
  // so the launcher never posts one. Only a run that ended on its own has a code.
  runs: Array<{ startedAt: string; kind: 'start' | 'resume'; exitCode: number | null }>;
}
```

Cardinality: at most one **live** session per (issue, playbook). A live session
is any state except `exited` / `failed`. Older records stay in history
(`archived` hides them from the card).

### 5.2 States

```
bootstrapping   worktree created, bootstrap command running in the tmux session
starting        claude launched, no hook event yet
working         claude is executing a turn
waiting-permission  a permission prompt is on screen
waiting-question    AskUserQuestion is on screen
idle            claude finished a turn and sits at the prompt — "your turn"
exited          the claude process ended (clean or not); tmux window may still hold a shell
failed          bootstrap or launch failed; tmux window holds the failed shell
```

`needs-you` set = { waiting-permission, waiting-question, idle }.
`live` set = everything except { exited, failed }.

### 5.3 Transitions (pure function in `core/state-machine.ts`)

Inputs are the hook events the runner forwards (§8) plus two launcher signals.

| Event                                           | From                                    | To                 | Side data                                                                                          |
| ----------------------------------------------- | --------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------- |
| launcher `bootstrap-start`                      | any                                     | bootstrapping      |                                                                                                    |
| launcher `bootstrap-failed`                     | bootstrapping                           | failed             |                                                                                                    |
| launcher `claude-start`                         | bootstrapping, starting, exited, failed | starting           | new run appended; `pending`, `endedAt`, `lastAssistantMessage` and `lastExitCode` cleared          |
| hook SessionStart (source ≠ resume)             | any                                     | unchanged          | record `claudeSessionId`; an empty id never overwrites a known one                                 |
| hook SessionStart (source = resume)             | starting                                | idle               | the only signal that a resumed session is back at the prompt; never notifies                       |
| hook UserPromptSubmit                           | any live                                | working            | clear pending                                                                                      |
| hook PreToolUse (tool ≠ AskUserQuestion)        | any live                                | working            | clear pending                                                                                      |
| hook PreToolUse (AskUserQuestion)               | any live                                | waiting-question   | pending.summary = question text from tool_input                                                    |
| hook PostToolUse / PostToolUseFailure (any)     | any live                                | working            | clear pending                                                                                      |
| hook PermissionRequest (tool ≠ AskUserQuestion) | any live                                | waiting-permission | pending.summary = `<tool_name>: <one-line tool_input digest>`                                      |
| hook PermissionRequest (AskUserQuestion)        | any live                                | waiting-question   | pending.summary = question text; must not demote the PreToolUse verdict                            |
| hook Notification (any type)                    | any live not already needs-you          | unchanged          | `hint` = the message, capped at 280 chars, plus the time it arrived; never notifies                |
| hook Notification (any type)                    | any needs-you, exited, failed           | unchanged          | nothing at all                                                                                     |
| hook PermissionDenied                           | any live                                | working            | clear pending                                                                                      |
| hook Stop                                       | any live                                | idle               | lastAssistantMessage when the payload carries it; cache.derived = now + ttl                        |
| action interrupt                                | working, waiting-\*                     | idle               | the runner sent Escape; no hook reports an interrupt; `pending` and `lastAssistantMessage` cleared |
| hook SessionEnd                                 | any                                     | exited             | endedAt                                                                                            |
| launcher `claude-exit`                          | any                                     | exited             | exit code on the last run                                                                          |
| statusline payload                              | any                                     | unchanged          | cache from `prompt_cache` (§9); never stamps `lastEventAt`, never clears `staleSince`              |

**A Notification never changes `state`.** It lags the dialog it describes by
~6 s, carries only `notification_type` and a generic message, and nothing on it
places it in a turn or a run: a state derived from one can therefore outlive the
dialog with no later event guaranteed to clear it, which is a card stuck in
Needs you on a session that is working. Converged, slightly inaccurate reporting
beats a state machine that is right most of the time and wrong unrecoverably.

So the record keeps it as a `hint` instead — the message, capped like an
assistant snippet, and the time it arrived. `CardSession.hint` carries the
summary alone, for a UI to render as "this session may need you"; `needsYou`,
the lane and the desktop notification are all untouched by it. A Notification
that arrives while the record is already in a needs-you state, or is not live,
does nothing at all. Every accepted lifecycle event other than a status-line
payload clears the hint, so a hint never outlives the turn it arrived in by
more than one event.

The consequences are stated rather than hidden: a `PermissionRequest` the hook
transport drops (`curl … || true`) leaves the session `working` with a hint,
and no card moves to Needs you for it. The events log still holds the
Notification, and `docs/verification.md` records the limitation.

Unknown events are ignored and logged. Every hook and launcher signal is
appended to `<dataDir>/sessions/<id>/events.jsonl` (the payload as it arrived,
capped per §13, plus the resulting state) whether or not it moved the record. The one exception is a status-line
payload that changed nothing: `refreshInterval: 1` posts one every second, and
a 19-minute verification session logged 870 of them against 47 real events —
1.4 MB in which the lifecycle was unreadable.

Hook facts the design relies on, measured on 2026-09-09 against Claude Code
2.1.266 with the §8.1 settings file and kept as
`test/fixtures/hook-events.jsonl`. The integration run in
`docs/verification.md` was against 2.1.267 and observed the same shapes, so
nothing below is known to have moved — but the measurements are 2.1.266's and
the release is what they are pinned to:

- Every payload carries `session_id`, `transcript_path`, `cwd`,
  `scratchpad_dir`, `hook_event_name`. `permission_mode` is on
  UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest and Stop — not
  on SessionStart, Notification or SessionEnd, so the record's own mode is the
  only reliable source. SessionStart adds `source` and `model`; SessionEnd
  adds `reason` (`prompt_input_exit` on `/exit`).
- Tool events carry `tool_name`, `tool_input` and `tool_use_id`; PostToolUse
  adds `tool_response` and `duration_ms`. `AskUserQuestion` is a named tool
  and its `tool_input.questions[].question` is the summary to show.
- `AskUserQuestion` also raises **PermissionRequest**, and its Notification
  arrives as `notification_type: "permission_prompt"`, not
  `elicitation_dialog` — `tool_name`, never the notification type, decides
  question versus permission. `elicitation_dialog` was not observed at all.
- Notification lags the dialog by ~6 s and carries only
  `notification_type` and a generic `message` ("Claude needs your
  permission"), so it is a fallback, never the primary signal. `idle_prompt`
  did not fire after 90 s idle at the prompt.
- **PermissionDenied did not fire** when the owner chose "No", and no
  PostToolUse followed either: nothing at all reports a refusal. The runner
  must clear `pending` on the next UserPromptSubmit and on the `interrupt`
  action, or a denied session stays stuck in waiting-permission.
- No hook reports a permission being _granted_, which is why every tool event
  clears `pending`.
- Stop fires after **each** assistant turn, not at exit, and its
  `last_assistant_message` carries the full final text.
  `stop_hook_active` is `false`.
- Escape mid-response emits nothing — no Stop, no PostToolUse. The
  `interrupt` action is the only thing that moves that session out of
  `working`.
- PostToolUseFailure was never emitted in the probe run; the row stays because
  it costs nothing, but no state may depend on it.

### 5.4 Actions

| Action                 | Effect                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| start                  | §5.5                                                                                                                                                                                                                                                                                                                                                                                      |
| resume                 | probes the CLI, then kills any tmux session with the record's id, regenerates the launcher with `--resume <claudeSessionId>`, same cwd; state → starting, and the replayed transcript's `SessionStart source: resume` then moves it to idle (§5.3). Refused when `claudeSessionId` is null, and the runner is asked before the record moves, so a refusal leaves the record where it was. |
| interrupt              | `tmux send-keys -t <id> Escape`                                                                                                                                                                                                                                                                                                                                                           |
| kill                   | `tmux kill-session -t <id>`; state → exited                                                                                                                                                                                                                                                                                                                                               |
| mark-done / unmark     | toggles `done`                                                                                                                                                                                                                                                                                                                                                                            |
| archive                | hides the record; refused while live                                                                                                                                                                                                                                                                                                                                                      |
| remove-worktree        | `git worktree remove <path>` (plus `--force` when the caller confirms a dirty tree); refused while any live session uses that cwd                                                                                                                                                                                                                                                         |
| send-to-review / clear | per-issue flag (§6)                                                                                                                                                                                                                                                                                                                                                                       |
| open-editor            | spawns `editor.command` with `editor.args` (`{{path}}` → the issue's worktree, or the repo for `shared`), detached, stdio ignored; refused when no worktree exists for the issue                                                                                                                                                                                                          |

### 5.5 Start sequence

1. Server validates: playbook exists, no live session for (issue, playbook),
   model/effort/permission values are in the allowed sets, and the prompt is a
   non-empty string (400 otherwise). The whole sequence holds the lock of the
   **base** session name — the name a first run of that playbook takes, which is
   what makes the liveness check safe — _and_ a per-(repo, issue) checkout lock,
   so two simultaneous starts cannot both pass the liveness check and a removal
   of the checkout cannot land in the middle of preparing it. A second run takes
   a suffixed id, whose own lock is held only around the launch.
2. `Repo.prepare(issue, playbook, hints)` resolves `cwd` and `branch`; the
   server passes `hints.knownBranch` from the newest non-archived record for
   that issue in that repo:
   Both non-shared isolations first attempt `git fetch <remote of baseRef>`; a
   failed fetch is recorded as staleness, never raised. A registered worktree
   whose HEAD is detached is refused rather than reused: there is no branch to
   work on and the owner has to repair it by hand.
   - `worktree`: if `<worktreeDir>/<KEY>` is
     already a registered worktree, reuse it (no bootstrap); else
     `git worktree add -b <branch> <path> <baseRef>` and mark `needsBootstrap`.
     If the branch already exists, `git worktree add <path> <branch>`.
   - `issue-worktree`: reuse `<worktreeDir>/<KEY>` if registered. Otherwise
     find the branch: the newest session record for the issue, else
     `git branch -r --list 'origin/<KEY>-*'`. Recreate the worktree from it
     (`needsBootstrap` true). No branch → start refused with a message that
     names what was searched.
   - `shared`: cwd = the repo's `path`, branch = null, no bootstrap.
3. Runner writes `<dataDir>/sessions/<id>/`: `prompt.txt`, `settings.json`
   (§8), `statusline.sh` (§9), `run.sh`, then
   `tmux new-session -d -s <id> -c <cwd> -x 220 -y 50 bash <dir>/run.sh` and
   `tmux set-option -t <id> window-size latest`.
4. `run.sh` (generated, bash):
   - When `needsBootstrap`: POST launcher `bootstrap-start`, run the bootstrap,
     and on a non-zero exit POST `bootstrap-failed` and `exec bash` (window
     stays open for inspection). A run with no bootstrap — a reused worktree, a
     resume — announces none and stays in `starting`.
   - POST `claude-start` with `{}` on a fresh start and `{"mode":"resume"}` on
     a resume, so the record's run list says which it was; `exec`-less call of
     `claude --settings <dir>/settings.json --name <KEY> [--model] [--effort] [--permission-mode | --dangerously-skip-permissions] "$(cat prompt.txt)"`
     (or `--resume <id>` instead of the prompt on resume).
   - POST `claude-exit` with the exit code; `exec bash`.
     The record is persisted before tmux is invoked so a crash between the two
     leaves a `starting` record the reconciler can mark failed.
5. Reconciler on server boot and every 10 s: for each live record whose
   `stateSince` is older than one interval — a younger one is still in the
   launcher's hands, and a resume kills and recreates the tmux session —
   `tmux has-session -t <id>`; missing → `exited`, or `failed` when the record
   has no run at all, which means the launcher never posted `claude-start`. A
   probe that throws is logged and the record is left alone; a pass that is
   already running is skipped rather than overlapped.

   The reconciler answers liveness and nothing else. A live record this server
   has never heard from — `lastEventAt`, falling back to `stateSince` for a
   record written before that field existed, older than the server's own start
   — survived a restart: the hooks that would have moved it were POSTed at a
   dead port and are gone, and nothing can recover them. Such a record gets
   `staleSince: <this server's start>` on the record and on `CardSession`,
   which says "this state may be out of date" rather than guessing at a better
   one. The state is never inferred from a transcript.

   The judgement is on `lastEventAt`, not on `stateSince`: a session that has
   been `working` since before the restart and is still posting hooks is being
   told about, and `stateSince` only moves when the state changes. Every
   lifecycle event the reducer accepts stamps `lastEventAt` and clears the
   marker, whether or not it changes anything else — a turn's worth of tool
   results that each reduce to the state the record is already in is still proof
   the session is alive. A status-line payload is not a lifecycle event, because
   it carries no state at all, and an event the reducer refuses outright stamps
   nothing. The reconciler also clears the marker when the same pass closes the
   record, whose state is then the most certain one available and which will
   receive no further event. An owner action that moves the record — Resume,
   Kill, Interrupt — stamps it too, so a session the owner has just relaunched
   is never badged as unverified.

## 6. Board projection (`core/projection.ts`)

Inputs: issues from the source, session records, per-issue flags
(`review`, `done`, `archived`). Output: five columns of cards.

Column for an issue, first match wins:

1. any live session in the needs-you set → **Needs you**
2. any live session in { bootstrapping, starting, working } → **Working**
3. flag `done` or issue.statusCategory === 'done' → **Done**
4. flag `review` or issue.status ∈ reviewStatuses → **Review**
5. otherwise → **Backlog**

Ordering inside a column: Needs you — waiting-permission and waiting-question
first, then idle, each by `stateSince` ascending (longest waiting on top);
Working — by `stateSince` ascending; Review/Done/Backlog — source order
(Jira rank).

Issue set: the source's list ∪ every issue that has a non-archived session
record in the workspace's repo (fetched individually when it dropped out of
the list, e.g. after moving to Done in Jira). Sessions belong to a repo and
an issue key: two workspaces over the same repo that both list an issue show
the same sessions.

Card payload: issue (key, summary, type, status, statusCategory, labels, url),
column, sessions (each: id, playbookId, state, stateSince, pending,
lastAssistantMessage, lastExitCode, staleSince, hint, cache, done, live,
needsYou, branch, attachCommand —
the attach command is per session, not per card), primary playbook for the
column (`primaryFor` match; falls back to the first playbook), and the worktree
path when known.

`hint` is the last `Notification`'s message (§5.3) and is decoration: it never
changes `state`, never sets `needsYou`, never moves a card between columns and
never raises a desktop notification. The column is chosen from session states
alone, exactly as above.

## 7. Prompts and playbooks

Template variables: `{{key}} {{summary}} {{type}} {{status}} {{labels}}
{{url}} {{description}} {{branch}} {{worktree}}`. Rendering is a literal
replace; unknown variables stay as written; `{{description}}` is plain text
(ADF walked to text, paragraphs joined with blank lines, lists as `- `).
`{{branch}}` renders "the branch resolved when the session starts" when there
is no branch yet — `shared` isolation, or `issue-worktree` before the checkout
exists — because a blank slot in "on branch {{branch}}" reads as naming a
branch with no name.

The start dialog shows: playbook selector, one editable textarea prefilled
with the rendered template (whole thing editable, per the owner), model,
effort and permission-mode selects prefilled from playbook defaults, then
runner defaults. The record stores the final text.

The two shipped playbooks are in `config.example.json`. The implement
template carries the "How to test" Jira-comment instruction in the body and a
one-line reminder at the end; the test template names the branch and the
worktree and tells the `test-issue` skill to verify there, not on main
(that skill accepts a named branch and skips its main search when given one).

## 8. Runner: claude in tmux, state through hooks

### 8.1 Hook injection

Per session the runner writes `settings.json` and passes it with
`--settings`. Command-line settings sit above project and user settings in
precedence, and hook arrays from all sources merge, so the owner's own hooks
keep running. The file adds:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "<post> SessionStart", "timeout": 5 }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "<post> UserPromptSubmit", "timeout": 5 }] }
    ],
    "PreToolUse": [
      { "hooks": [{ "type": "command", "command": "<post> PreToolUse", "timeout": 5 }] }
    ],
    "PostToolUse": [
      { "hooks": [{ "type": "command", "command": "<post> PostToolUse", "timeout": 5 }] }
    ],
    "PostToolUseFailure": [
      { "hooks": [{ "type": "command", "command": "<post> PostToolUseFailure", "timeout": 5 }] }
    ],
    "PermissionRequest": [
      { "hooks": [{ "type": "command", "command": "<post> PermissionRequest", "timeout": 5 }] }
    ],
    "PermissionDenied": [
      { "hooks": [{ "type": "command", "command": "<post> PermissionDenied", "timeout": 5 }] }
    ],
    "Notification": [
      {
        "matcher": "permission_prompt|elicitation_dialog",
        "hooks": [{ "type": "command", "command": "<post> Notification", "timeout": 5 }]
      }
    ],
    "Stop": [{ "hooks": [{ "type": "command", "command": "<post> Stop", "timeout": 5 }] }],
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "<post> SessionEnd", "timeout": 5 }] }
    ]
  },
  "statusLine": { "type": "command", "command": "bash <dir>/statusline.sh", "refreshInterval": 1 }
}
```

`<post>` is `curl -s -m 2 -X POST -H 'content-type: application/json' --data-binary @- http://127.0.0.1:<port>/api/hooks/<sessionId>/<event>`.
The session id is baked into the URL, so no environment variable has to
survive tmux, bash and the hook runner. Hooks exit 0 always; a dashboard
that is down must never block the session (`|| true`).

`--settings` merges by key with the other levels and sits above project and
user settings (https://code.claude.com/docs/en/settings). Measured on
2026-09-09 with Claude Code 2.1.266:

- Hook arrays concatenate across levels: the owner's user-level `rtk hook
claude` PreToolUse hook still rewrote `ls -la` into `rtk ls -la` while the
  probe's own PreToolUse hook logged the same call. Two `Notification`
  entries in one file both fire, so a matcher never suppresses a sibling.
- `tool_input` is **not** stable across a tool's events. PreToolUse sees the
  model's `ls -la`; PermissionRequest and PostToolUse see the rewritten
  `rtk ls -la`. Card summaries must say which event they came from rather
  than assume one command.
- A PermissionRequest hook that prints nothing and exits 0 leaves the normal
  dialog in place — confirmed, the hook only observes. PermissionRequest also
  carries `permission_suggestions`, the "don't ask again" options the dialog
  offers.
- Stop carries `last_assistant_message` in full — the snippet on the card is a
  truncation, not a fallback.
- `statusLine` is a scalar setting, so it is **replaced**, not merged: the
  probe's command ran and the owner's `~/.claude/statusline.sh` did not. That
  is why the generated `statusline.sh` has to re-invoke the owner's command
  itself (§9).

### 8.2 Hook ingress

`POST /api/hooks/:sessionId/:event` — body is the hook's stdin JSON. The
server looks the record up, runs the state machine, persists, broadcasts.
Unknown session ids get 404 and are logged. A body that is not a readable JSON
object — unparseable, an array, a scalar, or past the 1 MB cap — gets 400 and a
log line, because reducing it as `{}` would report a state change that never
happened. A hook name nothing subscribes to gets 204 and a log line. The
endpoint is unauthenticated and bound to loopback only.

The boundary is **typed by assertion, not by parse**: `asHookEvent` checks the
hook name against `HOOK_EVENT_NAMES` and then casts the body. This is
deliberate. The payload is Claude Code's, its shape moves between releases, and
every field the reducer reads is already narrowed at the point of use —
`typeof message === 'string'`, `hook.prompt_id ?? null`, `questionSummary`
walking an `unknown` `tool_input`. A schema here would add a second place to
keep in step with the CLI and would reject payloads the reducer copes with, in
exchange for no guarantee the use sites do not already give.

### 8.3 Terminal attach

`WS /ws/terminal/:sessionId?cols=<n>&rows=<n>`. On connect the server spawns
`node-pty` → `tmux attach-session -t <id>` at the size the query names; a value
that is not an integer between 1 and 1000 falls back to the server's default.
Binary frames carry pty bytes both ways; a JSON text frame
`{"type":"resize","cols":n,"rows":n}` resizes the pty, and any other text frame
is ignored. Close → pty kill (detaches that client only; tmux keeps running).
Several viewers can attach; `window-size latest` makes tmux follow the most
recent resize.

Two behaviours an operator needs: an unknown session id is refused with an
`{type:'error'}` frame and close 1008 rather than a silent empty terminal, and
pty output is **dropped** while more than 4 MB is queued on a viewer's socket.
A stalled viewer therefore loses output instead of back-pressuring the pty and
growing the server's heap; a terminal repaints itself, so what it loses is
scrollback.

Both WebSocket endpoints go through `@hono/node-server` 2's own
`upgradeWebSocket`, with a `ws` `WebSocketServer({ noServer: true })` passed
as `serve({ websocket: { server } })`. No other adapter.

`node-pty` needs its install script approved under npm 12
(`allowScripts` in package.json, already present).

## 9. Prompt-cache countdown

Same rule as the owner's statusline: Claude Code stamps
`prompt_cache.expires_at` (epoch seconds) into the status-line payload; the
time left is `expires_at - now`, capped at the TTL, full while a turn runs and
counting down once it ends; cold when `warm` is false or `expires_at` has
passed. A payload whose `ttl` label is one this app does not know counts down
uncapped and takes its colour bands from the 5m TTL: the stamped expiry is the
fact, the label only bounds it.

The runner's generated `statusline.sh` reads stdin once, POSTs it to
`/api/hooks/<id>/statusline` in the background (`-m 1`, output discarded), and
pipes the same payload into the owner's original statusline command when
`~/.claude/settings.json` has one, so the TUI keeps its own statusline. The
server keeps `cache = { expiresAt, ttlSeconds, warm, source: 'statusline' }`
from the payload and only broadcasts when `expiresAt`, `ttlSeconds` or `warm`
change.

Fallback when no statusline payload has arrived yet: on Stop, `cache =
{ expiresAt: now + ttlSeconds, warm: true, source: 'derived' }` with
`ttlSeconds` = 3600 when `ENABLE_PROMPT_CACHING_1H` is set in the owner's
`~/.claude/settings.json` `env`, else 300.

Card rendering: `⏳ m:ss`, dim → yellow at 15/60 of TTL → red at 5/60, `❄ cold`
after expiry. Ticks client-side every second from `expiresAt`; the server
does not push ticks.

## 10. Issue source: Jira

Jira Cloud REST v3 with basic auth (email + API token from the named env
vars). Endpoint `POST /rest/api/3/search/jql` with `fields:
summary,issuetype,status,labels,assignee,priority,description,updated`,
paginated on `nextPageToken`. Status category from
`status.statusCategory.key` (`new` → todo, `indeterminate` → inprogress,
`done` → done). Description ADF → plain text in the connector; a document that
is not shaped like ADF degrades to less text, never to a failed fetch, and a
resource with no usable `key` is dropped from the list and reported as "no such
issue" by `get`.

Limits, both user-visible: every request carries a 15 s abort (`JIRA_TIMEOUT_MS`),
reported as a `JiraHttpError` naming the site and the URL rather than as a bare
`TimeoutError`; and a search walks at most 50 pages of 100
(`JIRA_MAX_PAGES` × `JIRA_PAGE_SIZE`). A query with pages left after the cap
fails rather than presenting a partial epic as the whole one, and because
repeating it changes nothing it is raised as a **permanent** source error.

Polling: every `pollSeconds`, plus `POST /api/workspaces/:id/refresh`, plus once
whenever a session leaves the live set. On failure the last good list is
served with `sourceError` set on the board payload; the UI shows a banner. A
caller that arrives while a fetch is already in flight joins it only when that
fetch was issued after the caller's own request; otherwise it awaits it and
then runs its own, so a refresh never answers with a list read before the
change it was clicked for.

A permanent source error — one carrying `permanent: true`, which
`isPermanentSourceError` in `core/types.ts` recognises — suspends that
workspace's poll timer instead. Only the owner lifts the suspension:
`POST /api/workspaces/:id/refresh` and the first refresh of a newly added
workspace. A session leaving the live set still refetches, but never lifts it;
neither does a board request. The suspension belongs to the issue-source
interface, so the server never names a connector's own error classes.

Interface:

```ts
interface IssueSource {
  readonly id: string;
  list(): Promise<Issue[]>;
  get(key: string): Promise<Issue | null>;
}
```

A source raises `PermanentSourceError` (`core/types.ts`) for a query that
repeating cannot fix and an ordinary `Error` for everything else.

## 11. Server API (`core/api.ts` is the contract)

REST (JSON):

```
GET  /api/config/public                → { workspaces: [{id,name,epic,repo,connector}], repos: [{id,path}], connectors: [{id,site}], runner: {models, defaults, efforts, permissionModes} }
POST /api/workspaces                   { id?, name, epic, repo, connector | newConnector: {id, site, emailEnv, tokenEnv}, reviewStatuses?, jql? } → 201 workspace summary; 400 with zod issues, 409 on duplicate id
DELETE /api/workspaces/:id             → 204; 404 for an unknown id. Sessions and worktrees are untouched
                                         (they belong to the repo). Exactly one other thing goes with it: the
                                         connector this workspace named, and only when no remaining workspace
                                         names it — nothing else can remove a connector, so an inline one
                                         created from the dialog would otherwise be permanent. A connector no
                                         workspace ever named is left alone.
GET  /api/workspaces/:id/board         → BoardView { workspaceId, playbooks[], columns[], sourceError, fetchedAt, needsYouCount }
POST /api/workspaces/:id/refresh       → BoardView
GET  /api/workspaces/:id/issues/:key   → IssueDetail { issue (with description), sessions[], worktreePath, flags }
GET  /api/workspaces/:id/issues/:key/prefill?playbook=  → { prompt, model, effort, permissionMode, isolation, warnings[] }; `playbook` is required, 400 without it
POST /api/workspaces/:id/issues/:key/sessions           { playbookId, prompt, model, effort, permissionMode } → 201 SessionRecord
POST /api/workspaces/:id/issues/:key/flags              { review?: boolean, done?: boolean } → IssueFlags
POST /api/workspaces/:id/issues/:key/open-editor        → 204, or 409 when the issue has no worktree
POST /api/sessions/:id/resume | interrupt | kill | mark-done | unmark-done | archive
POST /api/sessions/:id/remove-worktree { force?: boolean } → { path }
GET  /api/sessions/:id/events          → { events[] }; 404 for an unknown session id, 409 when a log
                                         exists but cannot be read. It backs the "Why it failed" /
                                         "Why it ended" panel, so the UI distinguishes "the log named
                                         no reason" from "the log could not be read" — the second is
                                         the owner's problem to fix and the first is not.
POST /api/hooks/:sessionId/:event            → 204 (hook ingress, loopback only)
POST /api/hooks/:sessionId/statusline        → 204 (status-line ingress)
POST /api/hooks/:sessionId/launcher/:event   → 204 (launcher ingress, §5.5)
```

The three ingress routes answer 404 for an unknown session id (§8.2) and 400
for a body that is not a readable JSON object — which includes one past the
1 MB cap, so an oversized payload is answered 400 rather than 413.

WebSocket:

```
WS /ws/events     server → client: { type: 'board', workspaceId, view }   (debounced 250 ms)
                                    { type: 'config', config: PublicConfigResponse }  after a workspace is added or removed
                                    { type: 'session', record }
WS /ws/terminal/:sessionId?cols=&rows=   see §8.3
```

Errors: JSON
`{ error: string, detail?: string, issues?: [{path, message}], reason?: ErrorReason }`
with 4xx for refusals (no live session, no branch found, dirty worktree, an
issue the tracker would not hand over) so the UI can place them against fields
without parsing prose. `issues` carries the zod problems of a rejected
workspace request, each `path` request-relative — `epic`, `newConnector.site`,
`reviewStatuses[0]` — so a dialog can put a problem next to the input that
caused it. `reason` is
the closed set `dirty-worktree | session-live | main-checkout | duplicate-id |
no-branch | missing-executable | detached-worktree`; it is the only thing a UI
may branch on, so `error` and `detail` stay free text. A refusal none of those
names describes carries no `reason`. Every member is reachable: `session-live`
on a start that clashes with a live session and on a removal blocked by one,
`missing-executable` when the runner cannot find the CLI on a start or a
resume, `no-branch` / `detached-worktree` / `dirty-worktree` / `main-checkout`
from the checkout, `duplicate-id` from a workspace request.

## 12. Web UI

Vite + React 19, plain CSS with custom properties (no utility framework),
`@xterm/xterm` with its fit and web-links addons. Two routes handled by a tiny
hash-free history switch: `/` board, `/session/:id` terminal.

In dev the SPA is served by Vite on 5173, which proxies `/api` and `/ws` to the
server on 4400; 4400 answers **503** with the "not built" message on every
non-`/api`, non-`/ws` GET rather than serving the source `index.html` — the
bundle a browser asks for is as unserved as the shell, and a 404 there explains
nothing. After `npm run build` the SPA is served from 4400 and
Vite is not running. `VITE_MOCK=1 npm run dev:web` installs the hand-written
fixtures in `src/web/src/dev-mock.ts` in place of every request and socket, so
the UI runs with no server, no Jira and no tmux. The mock certifies nothing —
it is not derived from the server and can disagree with it in either
direction — and it is tree-shaken out of a production build.

Aesthetic direction (owner's pick): **dark, editorial instrument panel** —
proper UI typeface with a mono companion for keys and timers, generous
spacing, subtle surface elevation, status expressed through small indicators
rather than coloured cards. The `frontend-design` skill governs the details;
the implementer commits to one direction and records it in
`docs/design-notes.md`.

Board:

- Header, in this order: wordmark, needs-you badge, synced-ago,
  stream-offline indicator, rule, refresh, notifications. The workspace
  switcher is a dropdown of epics (workspace name, with the epic key and repo
  as secondary text), always shown, active one remembered in localStorage; a
  workspace the session route resolves is shown without being remembered, and
  the remembered one comes back when that route is left. Its last two entries
  are "Add workspace…" and then "Remove this workspace" (confirm; nothing but
  the workspace and its own connector goes).
  The needs-you badge also goes into `document.title` and the favicon.
- Five columns, each scrollable, counts in the heading; the lane strip is one
  tab stop.
- Card: type glyph then key (mono) — glyph first, everywhere — summary (two
  lines max), Jira status chip, labels (max 3 + "+n"), then one row per
  non-archived session: playbook, state, `time in state`, a done marker, an
  unverified-since-restart marker, a may-need-you marker, and the cache gauge.
  The state reads
  `failed, exit N` and `exited, code N` for a non-zero code, with the tmux
  hint in its `title`. The unverified and may-need-you markers are lamp-style
  dots whose whole sentence lives in their `aria-label` and `title`; the
  may-need-you marker renders `CardSession.hint` (§5.3) and never changes the
  state word, the lamp or the lane. On a narrow track the cache
  gauge moves to a second line. Primary action button for the column's
  playbook, which reads "Open <label> session" and navigates instead of
  starting when a live session for that playbook already exists; an "Open in
  VS Code" icon button whenever the issue has a worktree; overflow menu with
  the other playbooks, Send to review / Clear review, Mark done / Unmark
  done, Open in Jira.
- Clicking the card body opens the issue drawer: description, all sessions
  with actions, worktree path, Open in VS Code, tmux attach command (copy
  button), Remove worktree and Archive. The may-need-you marker is the card
  row's and the session header's; the drawer does not render it.
- Add workspace dialog (from the switcher): name, epic key, repo (select
  from config), connector (select from config, or "new" revealing id, site,
  email env var, token env var), review statuses (comma-separated, default
  "Ready for review"). Submit → `POST /api/workspaces`; zod issues shown next
  to the fields; on 201 the switcher selects the new workspace.

Session view:

- Terminal fills ~75 %; header, in this order: Back, key, playbook, state
  pill (carrying the ended-state label), the unverified marker and the
  may-need-you marker as its siblings, branch,
  cache countdown, then Interrupt · Kill · Resume. Resume appears for any
  non-live state, `failed` included, and is disabled while the record has no
  Claude session id or the issue detail has not loaded yet.
- Right panel: issue summary/description, status chip, labels, Jira link,
  worktree path, Open in VS Code, `tmux attach -t <id>` copy, a "Why it
  failed" / "Why it ended" section — the reason the events route exists (§11)
  — and inside it the shell hint that goes with the attach command, then
  Remove worktree.
- Remove worktree has no confirmation dialog: a refusal carrying
  `reason: 'dirty-worktree'` relabels the button to say it will force, and
  the second click executes. The message text is never parsed.
- When the session needs you the header shows the pending summary; the pill
  itself does not pulse, only the lamp animates.

Keyboard: every dialog traps focus and restores it to the element that opened
it, by ancestry when that element has gone; menus move on arrow keys with Home
and End; the lane strip is one tab stop; the start and add-workspace dialogs
guard a discard; Escape closes an open menu before it closes the dialog under
it.

Notifications: `Notification` API, permission requested once from a button in
the header; one notification per transition into the needs-you set, titled
`<KEY> · <state>`, body = `CardSession.pending?.summary` or, for an idle
session (which by definition has none), `CardSession.lastAssistantMessage`.

## 13. Persistence

`<dataDir>/`:

```
sessions.json           SessionRecord[] (write-through, atomic rename)
flags.json              { [workspaceId]: { [issueKey]: { review?, done? } } }
worktrees.json          { [repoId]: { [issueKey]: { path, branch } } }
                        worktrees only; a `shared` session's main checkout is not one
sessions/<id>/          prompt.txt settings.json statusline.sh run.sh events.jsonl
                        bootstrap.log when the repo has a bootstrap command
```

Two things this layer discards on purpose, both worth knowing before hand-editing
a file:

- **The event log is capped, not raw.** Every string inside a payload is
  truncated past `EVENT_STRING_MAX_LENGTH` (4096) and every array or object is
  cut to `EVENT_MEMBERS_MAX` (200) members, each with a marker saying how much
  went. A `PostToolUse` carries the whole tool response, so without both caps
  one session that reads a few hundred large files writes a log no reader can
  hold. `GET /api/sessions/:id/events` therefore serves an edited transcript.
- **A document the store cannot use is set aside, never silently replaced.**
  `sessions.json`, `flags.json` and `worktrees.json` are checked on load; one
  that is unparseable or the wrong shape is renamed to `<name>.rejected`,
  reported, and treated as empty, because the next write renames a fresh
  document over that path. A **missing** document is simply empty and nothing
  is renamed. An existing `<name>.rejected` is never overwritten: a second
  rejection is kept under a timestamped name, so the copy of the owner's
  original file survives their second attempt at fixing it.
- **A `sessions.json` whose members are not all usable is set aside too.** It
  keeps the members that carry an `id`, `issueKey`, `repoId`, `stateSince` and
  a `state` the state machine has, drops the rest, and names the dropped ids in
  the warning: one bad member must not cost the others, an unchecked one
  reaches the projection, and the drop is irreversible unless the whole
  document is kept.
- **Temporary files are swept on load.** `writeJsonAtomic` removes its own
  temporary file when a rename fails, but a process killed between the write
  and the rename cannot; `Store.load` deletes any `*.tmp` sibling, because
  nothing else ever cleans `dataDir`.

An atomic write means a reader always sees one whole document, the old one or
the new one. It is not durability: nothing is fsynced.

## 14. Error handling

- Config invalid → process exits 1 with the zod issues; nothing else starts.
- Jira unreachable → stale board + banner; start still allowed with a
  `warnings[]` entry in prefill ("issue text may be stale").
- tmux missing / claude missing → start refused with a 409 carrying the
  command that failed as `detail` and `reason: 'missing-executable'`; the UI
  shows the server's `error`, `detail` and `reason`, and never rebuilds the
  sentence itself.
- Worktree add fails (dirty base, branch exists elsewhere) → start refused
  with git's stderr.
- A `git fetch` that hangs → killed at `GIT_NETWORK_TIMEOUT_MS` and recorded
  as staleness, so the checkout lock is never held on a remote that never
  answers.
- Hook arrives for an unknown session → 404, logged.
- PTY spawn fails → WS closes with a reason frame; the SPA writes the reason
  into the xterm buffer as a red line and shows "Detached from the terminal.";
  the buffer is discarded on the next reconnect.
- Bootstrap exits non-zero → `failed`, and the tail of the bootstrap's own
  output is posted as `message` on the `bootstrap-failed` signal, which
  survives in the event log; the failed shell stays open in tmux. The exit code
  reaches the record and `CardSession.lastExitCode` only while the record is
  still `bootstrapping`: a signal that arrives after the reconciler has already
  closed the record is refused, so its code lives in the log alone.
- The listening socket cannot be opened, for any reason → the cause is logged
  and the process exits 1. Without a socket it serves nothing, and the signal
  handlers keep the event loop alive, so it must not stay up.
- Boot fails before the socket is listening — an unwritable `dataDir`, a
  connector that cannot be built → the cause is logged and the process exits 1.
- An unhandled _rejection_ is logged and swallowed: it usually arrives outside
  the request that caused it, and losing every session's state tracking is
  worse than one lost stack trace. An uncaught _exception_ is logged and the
  process exits 1 — it may be mid-invariant, and the reconciler picks the live
  records up on the next boot.

What the SPA degrades to rather than failing:

- The event stream dropping → a stream-offline indicator in the header; the
  board keeps showing what it last had.
- A session route whose record is unknown → "session not found", which is a
  different message from "could not load".
- A terminal that keeps failing to attach → retries up to a cap, then stops
  and says so.
- The lazily-loaded Terminal chunk failing → the attach command, so the owner
  can reach the session from a shell.
- `GET /api/sessions/:id/events` failing → "the log could not be read", never
  "the session ended for no reason".
- A render that throws → an error boundary that resets on navigation and
  offers Try again, rather than a dead page until a manual reload.

## 15. Testing

Vitest. `test/core`, `test/connectors`, `test/server` and `test/web` mirror
`src/`. Every module whose behaviour a caller depends on gets a suite next to
it, and a new one arrives with its suite; a module that is only a factory over
another module's behaviour — `server/connectors.ts` — is covered through the
suites of what it builds, which is stated here so the absence is a decision
rather than a gap.

Any test file that imports `src/server/main.js` must hoist a `QC_CONFIG`
pointing at a path that cannot exist, before the import. The entry gate is what
stops a boot; the guard is what stops a broken gate from reaching the owner's
real configuration, data directory and port. `test/server/main.test.ts` sets it
and asserts it.

**No tmux, no tracker and no listening socket.** Three things a test may still
really do, because a seam there would test the seam rather than the behaviour:

- `test/connectors/git-repo.test.ts` builds a real repository, a real bare
  `origin` and real worktrees under a temporary directory and drives `GitRepo`
  against them. Reuse, detached HEAD, dirty-tree refusal, fetch-before-reuse
  and branch resolution by commit date are facts about git. Its unreachable
  remotes are a local path that does not exist and an `ext::sleep` transport,
  so nothing opens a socket, and the fetch deadline is measured rather than
  asserted from an option.
- `test/connectors/session-files.test.ts` runs the generated launcher under
  `bash` with stub `curl` and `claude` executables on `PATH`, which is the only
  way to prove the bootstrap-failure body it posts is JSON a server can parse.
  Both stubs are mandatory: without the second the launcher's own command line
  resolves whatever `claude` is installed, which § Tests forbids.
- `test/server/session-manager.test.ts` spawns a real child process for the
  editor launcher, whose failure arrives as an asynchronous `error` event and
  nowhere else.

What every suite must cover is the behaviour its module promises, and the
yardstick for "covered" is mutation: a test that survives the deletion of the
line it exists for is theatre. Suites that carry a claim worth naming here:

- `state-machine`: a table of (state, event) → (state, pending, extras);
  "unknown event leaves state untouched"; "SessionEnd from anywhere"; the
  notification rule — the state never moves, the hint sets and clears —
  replayed against `test/fixtures/hook-events.jsonl` whole and with the
  `PermissionRequest` of its second dialog dropped.
- `config`: example config validates; missing env name, bad effort, unknown
  workspace reference, duplicate playbook ids fail with a locator; the
  connector cascade takes the removed workspace's own connector and nothing
  else.
- `server/session-manager`: the locks, observed by holding one side open and
  asserting the other has not proceeded; the poll suspension in all three
  directions; the staleness marker.
- `server/store`: the atomic write, asserted by reading the document
  throughout a run of writes rather than by its inode; the rejection path,
  including a second rejection and a dropped member.
- `server/main`: importing the module performs no listen, and the `QC_CONFIG`
  guard is set. `server/util`: `isProcessEntry` answers false for a path that
  is not the module and true through a symlink, which is the case the realpath
  pair exists for.

Manual verification (plan task, integration): start an implement session on a
real DOC-3807 child, watch bootstrapping → starting → working → idle, answer
a permission prompt from the browser, kill, resume, remove the worktree.

## 16. Extending

`docs/connectors.md` documents: adding an issue source (implement
`IssueSource`, register its `type` in `connectors/issues/index.ts`, add the
zod variant), adding a workspace (UI or config), adding a repo (config
only), adding a playbook (config
only), adding a runner (implement `Runner`, register).
