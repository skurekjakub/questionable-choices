---
name: bootstrap-environment
description: >
  Get the questionable-choices dashboard running on this machine: check the
  tools it shells out to (node, tmux, claude, git, curl, an editor launcher),
  create the config file from config.example.json with real paths and a Jira
  connector, confirm the credential env vars resolve, install and verify, then
  start it and prove one session works. Use this whenever someone wants to set
  up, install, bootstrap, onboard, configure, or "just get running" the
  dashboard, first-time-runs it on a new machine or WSL distro, asks why
  `npm run dev` fails or the board is empty, needs to add a Jira connector or a
  repo to the config, or hits errors about node-pty, tmux, curl, JIRA_*
  variables, or a missing config.json — even if they never say "bootstrap".
argument-hint: "[optional: what is failing]"
---

# Bootstrap the environment

The dashboard is a Node server plus a Vite SPA, but almost everything it does
happens by shelling out: `tmux` to hold sessions, `claude` to run them, `git`
for worktrees, `curl` inside generated hook scripts, and an editor command to
open a worktree. A missing tool never fails at install time; it fails the
first time a session starts, inside a tmux window the user has to go and
find. So this skill front-loads every check, fixes what it can, and ends with
a real session started from the board — that is the only proof that counts.

Design and the config shape live in `docs/spec.md`; read §4 (Configuration)
before writing a config, and `config.example.json` for the owner's real
values.

## Phase 0 — Preflight

Run the bundled check and read every line:

```bash
bash .claude/skills/bootstrap-environment/scripts/preflight.sh
```

It prints one row per requirement with `ok` / `missing` / `warn` and the
reason. Requirements and what to do when one is missing:

| Check | Why the dashboard needs it | Fix |
|---|---|---|
| node ≥ 22 | ESM + `node:` built-ins the server uses | nvm / distro package |
| npm ≥ 10 | `allowScripts` in package.json (npm 12 blocks install scripts by default) | comes with node |
| tmux ≥ 3.2 | sessions live in tmux; `-e` and `window-size latest` need 3.2+ | `apt install tmux` |
| claude on PATH | the runner execs it; also needs to be logged in | `npm i -g @anthropic-ai/claude-code`, then `claude` once to log in |
| git | worktrees | distro package |
| curl | every hook and the statusline script POST with it | distro package |
| build tools (python3, make, g++) | node-pty compiles a native module when no prebuild matches | `apt install build-essential python3` |
| editor launcher | "Open in VS Code" button | see Phase 2 |
| `~/.claude/settings.json` readable | the runner chains the user's statusline command from it | optional; absent means no chained statusline |

Do not skip the build-tools row on WSL: node-pty's prebuild sometimes fails
to load there and falls back to compiling, which is where a missing `g++`
surfaces as `Failed to load native module: pty.node`.

## Phase 1 — Install

```bash
npm install
```

Then confirm the native module loads, because a blocked install script leaves
`node-pty` present but empty:

```bash
node -e "require('node-pty'); console.log('pty ok')"
```

If that throws, approve the script and rebuild in two commands:

```bash
npm install-scripts approve node-pty
npm rebuild node-pty
```

Same pattern for `esbuild` if `vite` refuses to start
(`npm install-scripts approve esbuild`).

## Phase 2 — Config

Config path: `~/.config/questionable-choices/config.json` (or `$QC_CONFIG`).
Never write credentials into it; it names environment variables.

1. Copy the example and open it:
   ```bash
   mkdir -p ~/.config/questionable-choices
   cp config.example.json ~/.config/questionable-choices/config.json
   ```
2. Walk the user through the four blocks, asking rather than guessing when a
   value is personal. Read `references/config-walkthrough.md` for the
   questions, the defaults, and the per-platform editor commands (WSL uses
   `cmd.exe /c code --remote wsl+<distro>`; native Linux and macOS use
   `code`).
3. `connectors`: a Jira site and the two env-var *names*. Check the variables
   resolve in the shell that will run the server:
   ```bash
   env | grep -E '^(JIRA|ATLASSIAN)' | sed 's/=.*/=<set>/'
   ```
   If they are set only in an interactive profile, the user must start the
   dashboard from that shell (or export them in `~/.profile`).
4. `repos`: `path` must be an existing git checkout with a remote matching
   `baseRef`; `worktreeDir` must be writable; `bootstrap` is whatever makes a
   fresh clone runnable (`npm ci` for a Node repo, empty string for none).
5. `workspaces`: one per epic; `connector` and `repo` are ids from the maps
   above.

Validate before starting anything:

```bash
npm run config:check
```

It loads the config the server would load, prints the resolved path, every
workspace with its connector and repo, and one line per named env var that
does not resolve. Zod issues come out with their JSON path; fix them in the
user's file, not in the example.

## Phase 3 — Verify the Jira connector

A wrong site or token shows up as an empty board with a banner, which users
read as "the dashboard is broken". Prove the credentials first, with the same
variables the config names:

```bash
curl -s -u "$JIRA_EMAIL_KENTICO_JIRA:$JIRA_PAT_KENTICO_JIRA" https://kentico.atlassian.net/rest/api/3/myself | head -c 200
```

Substitute the user's variable names and site. A JSON body with
`displayName` means the connector will work; `401` means the token; a
redirect to a login page means the site.

## Phase 4 — Run

```bash
npm run verify
```

must be green (typecheck, format, tests, build). Then:

```bash
npm run dev
```

Server on `http://127.0.0.1:4400`, UI on `http://127.0.0.1:5173`. On WSL
both are reachable from a Windows browser at the same `localhost` addresses.
If 4400 is taken, change `port` in the config; the Vite proxy reads the same
value.

Confirm the board loads and shows the epic's issues. An empty board with a
banner names the source error verbatim; go back to Phase 3.

## Phase 5 — Prove a session

Start one `implement` session on a small issue from the board and watch the
card:

1. `bootstrapping` while the repo's bootstrap command runs in the tmux
   window (visible in the browser terminal).
2. `starting` → `working` once claude submits the kickoff prompt.
3. `needs you` when it asks something or wants permission; answer in the
   embedded terminal.

If the card stays at `starting`, the hooks are not reaching the server: open
the tmux session (`tmux attach -t qc-<KEY>-implement`), check the generated
`~/.local/share/questionable-choices/sessions/<id>/settings.json` names the
right port, and run its curl line by hand. If the tmux window shows
`claude: command not found`, the PATH inside tmux differs from the user's
shell — tmux starts a login shell, so the fix is in `~/.profile`, not
`~/.bashrc`.

Stop when the user has seen one card move to `needs you` or `idle` from a
session they started themselves. Report what was installed, what the config
now contains (paths and ids only, never token values), and anything left on
`warn`.
