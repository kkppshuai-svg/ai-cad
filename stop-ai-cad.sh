#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="${APP_DIR}/.ai-cad.pid"

if [[ ! -f "${PID_FILE}" ]]; then
  echo "AI CAD 没有运行。"
  exit 0
fi

PID="$(cat "${PID_FILE}")"
if [[ -n "${PID}" ]] && kill -0 "${PID}" 2>/dev/null; then
  kill "${PID}"
  echo "AI CAD 已停止。"
else
  echo "AI CAD 进程不存在。"
fi

rm -f "${PID_FILE}"
