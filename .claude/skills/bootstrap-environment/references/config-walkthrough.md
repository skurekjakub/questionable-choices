# Config walkthrough

Questions to ask, in order, when turning `config.example.json` into the
user's `~/.config/questionable-choices/config.json`. Ask; do not guess paths
or account details. The full key reference is `docs/spec.md` §4.

## Top level

| Key | Ask | Default |
|---|---|---|
| `port` | "Anything already on 4400?" | 4400 |
| `dataDir` | rarely worth asking | `~/.local/share/questionable-choices` |

## `editor`

"Which editor should the Open button launch, and from where?"

| Platform | `command` | `args` |
|---|---|---|
| WSL, VS Code on Windows | `cmd.exe` | `["/c", "code", "--remote", "wsl+<distro>", "{{path}}"]` — distro from `$WSL_DISTRO_NAME` |
| Linux / macOS, VS Code | `code` | `["{{path}}"]` |
| Anything else | the CLI that opens a folder | must contain `{{path}}` once |

`code` on WSL's PATH is usually the VS Code *server* shim, which only works
inside an existing VS Code terminal; the detached dashboard process needs the
Windows CLI through `cmd.exe`.

## `runner`

| Key | Ask | Notes |
|---|---|---|
| `models[]` | "Which models do you want in the picker?" | ids as `claude --model` accepts them; labels free text |
| `defaultModel` | one of the ids above | required |
| `defaultEffort` | low · medium · high · xhigh · max | |
| `defaultPermissionMode` | default · acceptEdits · auto · bypassPermissions · manual · dontAsk · plan | `acceptEdits` is the usual answer for "ask me only for commands" |
| `claudeBin` | only if `claude` is not on PATH inside tmux | absolute path then |

## `connectors`

One entry per Jira account. "Which Atlassian site, and which two environment
variables hold the email and the API token?"

- `site`: host only, e.g. `kentico.atlassian.net`
- `emailEnv` / `tokenEnv`: variable *names*. Confirm they are exported in the
  shell that starts the dashboard, not just in a Claude Code MCP config.
- API tokens come from https://id.atlassian.com/manage-profile/security/api-tokens.

## `repos`

One entry per git checkout sessions run in.

| Key | Ask | Notes |
|---|---|---|
| `path` | "Where is the main checkout?" | must contain `.git` and have the remote `baseRef` names |
| `worktreeDir` | "Where should per-issue worktrees go?" | created if missing; sibling of the repo is the usual choice |
| `baseRef` | usually `origin/main` | fetched before every worktree add |
| `branchPattern` | `{{key}}-{{slug}}` unless the team has a convention | |
| `bootstrap` | "What makes a fresh clone runnable?" | `npm ci`, `pnpm install`, `''` for none |
| `playbooks[]` | keep the example's `implement` and `test` unless the repo has no test skill | prompt templates use `{{key}} {{summary}} {{type}} {{status}} {{labels}} {{url}} {{description}} {{branch}} {{worktree}}` |

The example's `test` playbook assumes the repo has a `test-issue` skill. For a
repo without one, delete that playbook or rewrite its `promptTemplate`.

## `workspaces`

One entry per epic. "Which epic key, through which connector, in which repo?"

| Key | Notes |
|---|---|
| `name` | what the header dropdown shows |
| `epic` | parent issue key, e.g. `DOC-3807` |
| `connector` / `repo` | ids from the maps above |
| `reviewStatuses` | Jira status names that mean "done, awaiting review"; default `["Ready for review"]` |
| `jql` | only when the epic's children are not `parent = <epic>`; replaces the whole query |

Workspaces can also be added later from the UI's "Add workspace…" entry; the
server writes them into the same file.
