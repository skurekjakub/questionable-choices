# questionable-choices

A local dashboard that turns a Jira epic into a board of Claude Code
sessions. Pick an issue, and a real `claude` session starts in tmux inside a
git worktree of your repo. The browser shows the terminal and tracks what
the session is doing — working, waiting for permission, asking you a
question, your turn — through Claude Code hooks rather than screen scraping.

```
┌ Backlog (68) ─┐ ┌ Working (2) ─┐ ┌ Needs you (1) ─┐ ┌ Review (3) ─┐ ┌ Done ─┐
│ DOC-3885      │ │ DOC-3868 ●   │ │ DOC-3847  ⚠    │ │ DOC-3809    │ │       │
│  changelog…   │ │  prod restarts│ │  Bash(npm ci)  │ │  [Test]     │ │       │
└───────────────┘ └──────────────┘ └────────────────┘ └─────────────┘ └───────┘
```

One person, one machine, bound to `127.0.0.1`. Built for WSL, works on any
Linux or macOS with the same tools.

## What it does

- **Board per epic.** Columns are what you need to do next, not Jira
  statuses: Backlog · Working · Needs you · Review · Done. The header
  dropdown switches between epics.
- **Real sessions.** `claude` runs in a tmux session with your plugins,
  skills and statusline; xterm.js attaches to it in the browser and you can
  `tmux attach` from any terminal too.
- **Worktree per issue.** Each session gets `<worktreeDir>/<KEY>` on a branch
  named after the issue, bootstrapped by whatever your repo needs.
- **Playbooks.** `implement` on a fresh worktree; `test` on the issue's
  branch with the repo's own QA skill. Model, effort and permission mode are
  picked per session; the kickoff prompt is editable before launch.
- **State from hooks.** A per-session `--settings` file adds hooks that
  POST to the dashboard; your own hooks keep running. The prompt-cache
  countdown on each card comes from the same statusline payload your status
  bar reads.
- **Connectors.** Issue source, repo and runner sit behind small interfaces;
  another epic, repo or tracker is a config entry.

Design: [`docs/spec.md`](./docs/spec.md). Build plan:
[`docs/plan.md`](./docs/plan.md). Extending:
[`docs/connectors.md`](./docs/connectors.md). What a real run looks like, and
what it still gets wrong: [`docs/verification.md`](./docs/verification.md),
with screenshots of every state in
[`docs/screenshots/`](./docs/screenshots/).

## Prerequisites

| Tool                        | Why                                                                           |
| --------------------------- | ----------------------------------------------------------------------------- |
| Node ≥ 22, npm ≥ 10         | server + SPA; npm 12 needs the `allowScripts` block already in `package.json` |
| tmux ≥ 3.2                  | sessions live here                                                            |
| `claude` on PATH, logged in | the runner execs it                                                           |
| git, curl                   | worktrees; hook and statusline POSTs                                          |
| python3, make, g++          | only if node-pty has no prebuild for your platform                            |
| A Jira API token            | in an env var the config names — never in the file                            |

Run `bash .claude/skills/bootstrap-environment/scripts/preflight.sh` to
check all of them, or open the repo in Claude Code and ask it to set the
environment up: the `bootstrap-environment` skill walks through it.

## Setup

```bash
npm install
mkdir -p ~/.config/questionable-choices
cp config.example.json ~/.config/questionable-choices/config.json
```

Edit the config (or set `QC_CONFIG` to another path). Four blocks:

- `connectors` — Jira site plus the names of the env vars holding email and
  API token.
- `repos` — checkout path, where worktrees go, base ref, bootstrap command,
  playbooks.
- `workspaces` — one per epic: name, epic key, which connector, which repo, and
  an optional `checklist` of item texts, shown in the issue drawer as a private
  per-issue checklist that never reaches Jira.
- `editor` — the command behind the "Open in VS Code" button. On WSL that is
  `cmd.exe /c code --remote wsl+<distro> {{path}}`.

Then:

```bash
npm run config:check   # loads the config, lists workspaces, flags unresolved env vars
npm run verify         # typecheck, format, tests, build
npm run dev            # server on 4400, UI on 5173, both with reload
```

**In dev, the dashboard is on 5173, not 4400.** Vite serves the SPA and proxies
`/api` and `/ws` through to the server; port 4400 serves the API and the
WebSockets but has no built SPA to hand out, so it answers every request that
is not `/api` or `/ws` with 503 and a message saying so.

Production-style: `npm run build` then `npm start`. Now 4400 serves both the
built SPA and the API, and 5173 is not running at all. The bookmark to use
depends on which of the two you started.

To open the UI with no server, no Jira and no tmux — for looking at the layout,
or working on the SPA alone — run `VITE_MOCK=1 npm run dev:web` and open 5173.
Every route is answered from fabricated data in `src/web/src/dev-mock.ts`. It
certifies nothing: the mock is written by hand and can disagree with the server
in any direction, so a thing that works against it may still be broken, and a
thing that looks broken may only be the mock. It is excluded from a production
build.

## Using it

1. Open the board, pick an epic in the header.
2. Click a card's primary action (`Implement` on backlog cards, `Test` on
   review cards). Edit the prompt, pick model / effort / permission mode,
   Start.
3. The card moves to Working, then to Needs you when the session asks for
   permission, asks a question, or finishes a turn. Click through to the
   terminal and answer there.
4. When the PR is up, move the issue to review in Jira (or "Send to
   review" on the card) and dispatch a `Test` session on the same branch.
5. Kill the session, then remove its worktree from the session panel, when the
   branch is merged. A worktree in use by a live session is refused.

`permission mode` picks what `claude` is launched with, and `default` means "no
flag" — the session then runs in whatever your own Claude Code settings default
to, which may well be a mode that never prompts. Pick `manual` if you want to
answer every tool call from the board.

Sessions survive dashboard restarts: tmux keeps them, and the server
reconciles on boot. A session whose `claude` exited can be resumed with the
same conversation.

## Data

Everything lives under `~/.local/share/questionable-choices/`: session
records, per-issue flags, the worktree registry, and one directory per
session with its prompt, generated settings, launcher and hook event log.

## Development

Single TypeScript package. `src/core` is pure domain (types, config schema,
state machine, projection) with the connector interfaces; `src/connectors`
implements them (Jira, git worktrees, claude in tmux); `src/server` is Hono
plus WebSockets; `src/web` is Vite + React. Tests are Vitest, and `test/`
mirrors `src/` a directory at a time. They reach no tracker, no tmux and no
listening socket; the three things they really do — drive git against a
temporary repository, run the generated launcher under `bash` with a stub
`curl`, and spawn one child process for the editor launcher — are named in
`docs/spec.md` §15.

`npm run verify` is the gate. Start from `docs/spec.md` before changing
behaviour; the spec is kept current with the code.

## License

MIT.
