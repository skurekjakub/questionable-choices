# Local instances — dev, built, and the "before" state

Everything a run verifies against runs on this machine. Two modes, two ports.

| Port | Process                                                             | Who owns it             |
| ---- | ------------------------------------------------------------------- | ----------------------- |
| 4400 | The Hono server (`config.port`, default 4400, bound to `127.0.0.1`) | You, when you start it  |
| 5173 | Vite dev server (`strictPort: true` in `src/web/vite.config.ts`)    | You, in `dev` mode only |

Both are fixed. Vite proxies `/api` and `/ws` to `http://127.0.0.1:4400`, so a
server on any other port leaves the dev SPA talking to nothing.

## `dev`

```bash
QC_CONFIG=<scratch>/config.json npm --prefix /home/jakubs/repositories/questionable-choices run dev
```

Run it **in the background** and capture its output to a file in the scratchpad —
the server log is an evidence layer (hook warnings, reconciler lines, the
uncaught-exception guard) and it is gone once the process ends. `npm run dev`
starts two processes under `concurrently`: `tsx watch src/server/main.ts` on 4400
and `vite` on 5173.

Poll an endpoint you have confirmed exists in `src/server/app.ts`. There is no
health route; the cheapest real one is:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4400/api/config/public
```

Loop that until it answers 200 rather than sleeping a guessed interval. **Drive
the UI at `http://127.0.0.1:5173`**, not at 4400 — see the split below.

`tsx watch` restarts the server when a file under `src/server`, `src/core` or
`src/connectors` changes. A verification run changes nothing, so it should never
restart on its own; if it does, something wrote into the tree and that is a
finding.

## `built`

```bash
npm --prefix /home/jakubs/repositories/questionable-choices run build
```

```bash
QC_CONFIG=<scratch>/config.json npm --prefix /home/jakubs/repositories/questionable-choices start
```

`build` runs `build:web` (Vite → `dist/web`) then `build:server` (tsc →
`dist/server`); `start` is `node dist/server/main.js`. One port, 4400, serving both
the API and the SPA. Drive the UI at `http://127.0.0.1:4400`.

## The dev/built split

| Surface                           | `dev`                                                                                                                                      | `built`                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Where the owner's UI lives        | `http://127.0.0.1:5173` (Vite), proxied to 4400                                                                                            | `http://127.0.0.1:4400`                                              |
| `GET /` on **4400**               | Serves the **un-transpiled** `src/web/index.html`, whose `<script src="/src/main.tsx">` only Vite can resolve — a blank page, not a defect | Serves `dist/web/index.html` and the hashed assets                   |
| Deep link `/session/<id>` on 4400 | Same un-transpiled shell                                                                                                                   | The SPA fallback answers with `index.html`, so the deep link works   |
| Unknown `/api/...` route          | JSON `{ "error": "no route for …" }`, 404                                                                                                  | Same                                                                 |
| Server reload                     | `tsx watch` restarts on a source change                                                                                                    | None; a change needs a rebuild                                       |
| React StrictMode                  | On — effects mount twice, and the events socket logs two WebSocket warnings on load                                                        | Off — those warnings are absent                                      |
| Source of `src/web` behaviour     | The files as they are on disk                                                                                                              | The bundle in `dist/web`, which is only as fresh as the last `build` |

`src/server/app.ts` mounts the static handlers only when the resolved web root
exists, and resolves it as `../web` relative to the running module — `src/web` under
`tsx`, `dist/web` under `npm start`. Both exist, which is why 4400 answers with a
shell in both modes and only one of them is usable. **Confirm the row you are
about to rely on by observing it**, rather than quoting this table into a report.

**`VITE_MOCK=1` replaces every API call with fabricated data** (`src/web/src/main.tsx`
loads `dev-mock.ts`). A board full of plausible sessions that no server ever saw
is the worst possible false pass. Never set it, and if the board shows sessions
that `GET /api/workspaces/:id/board` does not, check for it first.

## Starting and stopping servers

Start in the background; never block a turn waiting on a foreground server.

Find what you started, and only what you started:

```bash
ss -ltnp
```

Read the PID off the line for the port, and stop that PID. **Never `pkill node`,
never `pkill -f vite`** — the owner has other Node processes on this machine, and
one of them may be a `claude` session doing real work.

`SIGTERM` is handled: `src/server/main.ts` terminates every WebSocket client,
closes idle connections and exits 0. If it does not exit promptly, that is a
finding worth timing — an attached browser holding an event socket is exactly the
bug `c37dba6` fixed, and it can come back.

## The "before" state

A bug verdict needs the defect observed before the fix. Cheapest first:

1. **`docs/verification.md`** — its "What still does not work" section is a dated,
   sourced measurement. Cite it; do not repeat it.
2. **The previous `TEST-REPORT.md`**, when the bug is one it recorded, with its repro.
3. **A second checkout at the parent commit**, only with the requester's agreement:

   ```bash
   /usr/bin/git -C /home/jakubs/repositories/questionable-choices worktree add <scratch>/before <commit>~1
   ```

   It costs its own `npm install` and its own scratch config with a **different
   `dataDir` and a different `port`** — two servers sharing a `dataDir` corrupt each
   other's `sessions.json`, and 5173 is `strictPort`, so a second dev SPA cannot
   start at all. Prefer running the before-instance in `built` mode on a spare port
   for that reason. Remove the worktree in Phase 8.

Whichever source you use, the after-measurement must be the same action, on the
same surface, read the same way, or the pair means nothing.
