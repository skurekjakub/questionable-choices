# Playbook — the board and its issue source

For a change under `src/connectors/issues/`, `src/core/projection.ts`, the
workspace half of `src/core/config.ts`, or the board and switcher components. The
consumer is the owner looking at five columns and believing they are the truth
about an epic.

## Columns

Five lanes, always five, in this order and with these ids: **Backlog**
(`backlog`) · **Working** (`working`) · **Needs you** (`needs-you`) · **Review**
(`review`) · **Done** (`done`). Each heading carries a count and each column
carries `aria-label="<name>, <n> issues"`.

Placement is first-match-wins (spec §6), and the order is the whole point — a
session that needs the owner outranks the issue's tracker status, because the
columns answer "what do I do next", not "what does Jira think":

1. any live session in the needs-you set → **Needs you**
2. any live session in `{bootstrapping, starting, working}` → **Working**
3. flag `done`, or `issue.statusCategory === 'done'` → **Done**
4. flag `review`, or `issue.status` ∈ the workspace's `reviewStatuses` → **Review**
5. otherwise → **Backlog**

Test the precedence, not each rule alone: put a card in a state where two rules
match and check the higher one wins. A card whose issue is in a review status
**and** has a waiting session belongs in Needs you; if it sits in Review, the
projection is reading in the wrong order.

Ordering inside a column matters too, and only Needs you has a non-trivial rule:
`waiting-permission` and `waiting-question` first, then `idle`, each by
`stateSince` ascending so the longest wait is on top. Working is `stateSince`
ascending; the other three are source order, which is Jira rank.

## Counts against the tracker

The board's count is only as good as the query behind it. The default query is
built by `epicChildrenJql`:

```
parent = "<epic>" AND statusCategory != Done ORDER BY Rank ASC
```

`jql` on the workspace replaces the whole query; the epic key is still what the
header shows. Run the same query directly and compare the count with the board's.
A Jira MCP tool is the clean route (`jira_search_issues` with the same JQL). If
you must use `curl`, pass the credentials **by variable name only** —
`-u "$JIRA_EMAIL_X:$JIRA_PAT_X"`, never the values, and never `echo` either
variable.

The two numbers should differ by exactly the union rule and nothing else: the
board shows the source's list **∪** every issue that has a non-archived session
record in the workspace's repo, fetched individually when it dropped out of the
list. So an issue moved to Done in Jira, with a session on it, is still on the
board — in the Done column. Anything else is a discrepancy worth chasing.

**Paging.** The client walks `nextPageToken` at 100 issues a page, up to 50 pages,
and throws `JiraTruncatedError` rather than silently serving a partial board. An
epic with more than 100 children is the only real test of this; if the epic under
test is smaller, say so instead of claiming the paging works.

## Review statuses

`reviewStatuses` defaults to `["Ready for review"]` and is compared against
`issue.status` by exact name. The owner's per-issue `review` flag is the manual
override and lands the card in the same column. Both routes deserve a check,
because they fail differently: a status renamed in Jira quietly stops matching,
while the flag keeps working.

## Description rendering

Jira descriptions arrive as ADF and are flattened to plain text **inside the
connector** — paragraphs joined with blank lines, list items as `- ` — so the
board never sees tracker-shaped data. Open a card's drawer on an issue whose
description has headings, lists, links and code, and read the result. Raw ADF
JSON, `[object Object]`, or a missing list marker on the screen is a mapping bug,
and it also reaches the prefilled prompt through `{{description}}`.

## Freshness, polling and failure

- The board polls its source every `pollSeconds` (default 120), and also refreshes
  on `POST /api/workspaces/:id/refresh` and once whenever a session leaves the
  live set. The header shows `synced <n> ago` from `fetchedAt` and a refresh
  button.
- A source failure does **not** empty the board: the last good list is served with
  `sourceError` set, and the header shows `Showing the last good list. <message>`
  as a `role="alert"` banner. Induce it by pointing the scratch config's connector
  at a site that does not resolve, or by unsetting the credential variables for
  the server process only — the missing-credentials path is deliberate, and the
  dashboard still boots so the banner can explain itself.
- Confirm the stale list is still the **last good** one and that `fetchedAt` stops
  advancing. A banner over an empty board is a different bug from a banner over a
  stale board.

## The workspace switcher

A custom popover, not a `<select>`, because each row needs two lines:
`role="menu"` with one `role="menuitemradio"` per workspace, the active one
`aria-checked="true"`. Keyboard behaviour is in
[`web-and-a11y.md`](web-and-a11y.md). The active workspace is
remembered in `localStorage`, so switching away and reloading is a real clause.
Below a hairline sit "Add workspace…" and "Remove this workspace".

## Adding a workspace

The dialog collects name, epic key, repo (from the config — repos are file-only),
connector (existing, or "new" revealing id, site, email variable, token variable)
and review statuses as a comma-separated list. Submit is `POST /api/workspaces`.

Three outcomes, and all three are clauses:

| Input         | Expected                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Valid         | 201, the config file rewritten, the switcher selects the new workspace, and its board loads **without a server restart**                          |
| Invalid field | 400 with zod issues, each rendered next to the field its path names, with `aria-invalid` and `aria-describedby` pointing at a `role="alert"` note |
| Duplicate id  | 409, placed against the **name** field, because the id is derived from the name                                                                   |

Per-field placement is the part that breaks quietly. The server refuses either
against the request's own fields (`connector`, `newConnector.id`) or against the
configuration the request would produce (`workspaces.<id>.epic`,
`connectors.<id>.site`), and the dialog maps both onto its fields. Test at least
one of each shape — a bad epic key and a bad connector site — and check the
message lands on the right control rather than in the dialog's catch-all note at
the bottom.

**Diff the config file after every write.** Copy the scratch config before
submitting, diff it after, and read the diff:

- exactly one workspace (and at most one connector) added, nothing else touched;
- the file is valid JSON written atomically (tmp + rename), so a partially written
  file is a serious finding;
- `~` is expanded, not restored — a rewritten file carries absolute paths, by
  design;
- the schema is **strict**, so a key it does not know is a validation error rather
  than a silently applied default. `pollSecs` instead of `pollSeconds` must be
  refused, not accepted and ignored.

Then `QC_CONFIG=<scratch>/config.json npm run config:check` against the rewritten
file: what the server wrote must be what the server can read back.

## Removing a workspace

`DELETE /api/workspaces/:id` answers 204 and **deletes nothing else** — sessions,
worktrees and issue flags belong to the repo and survive, and another workspace
over the same repo still shows them. The confirmation dialog is supposed to say
that in plain words; read it and check it is true by re-adding the workspace and
seeing the sessions come back.

## The needs-you badge

`needsYouCount` is the size of the Needs you column. It renders as a header badge
inside a `role="status"` wrapper, becomes `(n) questionable choices` in
`document.title`, and repaints the favicon with an amber lamp. All three move
together or none of them is right; the title and the favicon `href` are readable
through an evaluate call and are the cheapest evidence of the three.
