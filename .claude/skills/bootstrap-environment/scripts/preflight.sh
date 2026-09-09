#!/usr/bin/env bash
# Prints one row per tool the dashboard shells out to, with ok / missing / warn
# and the reason, so a setup run starts from facts instead of the first crash.
set -uo pipefail

row() { printf '%-16s %-8s %s\n' "$1" "$2" "$3"; }

ver_ge() { # ver_ge 3.2 3.6 → true when $2 >= $1
  [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n1)" = "$1" ]
}

if command -v node >/dev/null 2>&1; then
  v=$(node --version | sed 's/^v//')
  if ver_ge 22.0.0 "$v"; then row node ok "v$v"; else row node warn "v$v, need >= 22"; fi
else
  row node missing "install Node 22+"
fi

if command -v npm >/dev/null 2>&1; then
  v=$(npm --version)
  if ver_ge 10.0.0 "$v"; then row npm ok "$v"; else row npm warn "$v, need >= 10"; fi
else
  row npm missing "comes with node"
fi

if command -v tmux >/dev/null 2>&1; then
  v=$(tmux -V | awk '{print $2}' | tr -d 'a-z')
  if ver_ge 3.2 "$v"; then row tmux ok "$v"; else row tmux warn "$v, need >= 3.2"; fi
else
  row tmux missing "apt install tmux"
fi

if command -v claude >/dev/null 2>&1; then
  row claude ok "$(claude --version 2>/dev/null | head -n1)"
else
  row claude missing "npm i -g @anthropic-ai/claude-code, then run claude once"
fi

for tool in git curl; do
  if command -v "$tool" >/dev/null 2>&1; then row "$tool" ok "$(command -v "$tool")"; else row "$tool" missing "install $tool"; fi
done

missing_build=""
for tool in python3 make g++; do
  command -v "$tool" >/dev/null 2>&1 || missing_build="$missing_build $tool"
done
if [ -z "$missing_build" ]; then row build-tools ok "python3 make g++"; else row build-tools warn "missing:$missing_build (node-pty fallback build)"; fi

if [ -n "${WSL_DISTRO_NAME:-}" ]; then
  if command -v cmd.exe >/dev/null 2>&1 && (cd /tmp && timeout 15 cmd.exe /c "code --version" >/dev/null 2>&1); then
    row editor ok "WSL: cmd.exe /c code --remote wsl+$WSL_DISTRO_NAME {{path}}"
  else
    row editor warn "WSL: Windows VS Code CLI not reachable via cmd.exe"
  fi
elif command -v code >/dev/null 2>&1; then
  row editor ok "code {{path}}"
else
  row editor warn "no code CLI on PATH; set editor.command in the config"
fi

if [ -r "$HOME/.claude/settings.json" ]; then
  if grep -q '"statusLine"' "$HOME/.claude/settings.json"; then
    row statusline ok "user statusLine will be chained"
  else
    row statusline warn "no statusLine in ~/.claude/settings.json (countdown still works, nothing to chain)"
  fi
else
  row statusline warn "~/.claude/settings.json not readable"
fi

cfg="${QC_CONFIG:-$HOME/.config/questionable-choices/config.json}"
if [ -r "$cfg" ]; then row config ok "$cfg"; else row config missing "copy config.example.json to $cfg"; fi

jira_vars=$(env | grep -E '^(JIRA|ATLASSIAN)[A-Z0-9_]*=' | cut -d= -f1 | tr '\n' ' ')
if [ -n "$jira_vars" ]; then row jira-env ok "$jira_vars"; else row jira-env warn "no JIRA_* / ATLASSIAN_* variables in this shell"; fi

port=4400
if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ":$port "; then
  row "port $port" warn "in use; change port in the config"
else
  row "port $port" ok "free"
fi
