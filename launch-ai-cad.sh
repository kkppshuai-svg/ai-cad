#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-3101}"
LOG_DIR="${APP_DIR}/logs"
PID_FILE="${APP_DIR}/.ai-cad.pid"
ENV_FILE="${APP_DIR}/.env.local"

mkdir -p "${LOG_DIR}"

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "${ENV_FILE}"
  set +a
fi

is_running() {
  if [[ -f "${PID_FILE}" ]]; then
    local pid
    pid="$(cat "${PID_FILE}")"
    if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
      return 0
    fi
    rm -f "${PID_FILE}"
    return 1
  else
    return 1
  fi
}

is_responding() {
  local url="$1"
  curl -fsS "${url}/api/status" >/dev/null 2>&1
}

status_json() {
  local url="$1"
  curl -fsS "${url}/api/status" 2>/dev/null || true
}

is_current_version() {
  local url="$1"
  local status
  status="$(status_json "${url}")"
  [[ "${status}" == *'"cadqueryPython"'* && "${status}" == *'"codexModel"'* ]] || return 1
  [[ "${status}" != *'"openscadBin"'* && "${status}" != *'"sample"'* ]] || return 1
  [[ "${status}" != *'"provider": "duckduckgo"'* && "${status}" != *'"provider":"duckduckgo"'* ]] || return 1
  curl -fsS "${url}/" 2>/dev/null | grep -q 'ratingPanel'
}

open_url() {
  local url="$1"
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "${url}" >/dev/null 2>&1 &
  else
    printf 'AI CAD 已启动：%s\n' "${url}"
  fi
}

pick_port() {
  local port
  for port in "${PORT}" 3101 3102 3103 3110; do
    local url="http://${HOST}:${port}"
    local status
    status="$(status_json "${url}")"
    if [[ -z "${status}" ]] || is_current_version "${url}"; then
      echo "${port}"
      return 0
    fi
  done
  echo "${PORT}"
}

cd "${APP_DIR}"

PORT="$(pick_port)"
URL="http://${HOST}:${PORT}"

if is_current_version "${URL}"; then
  open_url "${URL}"
  exit 0
fi

if is_running; then
  kill "$(cat "${PID_FILE}")" 2>/dev/null || true
  rm -f "${PID_FILE}"
  sleep 0.3
fi

if ! is_running; then
  if command -v setsid >/dev/null 2>&1; then
    setsid -f env PORT="${PORT}" node server.js >"${LOG_DIR}/ai-cad.log" 2>&1
    sleep 0.2
    pgrep -f "node server.js" | tail -n 1 > "${PID_FILE}" || true
  else
    nohup env PORT="${PORT}" node server.js >"${LOG_DIR}/ai-cad.log" 2>&1 &
    echo "$!" > "${PID_FILE}"
  fi
fi

for _ in {1..40}; do
  if is_current_version "${URL}"; then
    open_url "${URL}"
    exit 0
  fi
  sleep 0.25
done

rm -f "${PID_FILE}"
printf 'AI CAD 启动失败，请查看日志：%s\n' "${LOG_DIR}/ai-cad.log"
exit 1
