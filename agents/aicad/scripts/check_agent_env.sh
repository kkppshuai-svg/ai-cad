#!/usr/bin/env bash
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

ok=0
warn=0

check_cmd() {
  if command -v "$1" >/dev/null 2>&1; then
    printf 'ok: %s -> %s\n' "$1" "$(command -v "$1")"
  else
    printf 'warn: missing command %s\n' "$1"
    warn=$((warn + 1))
  fi
}

printf 'AI-CAD root: %s\n' "$ROOT"

check_cmd node
check_cmd python3
check_cmd codex
check_cmd freecadcmd

if [ -x "${CADQUERY_PYTHON:-.venv-cadquery/bin/python}" ]; then
  printf 'ok: CADQUERY_PYTHON -> %s\n' "${CADQUERY_PYTHON:-.venv-cadquery/bin/python}"
else
  printf 'warn: CadQuery Python not found at %s\n' "${CADQUERY_PYTHON:-.venv-cadquery/bin/python}"
  warn=$((warn + 1))
fi

if [ -f package.json ] && [ -f server.js ]; then
  printf 'ok: AI-CAD app files present\n'
else
  printf 'error: run this script from a complete AI-CAD checkout\n'
  ok=1
fi

if [ "$warn" -gt 0 ]; then
  printf 'completed with %s warning(s)\n' "$warn"
fi

exit "$ok"
