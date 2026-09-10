# Extending questionable-choices

Five things you can add. Two are configuration, three are code. The
configuration file is `~/.config/questionable-choices/config.json`
(`QC_CONFIG=/path` overrides it); `config.example.json` in the repo is the
same shape with the owner's real values. After every hand edit:

```bash
npm run config:check
```

It loads the file the server would load and prints what it names, or the zod
issues with their JSON path.

The three maps are independent on purpose. A **connector** is a tracker
account, a **repo** is a checkout with its playbooks, and a **workspace** is
one epic that points at one of each. Two workspaces over the same repo share
its sessions and its worktrees; two workspaces over the same connector share
its credentials.

## Add a workspace

One epic becomes one board. From the UI: open the switcher, choose
"Add workspace…", fill in the name, the epic key, the repo and the connector
(or "new" to create one inline), and submit. The server validates the request
with the config schema, rewrites the file and brings the board up without a
restart; validation problems come back next to the field that caused them.

By hand, add an entry to `workspaces`:

```json
"docs-nextjs": {
  "name": "Docs · Next.js",
  "epic": "DOC-3807",
  "connector": "kentico-jira",
  "repo": "docs-workspace",
  "reviewStatuses": ["Ready for review"],
  "pollSeconds": 120
}
```

`connector` and `repo` are ids from the other two maps; naming one that does
not exist fails validation. `epic` is required, and must be an issue key such
as `DOC-3807` or a numeric issue id. A key is quoted into the query, so it can
neither break the JQL nor replace its ordering; a bare numeric id is emitted
unquoted, because JQL resolves a quoted operand as an issue key first. `jql` replaces the default
`parent = "<epic>" AND statusCategory != Done ORDER BY Rank ASC` query for
workspaces whose issues are not plain epic children — the epic key is still
what the header shows. `reviewStatuses` defaults to `["Ready for review"]`
and `pollSeconds` to 120.

The schema is strict: a key it does not know is a validation error rather
than a silently applied default, so `pollSecs` is caught instead of reverting
the interval to 120.

Removing a workspace (the switcher's remove action, or `DELETE
/api/workspaces/:id`) leaves its sessions, worktrees and issue flags alone —
another workspace over the same repo still shows them. It takes exactly one
other thing with it: the connector the removed workspace named, and only when
no remaining workspace names that connector. Nothing else can remove a
connector, so an inline one created from the dialog would otherwise be
permanent. A connector you wrote into the file by hand for a board that does
not exist yet is never touched, whether or not anything references it.

## Add a repo

Repos are file-only — a playbook set is not a form. Add an entry to `repos`:

```json
"docs-workspace": {
  "path": "/home/you/repositories/docs-workspace",
  "worktreeDir": "/home/you/repositories/worktrees",
  "baseRef": "origin/main",
  "branchPattern": "{{key}}-{{slug}}",
  "bootstrap": "npm ci",
  "playbooks": [ ... ]
}
```

`path` must be an existing git checkout with the remote `baseRef` names;
`worktreeDir` must be writable, and a session's worktree lands at
`<worktreeDir>/<KEY>`. `bootstrap` runs in the tmux session after a _new_
worktree is created, never on a reused one; leave it out for a repo that
needs nothing. `~` is expanded when the file is read, but a file the server
rewrites carries absolute paths.

Restart the server after editing `repos`: repo connectors are built at boot.

## Add a playbook

A playbook is a named kickoff recipe on a repo. Add an entry to that repo's
`playbooks`:

```json
{
  "id": "review",
  "label": "Review",
  "description": "Read the diff on the issue's branch and comment.",
  "isolation": "issue-worktree",
  "primaryFor": ["review"],
  "defaults": { "permissionMode": "acceptEdits" },
  "promptTemplate": "Review {{key}} — {{summary}}.\nThe checkout is {{worktree}} and its branch is {{branch}}."
}
```

- `id` is lowercase letters, digits and dashes, unique within the repo.
- `isolation` is `worktree` (fresh branch off `baseRef`), `issue-worktree`
  (the issue's existing branch, found from the newest session record for that
  issue in that repo, else from `origin/<KEY>-*`) or `shared` (the main
  checkout, no branch). Both non-shared isolations attempt a fetch of the base
  ref's remote before anything else — a failure only makes the refs stale — and
  both reuse an already-registered `<worktreeDir>/<KEY>` unless its HEAD is
  detached, which is refused: there is no branch to work on.
- `primaryFor` lists the board columns whose cards offer this playbook as
  their primary button: `backlog`, `working`, `needs-you`, `review`, `done`.
  The first playbook of the repo is the fallback for a column nothing claims,
  and two playbooks of one repo may not claim the same column: the second
  claimant could never be reached, so it is a validation error.
- `defaults` overrides the runner's model, effort and permission mode for
  this playbook only; the start dialog prefills from it and stays editable.
- `promptTemplate` may use `{{key}} {{summary}} {{type}} {{status}}
{{labels}} {{url}} {{description}} {{branch}} {{worktree}}`. Unknown
  variables are left as written. `{{branch}}` renders "the branch resolved
  when the session starts" when there is none yet — `shared` isolation, or
  `issue-worktree` before the checkout exists — so word the sentence around
  it to read in both cases: "on branch {{branch}}" does not.

## Add an issue-source type

Today's only type is `jira`. To add another:

1. Implement `IssueSource` from `src/core/types.ts` under
   `src/connectors/issues/<type>/`: `list()` returns the workspace's issues in
   display order, `get(key)` fetches one that dropped out of the list.
   Normalise the tracker's statuses onto `StatusCategory`
   (`todo | inprogress | done`) and its description to plain text — the board
   never sees tracker-shaped data.
2. Add a variant to `ConnectorConfig` in `src/core/types.ts` and to
   `connectorSchema` in `src/core/config.ts`, discriminated on `type`.
   Credentials are named, never inlined: keep the `<name>Env` convention so
   `checkEnvironment` can report a variable that does not resolve.
3. Register the type in `createIssueSource` in
   `src/connectors/issues/index.ts`. It receives the workspace id, the
   connector configuration and the workspace's query (`epic`, `jql`,
   `reviewStatuses`), so one account can back several workspaces.
4. Cover the mapping with a fixture test, as `test/connectors/jira-map.test.ts`
   does. No network in tests: pass a `fetch` replacement.

A source that cannot reach its tracker must throw. The server keeps the last
good list and shows the message as the board's `sourceError` rather than
emptying the board, and polls again on the next tick.

A query that repeating **cannot** fix is different: a search past its page
cap, a syntactically invalid query, a project the credentials cannot see.
Throw an error carrying `permanent: true` — the marker `PermanentSourceError`
in `src/core/types.ts` describes and `isPermanentSourceError` recognises, as
`JiraTruncatedError` does. The server suspends that workspace's poll timer
until the owner asks for a refresh, so the same rejected query does not cost
its full request budget every `pollSeconds` for as long as the server runs.
Nothing about the marker is Jira's, and the server never names a connector's
own error classes.

A resource the tracker returns without a usable key is dropped from `list`
and reported as "no such issue" by `get`: the key is what the projection
matches sessions by and what the browser URL is built from, so a keyless card
is a dead link on a lane of its own.

## Add a runner

The runner launches, attaches to, interrupts and kills sessions. Today's only
type is `claude-tmux`.

1. Implement `Runner` from `src/core/types.ts` under
   `src/connectors/runners/<type>/`: `start`, `resume`, `attach`, `interrupt`,
   `kill`, `isAlive`.
2. Report lifecycle through the hook ingress rather than by scraping the
   screen: `POST /api/hooks/:sessionId/launcher/<signal>` for
   `bootstrap-start`, `bootstrap-failed` (with `exitCode` and a `message`
   carrying the tail of what the bootstrap said — the exit code alone repeats
   what the card's state pill already shows), `claude-start` (with
   `{"mode":"resume"}` when the launch continues an existing transcript) and
   `claude-exit`, and `POST /api/hooks/:sessionId/<event>` for the CLI's own
   hooks. The names and body shapes are declared in `src/core/api.ts`, which
   both sides read. Post `bootstrap-start` only for a launch that really
   bootstraps: the state it opens is also what the reconciler reads as "died
   before it ever launched". Everything the dashboard shows is derived from
   those signals.
3. Add a variant to `RunnerConfig` and `runnerSchema`, then register the type
   in `createRunner` in `src/connectors/runners/index.ts`. `createRunner` is
   handed a `sessionDir` resolver; write the session's generated files there
   so the store's event log and the runner's scripts share one directory.
   Probe the executables the launch needs before reporting success — a start
   the owner was told succeeded, that then exits 127 inside the window, is
   invisible.
4. `attach` returns a `RunnerTerminal`; the WebSocket bridge pipes bytes both
   ways and calls `dispose()` when a viewer leaves, which must detach that
   viewer only and leave the session running.

Generated files are testable as strings: `test/connectors/session-files.test.ts`
asserts the whole launcher script for a sample record.
