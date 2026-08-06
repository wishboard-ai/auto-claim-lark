#!/usr/bin/env bash
# 飞书发票报销机器人 —— macOS / Linux 启动脚本（对应 Windows 的 start.bat）
# 用法：chmod +x start.sh && ./start.sh
set -euo pipefail

cd "$(dirname "$0")"

echo "============================================"
echo "   Feishu Invoice Reimbursement Bot"
echo "============================================"
echo

# 1) 依赖
if [ ! -d node_modules ]; then
  echo "[1/4] 首次运行，安装依赖…"
  npm install
else
  echo "[1/4] 依赖已就绪。"
fi

# 2) 配置检查
if [ ! -f .env ]; then
  echo
  echo "[错误] 未找到配置文件 .env"
  echo "       请先复制 .env.example 为 .env 并填写相应值。"
  exit 1
fi

# 3) 本地 OCR：检查 Ollama 是否就绪（仅当 .env 指向本地时给出提示）
if grep -Eq '^OCR_BASE_URL=.*(localhost|127\.0\.0\.1):11434' .env 2>/dev/null; then
  if ! command -v ollama >/dev/null 2>&1; then
    echo
    echo "[提示] .env 使用本地 Ollama，但未检测到 ollama 命令。"
    echo "       请先安装：https://ollama.com/download  然后 ollama pull qwen2.5vl:7b"
  else
    # 确保 Ollama 服务在跑（macOS 安装后通常已常驻；这里尽力拉起）
    if ! curl -fsS http://localhost:11434/api/tags >/dev/null 2>&1; then
      echo "[提示] 正在后台启动 Ollama 服务…"
      (ollama serve >/tmp/ollama-serve.log 2>&1 &) || true
      sleep 2
    fi
  fi
fi

# 4) 编译并运行
echo "[2/4] 编译 TypeScript…"
npm run build

echo "[3/4] 启动机器人。保持本窗口开启即在线（Ctrl+C 退出）。"
echo
echo "[4/4] 运行中…"
node dist/src/index.js

echo
echo "机器人已停止。若非本意，请查看上方日志。"
