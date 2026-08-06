#!/usr/bin/env bash
# 飞书发票报销机器人 —— macOS / Linux 启动脚本（对应 Windows 的 start.bat）
# 用法：chmod +x start.sh && ./start.sh
# 每次启动会「检查更新」：git pull + 装依赖 + 编译，再运行。
# 若 .env 使用本地 Ollama：自动安装 Ollama（缺失时）、拉起服务、并拉取所需模型。
# 设环境变量 SKIP_UPDATE=1 可跳过 git 更新检查。
set -euo pipefail

cd "$(dirname "$0")"

echo "============================================"
echo "   Feishu Invoice Reimbursement Bot"
echo "============================================"
echo

SKIP_UPDATE="${SKIP_UPDATE:-0}"

# 0) 启动时检查更新（拉取最新代码）
if [ "$SKIP_UPDATE" != "1" ] && command -v git >/dev/null 2>&1 && [ -d .git ]; then
  echo "[更新] git pull --ff-only …"
  git pull --ff-only || echo "[更新] 跳过（离线/有本地改动/非快进），沿用当前代码。"
fi

# 1) 依赖：更新模式下每次 npm install（幂等，已最新则很快）；否则仅首次装
if [ "$SKIP_UPDATE" != "1" ] || [ ! -d node_modules ]; then
  echo "[1/3] 安装/更新依赖…"
  npm install
else
  echo "[1/3] 依赖已就绪。"
fi

# 2) 配置检查
if [ ! -f .env ]; then
  echo
  echo "[错误] 未找到配置文件 .env"
  echo "       请先复制 .env.example 为 .env 并填写相应值。"
  exit 1
fi

# ---------- 本地 Ollama 自动准备（仅当 .env 指向本地 Ollama 时） ----------

# 读取 .env 中某个键的值（去掉行内注释与首尾空白/引号）
envval() {
  local v=""
  v="$(grep -E "^$1=" .env 2>/dev/null | tail -n1 | cut -d= -f2- || true)"
  v="${v%%#*}"
  v="$(printf '%s' "$v" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//; s/^["'"'"']//; s/["'"'"']$//')"
  printf '%s' "$v"
}

is_local_ollama() { case "$1" in *localhost:11434*|*127.0.0.1:11434*) return 0;; *) return 1;; esac; }

ensure_ollama_installed() {
  command -v ollama >/dev/null 2>&1 && return 0
  echo "[Ollama] 未检测到 ollama，尝试自动安装…"
  if [ "$(uname)" = "Darwin" ]; then
    if command -v brew >/dev/null 2>&1; then
      brew install --cask ollama || true
    else
      echo "[Ollama] 未安装 Homebrew，无法自动安装。请到 https://ollama.com/download 手动安装。"
    fi
  elif [ "$(uname)" = "Linux" ]; then
    echo "[Ollama] 使用官方脚本安装（curl | sh）…"
    curl -fsSL https://ollama.com/install.sh | sh || true
  fi
  command -v ollama >/dev/null 2>&1
}

ensure_ollama_serving() {
  curl -fsS http://localhost:11434/api/tags >/dev/null 2>&1 && return 0
  echo "[Ollama] 启动服务…"
  (ollama serve >/tmp/ollama-serve.log 2>&1 &) || true
  local i
  for i in $(seq 1 20); do
    curl -fsS http://localhost:11434/api/tags >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "[Ollama] 服务未就绪（超时），请检查 /tmp/ollama-serve.log。"
  return 1
}

ensure_model() {
  local m="$1"
  [ -z "$m" ] && return 0
  if ollama list 2>/dev/null | awk 'NR>1{print $1}' | grep -qx "$m"; then
    echo "[Ollama] 模型已就绪：$m"
  else
    echo "[Ollama] 拉取模型：$m（首次较慢）…"
    ollama pull "$m" || echo "[Ollama] 拉取失败：$m，可稍后手动执行 ollama pull $m"
  fi
}

OCR_PROVIDER_V="$(envval OCR_PROVIDER)"; OCR_PROVIDER_V="${OCR_PROVIDER_V:-openai}"
OCR_BASE_V="$(envval OCR_BASE_URL)"
LLM_BASE_V="$(envval LLM_BASE_URL)"
OCR_MODEL_V="$(envval OCR_MODEL)"
LLM_MODEL_V="$(envval LLM_MODEL)"
LLM_KEY_V="$(envval LLM_API_KEY)"
OCR_EFF_BASE="${OCR_BASE_V:-$LLM_BASE_V}"

NEED_MODELS=()
NEED_OLLAMA=0
# 识别走本地 Ollama（provider=openai 且有效 base 指向本地）
if [ "$OCR_PROVIDER_V" != "paddle" ] && is_local_ollama "$OCR_EFF_BASE"; then
  NEED_OLLAMA=1
  [ -n "$OCR_MODEL_V" ] && NEED_MODELS+=("$OCR_MODEL_V")
fi
# 标题生成走本地 Ollama（LLM base 本地且已配置 key/model）
if is_local_ollama "$LLM_BASE_V" && [ -n "$LLM_KEY_V" ] && [ -n "$LLM_MODEL_V" ]; then
  NEED_OLLAMA=1
  NEED_MODELS+=("$LLM_MODEL_V")
fi

if [ "$NEED_OLLAMA" = "1" ]; then
  echo "[Ollama] .env 使用本地 Ollama，检查运行环境与模型…"
  if ensure_ollama_installed && ensure_ollama_serving; then
    if [ "${#NEED_MODELS[@]}" -gt 0 ]; then
      for m in $(printf '%s\n' "${NEED_MODELS[@]}" | sort -u); do
        ensure_model "$m"
      done
    fi
  else
    echo "[Ollama] 环境未就绪，识别可能失败。请手动安装/启动 Ollama 后重试。"
  fi
fi

# paddle 模式：检查本地 PaddleOCR 服务是否就绪（仅提示，不阻断）
if [ "$OCR_PROVIDER_V" = "paddle" ]; then
  PBASE="${OCR_BASE_V:-http://localhost:8000}"
  if curl -fsS "${PBASE%/}/health" >/dev/null 2>&1; then
    echo "[PaddleOCR] 本地 OCR 服务已就绪：$PBASE"
  else
    echo "[PaddleOCR] 本地 OCR 服务（$PBASE）未就绪！请另开终端启动： cd ocr && ./start-ocr.sh"
    echo "            或用 deploy/com.autoclaim.ocr.plist 设为开机自启。否则识别会连接失败。"
  fi
fi

# ---------- 编译并运行 ----------
echo "[2/3] 编译 TypeScript…"
npm run build

echo "[3/3] 启动机器人。保持进程存活即在线（Ctrl+C 退出）。"
echo
exec node dist/src/index.js
