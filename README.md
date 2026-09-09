# questionable-choices

Local dashboard that turns an issue-tracker epic into a board of Claude Code
sessions. Click an issue, a real `claude` session starts in tmux inside a git
worktree of the target repo; the browser shows the terminal and tracks what
the session is doing (working, waiting for permission, asked you a question,
your turn) through Claude Code hooks.

Design: [`docs/spec.md`](./docs/spec.md). Build order:
[`docs/plan.md`](./docs/plan.md).

Under construction.
