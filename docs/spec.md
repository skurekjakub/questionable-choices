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

| Term          | Meaning                                                                                                                            |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Board         | The dashboard view of one workspace: its issue source projected onto columns. A board's id is its workspace's id.                  |
| Issue source  | Connector that lists issues for a board (Jira epic today).                                                                         |
| Workspace     | A git repository plus its worktree policy, bootstrap command and playbooks.                                                        |
| Runner        | Connector that launches, attaches, interrupts and kills sessions (`claude` in tmux today).                                         |
| Playbook      | Named kickoff recipe on a workspace: prompt template, isolation mode, defaults, which board columns show it as the primary action. |
| Session       | One tmux session running one `claude` process for one issue and one playbook. Has a persistent record.                             |
| Session state | Where the session is in its lifecycle — see §5.                                                                                    |
| Column        | Board lane derived from session state and issue status — see §6.                                                                   |

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
    api.ts              wire types shared with src/web (REST + WS payloads)
  connectors/
    issues/jira/        IssueSource over Jira Cloud REST v3
    workspaces/git/     Workspace over git worktrees (worktree | issue-worktree | shared)
    runners/claude-tmux/Runner: tmux + claude + generated hook settings + node-pty attach
  server/
    main.ts             boot: load config, build connectors, start Hono + WS
    app.ts              routes
    session-manager.ts  orchestration, persistence, event fan-out
    store.ts            JSON persistence under dataDir
    hooks.ts            hook ingress → state machine → broadcast
    terminal-ws.ts      WS ↔ node-pty bridge
  web/                  Vite + React SPA (vite.config.ts, index.html, src/)
test/                   vitest, mirrors src/core and pure parts of connectors
docs/                   spec.md, plan.md, connectors.md
config.example.json     the owner's real shape, minus secrets
```

Dependency direction: `web → core/api.ts` only; `server → core, connectors`;
`connectors → core`. `core` imports nothing from the other three.

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
  tmuxPrefix               default 'qc' → tmux session names qc-<KEY>-<playbook>
  models[]                 {id,label} shown in the picker
  defaultModel / defaultEffort / defaultPermissionMode
workspaces{id}
  name                     shown in the workspace switcher
  issues                   the workspace's issue source (one epic per workspace)
    type                   'jira'
    site, emailEnv, tokenEnv
    epic                   parent key; default JQL is
                           parent = <epic> AND statusCategory != Done ORDER BY Rank ASC
    jql?                   raw override of the whole query
    reviewStatuses[]       Jira status names that land in the Review column
    pollSeconds            default 120
  repo                     absolute path of the main checkout
  worktreeDir              where worktrees go; worktree path = <worktreeDir>/<KEY>
  baseRef                  'origin/main'; fetched before every worktree add
  branchPattern            '{{key}}-{{slug}}'
  bootstrap                shell string run in the tmux session after a NEW worktree
  playbooks[]
    id, label, description
    isolation              'worktree' | 'issue-worktree' | 'shared'
    primaryFor[]           column ids where this playbook is the card's primary action
    defaults?              {model?, effort?, permissionMode?}
    promptTemplate         see §7
```

Valid `effort`: low, medium, high, xhigh, max. Valid `permissionMode`:
acceptEdits, auto, bypassPermissions, manual, dontAsk, plan, plus `default`
meaning "pass no flag". These are the values `claude --help` 2.1.266 lists;
the picker offers exactly these.

## 5. Session lifecycle and state machine

### 5.1 Record

```ts
interface SessionRecord {
  id: string; // tmux session name, e.g. qc-DOC-3847-implement
  issueKey: string;
  playbookId: string;
  workspaceId: string;
  cwd: string;
  branch: string | null; // null for isolation 'shared'
  model: string;
  effort: Effort;
  permissionMode: PermissionMode | 'default';
  prompt: string; // exactly what was sent
  claudeSessionId: string | null; // from the SessionStart hook
  state: SessionState;
  stateSince: string; // ISO
  pending: { kind: 'permission' | 'question'; summary: string } | null;
  lastAssistantMessage: string | null; // snippet, from Stop hook when present
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

| Event                                           | From                                    | To                 | Side data                                                                   |
| ----------------------------------------------- | --------------------------------------- | ------------------ | --------------------------------------------------------------------------- |
| launcher `bootstrap-start`                      | any                                     | bootstrapping      |                                                                             |
| launcher `bootstrap-failed`                     | bootstrapping                           | failed             |                                                                             |
| launcher `claude-start`                         | bootstrapping, starting, exited, failed | starting           | new run appended                                                            |
| hook SessionStart                               | starting                                | starting           | record `claudeSessionId`                                                    |
| hook UserPromptSubmit                           | any live                                | working            | clear pending                                                               |
| hook PreToolUse (tool ≠ AskUserQuestion)        | any live                                | working            | clear pending                                                               |
| hook PreToolUse (AskUserQuestion)               | any live                                | waiting-question   | pending.summary = question text from tool_input                             |
| hook PostToolUse / PostToolUseFailure (any)     | any live                                | working            | clear pending                                                               |
| hook PermissionRequest (tool ≠ AskUserQuestion) | any live                                | waiting-permission | pending.summary = `<tool_name>: <one-line tool_input digest>`               |
| hook PermissionRequest (AskUserQuestion)        | any live                                | waiting-question   | pending.summary = question text; must not demote the PreToolUse verdict     |
| hook Notification (permission_prompt)           | any live                                | waiting-permission | pending.summary = notification message, only when no pending is set         |
| hook Notification (elicitation_dialog)          | any live                                | waiting-question   | pending.summary = notification message                                      |
| hook PermissionDenied                           | any live                                | working            | clear pending                                                               |
| hook Stop                                       | any live                                | idle               | lastAssistantMessage when the payload carries it; cache.derived = now + ttl |
| action interrupt                                | working, waiting-*                      | idle               | the runner sent Escape; no hook reports an interrupt                        |
| hook SessionEnd                                 | any                                     | exited             | endedAt                                                                     |
| launcher `claude-exit`                          | any                                     | exited             | exit code on the last run                                                   |
| statusline payload                              | any                                     | unchanged          | cache from `prompt_cache` (§9)                                              |

Unknown events are ignored and logged. Every accepted event is appended to
`<dataDir>/sessions/<id>/events.jsonl` (raw payload + resulting state).

Hook facts the design relies on, measured on 2026-09-09 against Claude Code
2.1.266 with the §8.1 settings file and kept as
`test/fixtures/hook-events.jsonl`:

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

| Action                 | Effect                                                                                                                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| start                  | §5.5                                                                                                                                                                             |
| resume                 | kills any tmux session with the record's id, regenerates the launcher with `--resume <claudeSessionId>`, same cwd; state → starting. Refused when `claudeSessionId` is null.     |
| interrupt              | `tmux send-keys -t <id> Escape`                                                                                                                                                  |
| kill                   | `tmux kill-session -t <id>`; state → exited                                                                                                                                      |
| mark-done / unmark     | toggles `done`                                                                                                                                                                   |
| archive                | hides the record; refused while live                                                                                                                                             |
| remove-worktree        | `git worktree remove <path>` (plus `--force` when the caller confirms a dirty tree); refused while any live session uses that cwd                                                |
| send-to-review / clear | per-issue flag (§6)                                                                                                                                                              |
| open-editor            | spawns `editor.command` with `editor.args` (`{{path}}` → the issue's worktree, or the repo for `shared`), detached, stdio ignored; refused when no worktree exists for the issue |

### 5.5 Start sequence

1. Server validates: playbook exists, no live session for (issue, playbook),
   model/effort/permission values are in the allowed sets.
2. Workspace `prepare(issue, playbook)` resolves `cwd` and `branch`:
   - `worktree`: `git fetch <remote of baseRef>`; if `<worktreeDir>/<KEY>` is
     already a registered worktree, reuse it (no bootstrap); else
     `git worktree add -b <branch> <path> <baseRef>` and mark `needsBootstrap`.
     If the branch already exists, `git worktree add <path> <branch>`.
   - `issue-worktree`: reuse `<worktreeDir>/<KEY>` if registered. Otherwise
     find the branch: the newest session record for the issue, else
     `git branch -r --list 'origin/<KEY>-*'`. Recreate the worktree from it
     (`needsBootstrap` true). No branch → start refused with a message that
     names what was searched.
   - `shared`: cwd = `repo`, branch = null, no bootstrap.
3. Runner writes `<dataDir>/sessions/<id>/`: `prompt.txt`, `settings.json`
   (§8), `statusline.sh` (§9), `run.sh`, then
   `tmux new-session -d -s <id> -c <cwd> -x 220 -y 50 bash <dir>/run.sh` and
   `tmux set-option -t <id> window-size latest`.
4. `run.sh` (generated, bash):
   - POST launcher `bootstrap-start`; run bootstrap when `needsBootstrap`;
     on non-zero exit POST `bootstrap-failed` and `exec bash` (window stays
     open for inspection).
   - POST `claude-start`; `exec`-less call of
     `claude --settings <dir>/settings.json --name <KEY> [--model] [--effort] [--permission-mode] "$(cat prompt.txt)"`
     (or `--resume <id>` instead of the prompt on resume).
   - POST `claude-exit` with the exit code; `exec bash`.
     The record is persisted before tmux is invoked so a crash between the two
     leaves a `starting` record the reconciler can mark failed.
5. Reconciler on server boot and every 10 s: for each live record,
   `tmux has-session -t <id>`; missing → `exited` (or `failed` if it never
   reached `starting`).

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
record (fetched individually when it dropped out of the list, e.g. after
moving to Done in Jira).

Card payload: issue (key, summary, type, status, statusCategory, labels, url),
column, sessions (each: id, playbookId, state, stateSince, pending,
cache, done), primary playbook for the column (`primaryFor` match; falls back
to the first playbook), the tmux attach command, and the worktree path when
known.

## 7. Prompts and playbooks

Template variables: `{{key}} {{summary}} {{type}} {{status}} {{labels}}
{{url}} {{description}} {{branch}} {{worktree}}`. Rendering is a literal
replace; unknown variables stay as written; `{{description}}` is plain text
(ADF walked to text, paragraphs joined with blank lines, lists as `- `).

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
Unknown session ids get 404 and are logged; nothing else. The endpoint is
unauthenticated and bound to loopback only.

### 8.3 Terminal attach

`WS /ws/terminal/:sessionId`. On connect the server spawns
`node-pty` → `tmux attach-session -t <id>` with the client's cols/rows.
Binary frames carry pty bytes both ways; a JSON text frame
`{"type":"resize","cols":n,"rows":n}` resizes the pty. Close → pty kill
(detaches that client only; tmux keeps running). Several viewers can attach;
`window-size latest` makes tmux follow the most recent resize.

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
passed.

The runner's generated `statusline.sh` reads stdin once, POSTs it to
`/api/hooks/<id>/statusline` in the background (`-m 1`, output discarded), and
pipes the same payload into the owner's original statusline command when
`~/.claude/settings.json` has one, so the TUI keeps its own statusline. The
server keeps `cache = { expiresAt, ttlSeconds, warm, source: 'statusline' }`
from the payload and only broadcasts when `expiresAt`/`warm` change.

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
`done` → done). Description ADF → plain text in the connector.

Polling: every `pollSeconds`, plus `POST /api/workspaces/:id/refresh`, plus once
whenever a session leaves the live set. On failure the last good list is
served with `sourceError` set on the board payload; the UI shows a banner.

Interface:

```ts
interface IssueSource {
  readonly id: string;
  list(): Promise<Issue[]>;
  get(key: string): Promise<Issue | null>;
}
```

## 11. Server API (`core/api.ts` is the contract)

REST (JSON):

```
GET  /api/config/public                → { workspaces: [{id,name}], runner: {models, defaults, efforts, permissionModes} }
GET  /api/workspaces/:id/board         → BoardView { workspaceId, columns[], sourceError, fetchedAt }
POST /api/workspaces/:id/refresh       → BoardView
GET  /api/workspaces/:id/issues/:key   → IssueDetail { issue (with description), sessions[], worktree }
GET  /api/workspaces/:id/issues/:key/prefill?playbook=  → { prompt, model, effort, permissionMode, isolation, warnings[] }
POST /api/workspaces/:id/issues/:key/sessions           { playbookId, prompt, model, effort, permissionMode } → SessionRecord
POST /api/workspaces/:id/issues/:key/flags              { review?: boolean, done?: boolean } → IssueFlags
POST /api/workspaces/:id/issues/:key/open-editor        → 204, or 409 when the issue has no worktree
POST /api/sessions/:id/resume | interrupt | kill | mark-done | unmark-done | archive
POST /api/sessions/:id/remove-worktree { force?: boolean }
GET  /api/sessions/:id/events          → raw event log (debug)
POST /api/hooks/:sessionId/:event      → 204 (hook ingress, loopback only)
```

WebSocket:

```
WS /ws/events     server → client: { type: 'board', workspaceId, view }   (debounced 250 ms)
                                    { type: 'session', record }
WS /ws/terminal/:sessionId           see §8.3
```

Errors: JSON `{ error: string, detail?: string }` with 4xx for refusals
(no live session, no branch found, dirty worktree) so the UI can show them
verbatim.

## 12. Web UI

Vite + React 19, plain CSS with custom properties (no utility framework),
`@xterm/xterm` + fit addon. Two routes handled by a tiny hash-free history
switch: `/` board, `/session/:id` terminal.

Aesthetic direction (owner's pick): **dark, editorial instrument panel** —
proper UI typeface with a mono companion for keys and timers, generous
spacing, subtle surface elevation, status expressed through small indicators
rather than coloured cards. The `frontend-design` skill governs the details;
the implementer commits to one direction and records it in
`docs/design-notes.md`.

Board:

- Header: workspace switcher (always shown; the active one is remembered in
  localStorage), synced-ago, refresh, count of
  needs-you as a badge that also goes into `document.title` and the favicon.
- Five columns, each scrollable, counts in the heading.
- Card: key (mono) + type glyph, summary (two lines max), Jira status chip,
  labels (max 3 + "+n"), then one row per live/latest session: playbook,
  state indicator, `time in state`, cache countdown. Primary action button
  for the column's playbook; an "Open in VS Code" icon button whenever the
  issue has a worktree; overflow menu with the other playbooks,
  Send to review / Clear, Mark done, Open in Jira.
- Clicking the card body opens the issue drawer: description, all sessions
  with actions, worktree path, Open in VS Code, tmux attach command (copy
  button).

Session view:

- Terminal fills ~75 %; header with key, playbook, state pill, branch,
  cache countdown; buttons Interrupt · Kill · Resume (when exited) · Back.
- Right panel: issue summary/description, status chip, labels, Jira link,
  worktree path, Open in VS Code, `tmux attach -t <id>` copy, Remove
  worktree (with force confirm when refused as dirty).
- When the session needs you the header pill pulses and shows the pending
  summary.

Notifications: `Notification` API, permission requested once from a button in
the header; one notification per transition into the needs-you set, titled
`<KEY> · <state>`, body = pending summary or last assistant snippet.

## 13. Persistence

`<dataDir>/`:

```
sessions.json           SessionRecord[] (write-through, atomic rename)
flags.json              { [workspaceId]: { [issueKey]: { review?, done? } } }
worktrees.json          { [workspaceId]: { [issueKey]: { path, branch, bootstrapped } } }
sessions/<id>/          prompt.txt settings.json statusline.sh run.sh events.jsonl
```

## 14. Error handling

- Config invalid → process exits 1 with the zod issues; nothing else starts.
- Jira unreachable → stale board + banner; start still allowed with a
  `warnings[]` entry in prefill ("issue text may be stale").
- tmux missing / claude missing → start refused with the exact command that
  failed.
- Worktree add fails (dirty base, branch exists elsewhere) → start refused
  with git's stderr.
- Hook arrives for an unknown session → 404, logged.
- PTY spawn fails → WS closes with a reason frame; the UI shows it.

## 15. Testing

Vitest, unit only, no tmux and no network:

- `state-machine`: a table of (state, event) → (state, pending, extras),
  including "unknown event leaves state untouched" and "SessionEnd from
  anywhere".
- `config`: example config validates; missing env name, bad effort, unknown
  workspace reference, duplicate playbook ids fail with a locator.
- `prompt`: rendering, unknown variable untouched, slug rules
  (lowercase, `[a-z0-9]+` runs joined by `-`, max 60 chars).
- `projection`: column precedence table, ordering, union with session-only
  issues.
- `cache-clock`: statusline payload → cache, derived fallback, cold rules.
- `jira/map`: fixture JSON → Issue, ADF → text.
- `git/branch-lookup`: parsing of `git branch -r` output.

Manual verification (plan task, integration): start an implement session on a
real DOC-3807 child, watch bootstrapping → starting → working → idle, answer
a permission prompt from the browser, kill, resume, remove the worktree.

## 16. Extending

`docs/connectors.md` documents: adding an issue source (implement
`IssueSource`, register its `type` in `connectors/issues/index.ts`, add the
zod variant), adding a workspace (config only), adding a playbook (config
only), adding a runner (implement `Runner`, register).
