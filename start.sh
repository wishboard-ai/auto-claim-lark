#!/usr/bin/env bash
# 飞书发票报销机器人 —— macOS / Linux 启动脚本（对应 Windows 的 start.bat）
# 用法：chmod +x start.sh && ./start.sh
# 每次启动会「检查更新」：git pull + 装依赖 + 编译，再运行。
# 设环境变量 SKIP_UPDATE=1 可跳过更新检查（如开发调试或离线）。
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

# 本地 OCR：若 .env 指向本地 Ollama，尽力确保服务在跑（仅提示，不阻断）
if grep -Eq '^OCR_BASE_URL=.*(localhost|127\.0\.0\.1):11434' .env 2>/dev/null; then
  if ! command -v ollama >/dev/null 2>&1; then
    echo "[提示] .env 使用本地 Ollama，但未检测到 ollama 命令。请先安装并拉取模型。"
  elif ! curl -fsS http://localhost:11434/api/tags >/dev/null 2>&1; then
    echo "[提示] 正在后台启动 Ollama 服务…"
    (ollama serve >/tmp/ollama-serve.log 2>&1 &) || true
    sleep 2
  fi
fi

# 3) 编译并运行
echo "[2/3] 编译 TypeScript…"
npm run build

echo "[3/3] 启动机器人。保持进程存活即在线（Ctrl+C 退出）。"
echo
exec node dist/src/index.js
