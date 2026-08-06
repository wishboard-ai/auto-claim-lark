#!/usr/bin/env bash
# 启动本地 PaddleOCR 服务（macOS / Linux）。
# 首次会创建虚拟环境并安装依赖（较慢，需联网下载 paddle 与 OCR 模型）。
# 自动选择受支持的较高 Python（paddlepaddle 2.6 支持到 3.12）。SKIP_UPDATE=1 跳过更新检查。
# 注意：macOS 自带 bash 3.2，不启用 -u(nounset) 以避免数组/变量展开误报 unbound
set -eo pipefail
cd "$(dirname "$0")"

# 选择 Python 解释器：优先 3.12 -> 3.11 -> 3.10 -> python3
PY="${PYTHON:-}"
if [ -z "$PY" ]; then
  for c in python3.12 python3.11 python3.10; do
    if command -v "$c" >/dev/null 2>&1; then PY="$c"; break; fi
  done
  [ -z "$PY" ] && PY="python3"
fi
echo "[Python] 使用解释器：$PY"
"$PY" -V || true

# 启动时检查更新（拉取最新代码；SKIP_UPDATE=1 可跳过）
if [ "${SKIP_UPDATE:-0}" != "1" ] && command -v git >/dev/null 2>&1 && [ -d ../.git ]; then
  echo "[更新] git pull --ff-only ..."
  (cd .. && git pull --ff-only) || echo "[更新] 跳过（离线/有本地改动/非快进）。"
fi

if [ ! -d .venv ]; then
  echo "[1/3] 创建虚拟环境 .venv ..."
  "$PY" -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate

echo "[2/3] 安装依赖（首次较慢）..."
pip install --upgrade pip >/dev/null
pip install -r requirements.txt

echo "[3/3] 启动服务： http://127.0.0.1:8000 （Ctrl+C 退出）"
exec uvicorn ocr_service:app --host 127.0.0.1 --port 8000
