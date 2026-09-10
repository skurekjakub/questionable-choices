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
/api/workspaces/:id`) deletes nothing else: its sessions, worktrees and issue
flags stay, and another workspace over the same repo still shows them.

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
  "promptTemplate": "Review {{key}} — {{summary}} on branch {{branch}} in {{worktree}}."
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
  variables are left as written.

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
emptying the board.

## Add a runner

The runner launches, attaches to, interrupts and kills sessions. Today's only
type is `claude-tmux`.

1. Implement `Runner` from `src/core/types.ts` under
   `src/connectors/runners/<type>/`: `start`, `resume`, `attach`, `interrupt`,
   `kill`, `isAlive`.
2. Report lifecycle through the hook ingress rather than by scraping the
   screen: `POST /api/hooks/:sessionId/launcher/<signal>` for
   `bootstrap-start`, `bootstrap-failed`, `claude-start` (with
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
