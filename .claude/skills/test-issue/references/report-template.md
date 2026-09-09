# Reporting — the requester report and `TEST-REPORT.md`

Read at Phase 7. One report, written twice: into the conversation, and into
`TEST-REPORT.md` in the repository root. The text is the same in both places.

Nothing is posted to any tracker. The dashboard's own non-goal (spec §1) is that
it does not write to Jira, and neither does its QA — the only artifacts are this
report and the evidence directory.

## `TEST-REPORT.md` overwrites the previous run

That is deliberate: one file, always the latest full run, so the next run has a
regression suite to read. It only works if the **previous** file was consumed in
Phase 1 first. If you have reached Phase 7 without reading it, go back and read
it now — its coverage table and its bug list are clauses you owe an answer on,
and overwriting them unanswered loses the only record they had.

`TEST-REPORT.md` is a tracked-tree file, not a scratch file. Commit it **only** if
the requester asked for a commit; otherwise leave it uncommitted and say so in
the handover, so nobody assumes it landed.

## Structure

```markdown
# Test report — <target> — <yyyy-mm-dd>

<VERDICT> — one sentence saying what that means.

## Environment

## Coverage

## Coverage added beyond the plan

## Bugs found

## Notes, not defects

## Not verified

## State left behind

## Handover
```

### Verdict — the first line

Exactly one of **PASS**, **PASS with gaps**, **FAIL**, **BLOCKED**, before anything
else. Any NOT TESTED clause makes it at best `PASS with gaps`. A `BLOCKED` run is
still written up: what blocked it, how far it got, what would unblock it, and
plainly that no verdict on the change was reached.

For a defect, the verdict line carries the **before → after** pair: where the
defect was observed before, and that it is gone after — or plainly that it could
not be reproduced.

### Environment

An inventory, not prose: instance mode (`dev` or `built`), the ports, the config
path the run used and the fact that it was a scratch copy, the repository HEAD,
the target repository and its HEAD, the browser driver, and the evidence directory
path.

### Coverage

One row per clause of the assembled plan. Never fold two clauses into one row.

| Id  | Clause | Source                          | Status     | Evidence                                           |
| --- | ------ | ------------------------------- | ---------- | -------------------------------------------------- |
| C1  | …      | `docs/spec.md` §5.3             | PASS       | browser — `<evidence dir>/c1-needs-you.png`        |
| C2  | …      | previous `TEST-REPORT.md` bug 3 | FAIL       | protocol — `<evidence dir>/c2-remove-worktree.txt` |
| C3  | …      | `README.md` "Using it" 4        | NOT TESTED | —                                                  |

- **Source** names where the clause came from: the issue or PR, a `docs/spec.md`
  section, a README bullet, `docs/verification.md`, the previous report, or the
  diff (marked as yours).
- **Status** is one of PASS / FAIL / NOT TESTED / COVERED-BY-AUTOMATION /
  NOT APPLICABLE.
- **Evidence** names the **layer** and the file: browser / protocol / machine /
  file / unit. A row whose evidence is a layer the clause's consumer does not use
  is not a PASS — see [`principles.md`](principles.md).

`NOT TESTED` needs a real reason: every route to the surface is blocked, or the
change cannot reach it. "The run was getting long" is not one, and neither is
"it needed a build".

`COVERED-BY-AUTOMATION` requires all four: you **read the assertions**, the test is
**not skipped**, you hold **a result** from running it yourself, and you **opened
the surface anyway**. A filename or a grep hit is none of these.

### Coverage added beyond the plan

Surfaces the diff reaches that no source named, and why you added them. This is
what separates testing from instruction-following; make it visible.

### Bugs found

One entry per defect, in this shape:

```markdown
### <n>. <symptom in one sentence>

- **Repro** — numbered steps from a clean start, including the instance mode.
- **Expected** — what the spec, the README or the issue says should happen, with the locator.
- **Observed** — what happened, with the evidence file.
- **Root cause** — `src/<path>.ts:<line>`, and what is wrong there. Omit the line entirely if it was not located; do not guess.
- **Impact** — who hits it, how often, what it costs, and whether it is latent or immediate.
- **Screenshots** — paths in the evidence directory.
```

A bug the change did not cause is still reported, marked **not caused by this
change**, so the next run inherits it.

### Notes, not defects

Surprising-but-by-design behaviour, and every entry from `docs/verification.md`
§ What still does not work that this run re-observed. Say for each whether it was
confirmed by experiment or inferred. This section is what stops the next run from
re-filing the same known facts as bugs.

### Not verified

What was skipped and why. The dev/built split belongs here whenever the run stayed
in one mode for something the other mode decides. So does anything the environment
could not produce — a permission prompt the CLI never raised, a tracker outage that
never happened.

### State left behind

An inventory: servers still running (ports and PIDs), tmux sessions, worktrees,
branches, files written outside the evidence directory, and whether
`TEST-REPORT.md` is committed. If Phase 8 ran clean, say so with the two
`git status --porcelain` comparisons that prove it.

### Handover

What a human should do next. On a **FAIL**, say plainly that the reader should
confirm the failure themselves before sending anyone to debug it — a false FAIL
costs more than a missed bug. Name anything that needs a decision rather than a
fix, and anything a second run should start from.

## The failure mode to avoid

Volume. A report nobody finishes reading is a report that changed nothing. Cut
layer-by-layer narration, cut the account of how testing was performed, cut
suggestions about how the issue was worded. Keep the coverage table complete and
everything else short.
