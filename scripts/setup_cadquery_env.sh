#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"
VENV_DIR="${APP_DIR}/.venv-cadquery"

cd "${APP_DIR}"

if [[ ! -d "${VENV_DIR}" ]]; then
  "${PYTHON_BIN}" -m venv "${VENV_DIR}"
fi

"${VENV_DIR}/bin/python" -m pip install --upgrade pip
"${VENV_DIR}/bin/python" -m pip install -r requirements-cadquery.txt

cat > "${APP_DIR}/.env.local.example" <<EOF
HOST=127.0.0.1
PORT=3101
CADQUERY_PYTHON=${VENV_DIR}/bin/python
FREECAD_CMD=freecadcmd
CODEX_BIN=codex
AICAD_CODEX_MODEL=gpt-6-astra
AICAD_CODEX_REASONING_EFFORT=medium
AICAD_LLM_PROVIDER=codex
# AICAD_CONVERSATION_DIR=${HOME}/桌面/aicad建模反馈
# AICAD_CADQUERY_SCRIPT_DIR=${HOME}/桌面/cadquery底层脚本库
EOF

if [[ ! -f "${APP_DIR}/.env.local" ]]; then
  cp "${APP_DIR}/.env.local.example" "${APP_DIR}/.env.local"
fi

echo "CadQuery environment is ready: ${VENV_DIR}/bin/python"
