# Preflight

Run before reading the target. Each check exists because skipping it costs a run
late, after the expensive work is done. Report the resolved result as a table,
then continue.

## 1. The repository — hard

This checkout is the repository under test; there is no separate clone.

```bash
/usr/bin/git -C /home/jakubs/repositories/questionable-choices log --oneline -1
```

```bash
/usr/bin/git -C /home/jakubs/repositories/questionable-choices status --porcelain
```

Record the HEAD commit and the `--porcelain` output **verbatim** as the baseline.
The end-of-run comparison is against this, not against "clean": other agents run
in this repository too, and a `TEST-REPORT.md` or an untracked analysis file that
was already there is not yours to touch or to report as your own residue.

## 2. Dependencies and a green baseline — hard

```bash
ls /home/jakubs/repositories/questionable-choices/node_modules/.bin/vitest
```

```bash
npm --prefix /home/jakubs/repositories/questionable-choices run typecheck
```

```bash
npm --prefix /home/jakubs/repositories/questionable-choices run test
```

A red baseline is a **finding you report**, not a bug you fix and not a reason to
stop: note which tests fail at HEAD and carry that into the report, so a failure
you meet later is not attributed to the change. `npm run verify` also runs
`format:check` and a full build — use it when the change touches build config,
and expect it to take minutes.

## 3. Config isolation — hard

**Never run the dashboard against the owner's live config.** It names their real
repositories, their real `worktreeDir`, and a `dataDir` holding the history of
every session they have run. A test run against it creates worktrees in their
tree and writes session records into their store.

The mechanism is one environment variable. `resolveConfigPath` in
`src/core/config.ts` reads `QC_CONFIG`, expands a leading `~`, and falls back to
`<home>/.config/questionable-choices/config.json` when the variable is unset or
empty. `src/server/main.ts` and `src/server/config-check.ts` both call it, so the
same variable moves the server and the checker together.

Build the scratch config:

```bash
mkdir -p /tmp/claude-<uid>/.../scratchpad/qc/{data,worktrees}
```

```bash
cp /home/jakubs/.config/questionable-choices/config.json <scratch>/config.json
```

Then edit `<scratch>/config.json` with the Edit tool — never with a script — and
change exactly these fields, leaving everything else identical so the run is
still testing the owner's real shape:

| Field                          | Set to                | Why                                                                                                                                    |
| ------------------------------ | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `dataDir`                      | `<scratch>/data`      | `sessions.json`, `flags.json`, `worktrees.json` and every session directory land here instead of `~/.local/share/questionable-choices` |
| every `repos.<id>.worktreeDir` | `<scratch>/worktrees` | worktrees land outside the owner's tree; the repo `path` stays as it is, because that checkout is the thing under test                 |
| `port`                         | leave it              | 4400 is what the Vite proxy targets (`src/web/vite.config.ts`); changing it silently breaks the dev SPA                                |

Keep the original copy in the evidence directory: it is what proves in Phase 8
that the live file was never touched.

Verify with the checker, which loads exactly what the server would:

```bash
QC_CONFIG=<scratch>/config.json npm --prefix /home/jakubs/repositories/questionable-choices run config:check
```

It prints the resolved path, one line per workspace and repo, one line per named
credential variable that does not resolve, and exits 1 on a zod failure or a repo
path that is not a git checkout. **The resolved path it prints is the gate** — if
it is not your scratch path, the override did not take and nothing else may start.

**Credentials are named, never inlined.** Each connector's `emailEnv` and
`tokenEnv` name the environment variables that hold them. Read the names from the
config; never print, echo, log or copy a value into the report or the evidence
directory. A `curl` that would put a token on a command line is not the way to
check Jira — use the dashboard's own board route.

## 4. The target repository baseline — hard for anything that starts a session

The repository sessions run in belongs to the owner and may be mid-work.

```bash
/usr/bin/git -C <repo path from the config> status --porcelain
```

```bash
/usr/bin/git -C <repo path from the config> branch --list
```

```bash
/usr/bin/git -C <repo path from the config> worktree list
```

Record all three. They are the only way to tell in Phase 8 which branches and
worktrees this run created. Nothing in this run may `checkout`, `stash`, `reset`,
`commit`, edit a file, or run an npm script in that repository — the dashboard
itself will `fetch` and add worktrees, and that is the behaviour under test.

## 5. Tools — hard for any board or session work

```bash
which tmux claude curl ss node
```

```bash
tmux ls
```

`tmux ls` also gives the baseline session list: anything already named `qc-*`
belongs to the owner or to another run, and is not yours to kill. A missing
`claude` on PATH is refused by the runner up front
(`MissingExecutableError`), so a start that fails this way is correct behaviour,
not a defect.

For the browser, `agent-browser --version`, or the Playwright MCP tools. Details in
[`browser-testing.md`](browser-testing.md).

## 6. Instance mode — hard

Decide now; it changes what exists. The split is in
[`local-instances.md`](local-instances.md).

| Mode    | When                                                                    | Gives                                                  |
| ------- | ----------------------------------------------------------------------- | ------------------------------------------------------ |
| `dev`   | Anything in `src/web`, or fast iteration on the server                  | Vite on 5173 with HMR, server on 4400 with `tsx watch` |
| `built` | The SPA served by the server, the static/SPA fallback, anything shipped | What `npm start` actually serves                       |

Whichever you pick, the port must be free first:

```bash
ss -ltnp
```

A port already in use is the one boot failure that still exits: `src/server/main.ts`
prints one line naming the port and exits 1. If 4400 or 5173 is already held by
something you did not start, stop and ask — do not kill it.

## 7. Evidence directory — soft

```bash
mkdir -p /home/jakubs/repositories/questionable-choices/.cache/test-issue/<id>-<yyyymmdd>
```

`/.cache/` is in `.gitignore`, so nothing here can be committed by accident. Copy
every screenshot and transcript you cite into it under the caption you gave it, so
the report's evidence survives the session. The session scratchpad works too and
is the right place for the throwaway `ws` script and the scratch config; the
evidence directory is for what the report cites. Do not put scratch files anywhere
else in the tree.
