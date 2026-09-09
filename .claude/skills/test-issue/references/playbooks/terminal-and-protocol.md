# Playbook — terminal, WebSockets, ingress and restart

For a change under `src/server/terminal-ws.ts`, `hooks.ts`, `app.ts`, `main.ts`,
`store.ts`, or the runner's attach path. The consumers here are the browser's two
sockets, the generated hook scripts, and the files under `dataDir`.

`src/core/api.ts` is the contract both sides read. Check a route or a frame shape
against it before calling anything a defect.

## HTTP evidence

Take transcripts with headers, and save them into the evidence directory:

```bash
curl -sS -D - -o /dev/null http://127.0.0.1:4400/api/config/public
```

The statuses to hold every route to are in `docs/spec.md` §11. Cover at least:

| Request                                                                                            | Expected                                                                                                        |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `GET /api/config/public`                                                                           | 200, workspaces / repos / connectors / runner (models, defaults, efforts, permissionModes)                      |
| `GET /api/workspaces/<unknown>/board`                                                              | 404, `unknown workspace '<id>'`                                                                                 |
| `GET /api/workspaces/<ws>/issues/<KEY>/prefill` with no `playbook`                                 | 400, `the 'playbook' query parameter is required`                                                               |
| `POST /api/workspaces/<ws>/issues/<KEY>/sessions` with an unknown model, effort or permission mode | 400, naming the accepted values                                                                                 |
| `POST /api/sessions/<unknown>/kill`                                                                | 404, `unknown session '<id>'`                                                                                   |
| `GET /api/<anything unrouted>`                                                                     | 404 JSON `{ "error": "no route for /api/…" }`, not the SPA shell                                                |
| `GET /session/<id>`                                                                                | The SPA shell in `built` mode; see [`../local-instances.md`](../local-instances.md) for what `dev` does on 4400 |

Every refusal is JSON `{ error, detail?, issues? }` so the UI can show it
verbatim — check the UI actually does, rather than swallowing it into a generic
message.

## Hook ingress

Three routes, all unauthenticated and loopback-only:
`POST /api/hooks/:sessionId/:event`, `.../statusline`, `.../launcher/:event`.

| Request                                                                  | Expected                                                                                               |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Valid payload for a known session                                        | **204**                                                                                                |
| Unknown session id                                                       | **404**, `unknown session '<id>'`, and a warning in the server log                                     |
| Body that is not a JSON object — no body, `[]`, `"text"`, malformed JSON | **400**, `... needs a JSON object body`                                                                |
| Known session, **unknown event name**                                    | **204** with a log line, not an error — an unrecognised hook must never look like a failure to the CLI |
| Body over 1 MB                                                           | **400**, refused by the size cap in `src/server/util.ts` before parsing                                |

The size cap is checked twice: against the declared `content-length` and against
the decoded text, so a lying header does not get through. Test both — a 2 MB body
with an honest header, and a small body with an inflated one.

Whatever the answer, the hook that sent it exits 0 regardless: the generated
command ends in `|| true` with a 2 s timeout, so **a dashboard that is down must
never block a session**. Prove it by stopping the server while a session is live,
sending a prompt in the terminal, and watching the session keep working — then
restart and see the reconciler catch up.

## `events.jsonl` grows only on change

`refreshInterval: 1` posts a status-line payload **every second**. A payload the
reducer rejects as unchanged is not logged; a 19-minute session once wrote 870 of
them against 47 real events and 1.4 MB in which the lifecycle was unreadable.

Measure it rather than assuming: park a session at `idle` and read the file size
twice, sixty seconds apart.

```bash
wc -c /path/to/scratch/data/sessions/<id>/events.jsonl
```

Flat is the pass. Growth of roughly one line per second is the regression
`acbcda9` fixed, and it is a silent one — everything still works, the log just
stops being usable.

## `/ws/terminal/:sessionId`

Attach from the browser first: type into the xterm, watch the characters land in
`tmux capture-pane -p -t <id>`, resize the window and watch the TUI reflow. That
path — keystroke → binary frame → node-pty → tmux → the CLI — is the product.

Then the protocol edges, with a small `ws` script in the scratchpad (`ws` is
already a dependency, so `node <script>` from the repo root resolves it):

| Case                                           | Expected                                                                                                                   |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Unknown session id                             | A JSON text frame `{"type":"error","message":"unknown session '<id>'"}`, then **close 1008** with reason `unknown session` |
| Attach failure                                 | An `error` frame, then close **1011**                                                                                      |
| The pty exits                                  | An `{"type":"exit","exitCode":n}` frame, then close **1000**                                                               |
| No `cols` / `rows` query                       | Defaults of 220 × 50                                                                                                       |
| `cols`/`rows` outside 1–1000, or non-integer   | Ignored; the default is used                                                                                               |
| A text frame that is not `{"type":"resize",…}` | Ignored, socket stays open                                                                                                 |
| Two viewers on one session                     | Both attached; tmux is set to `window-size latest`, so the pane follows the most recent resize                             |
| One viewer closes                              | That pty is disposed only — the tmux session and the other viewer keep running                                             |

The client stops reconnecting once the server sends an `error` frame, once the
session is no longer live, or after six attempts, and then prints "not reattaching;
use Reconnect to try again" with a Reconnect button in the detached bar. Walk the
whole backoff at least once: kill the server, watch the delays lengthen
(500 ms → 1 s → 2 s → 4 s → 8 s → 15 s), restart it, and confirm the terminal
reattaches to the **same live tmux session** with its scrollback intact.

A viewer that stops reading has its pty output dropped past 4 MB buffered rather
than growing the server's heap; a terminal repaints itself, so the visible result
of that is a redraw, not a hang.

## `/ws/events`

One `board` frame per workspace on connect, then `board` (debounced 250 ms),
`session`, and `config` frames after a workspace is added or removed. The client
multiplexes every hook over one shared socket and replays the newest board frame
to a late subscriber, so a component mounting between pushes renders immediately.

The standing clause is two tabs in sync — see
[`../browser-testing.md`](../browser-testing.md). Add: a workspace added in one
tab must appear in the other's switcher without a reload, which is what the
`config` frame is for.

## Restart recovery

The single most valuable clause in this file, because it is what "sessions survive
dashboard restarts" in the README means:

1. Start a session, leave it at `idle`, note its id and `tmux ls`.
2. Stop the server by PID (SIGTERM).
3. Confirm the tmux session is **still there** and the `claude` process still alive.
4. Restart the server with the same `QC_CONFIG`.
5. The record is reconciled on boot, the board shows it in the same state, the
   browser reconnects over the backoff, and the terminal reattaches.

Then the other half: kill the **tmux** session out from under a live record and
wait. The reconciler runs on boot and every 10 s, probing `tmux has-session` for
each live record; a missing session becomes `exited`, or `failed` if it never
reached `starting`. A record younger than one interval is skipped, so a session
that is still being created is not reaped mid-launch — which means the transition
can take up to about twenty seconds. Time it rather than declaring it broken at
five.

## Shutdown and boot failures

- **SIGTERM must be prompt**, with a browser attached. `main.ts` terminates every
  WebSocket client, closes idle keep-alive connections and exits 0. A hang here is
  the regression `c37dba6` fixed — an attached browser holds its event socket and
  one terminal socket per open session view for the life of the tab, and
  `server.close` waits for all of them. Test it with a tab open, not with a
  headless `curl`-only client, or the bug cannot appear.
- **Port already in use** is the one boot failure that still exits: one line
  naming the port — `port 4400 is already in use; stop the other server or change
'port'` — and status 1. Everything else is caught by the process-wide
  `uncaughtException` / `unhandledRejection` guard, which logs and **stays up**,
  because the reconciler cannot recover a record whose events were never received.
  A run that sees `uncaught exception, still serving:` in the log has found
  something, even though the server survived: capture the line and the stack.
