#!/usr/bin/env bash
# 启动本地 PaddleOCR 服务（macOS / Linux）。
# 首次会创建虚拟环境并安装依赖（较慢，需联网下载 paddle 与 OCR 模型）。
set -euo pipefail
cd "$(dirname "$0")"

PY="${PYTHON:-python3}"

if [ ! -d .venv ]; then
  echo "[1/3] 创建虚拟环境 .venv …"
  "$PY" -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate

echo "[2/3] 安装依赖（首次较慢）…"
pip install --upgrade pip >/dev/null
pip install -r requirements.txt

echo "[3/3] 启动服务： http://127.0.0.1:8000 （Ctrl+C 退出）"
exec uvicorn ocr_service:app --host 127.0.0.1 --port 8000
