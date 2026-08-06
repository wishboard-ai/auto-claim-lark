#!/usr/bin/env bash
# 在 Intel CPU + AMD 独显的 macOS 上，用 GPU（经 Vulkan/MoltenVK）跑视觉模型（llama.cpp）。
#
# 为什么用 Vulkan 而不是 Metal：Intel Mac 上官方 Ollama 只用 CPU、LM Studio 不支持 Intel Mac、
# 而 stock llama.cpp 的 Metal 后端在「Intel+AMD」上被报输出损坏。Vulkan(经 MoltenVK) 是更可靠的 GPU 路径。
#
# 启动一个 OpenAI 兼容服务（默认 :8080），主服务把 .env 指过去即可（provider=openai）：
#   OCR_PROVIDER=openai
#   OCR_BASE_URL=http://127.0.0.1:8080/v1
#   OCR_API_KEY=llama            # 任意非空
#   OCR_MODEL=qwen2.5vl          # 任意；llama-server 用已加载的模型
#
# 兼容 macOS 自带 bash 3.2：不使用 nounset/数组。
set -eo pipefail
cd "$(dirname "$0")"

LLAMA_DIR="${LLAMA_DIR:-$PWD/llama.cpp}"
PORT="${PORT:-8080}"
NGL="${NGL:-99}"                 # 尽量把所有层放到 GPU；显存不足可调小
CTX="${CTX:-4096}"               # 4GB 显存偏小时可设 2048
# 二选一的模型来源：
#   1) HF_REPO：由 llama-server 自动从 HuggingFace 拉取 GGUF（含 mmproj，视觉模型会自动带上）
#   2) MODEL_GGUF + MMPROJ_GGUF：使用本地已下载的权重
HF_REPO="${HF_REPO:-ggml-org/Qwen2.5-VL-3B-Instruct-GGUF}"
MODEL_GGUF="${MODEL_GGUF:-}"
MMPROJ_GGUF="${MMPROJ_GGUF:-}"

# 1) 构建依赖
command -v cmake >/dev/null 2>&1 || brew install cmake
command -v git   >/dev/null 2>&1 || brew install git

# 2) Vulkan(MoltenVK) 环境：优先用已 source 的 VULKAN_SDK，否则尝试常见安装位置
if [ -z "${VULKAN_SDK:-}" ]; then
  for p in "$HOME/VulkanSDK"/*/setup-env.sh /usr/local/setup-env.sh; do
    if [ -f "$p" ]; then
      # shellcheck disable=SC1090
      . "$p"
      break
    fi
  done
fi
if [ -z "${VULKAN_SDK:-}" ]; then
  echo "[Vulkan] 未检测到 Vulkan SDK。请先安装 LunarG macOS Vulkan SDK（含 MoltenVK）："
  echo "         https://vulkan.lunarg.com/sdk/home#mac"
  echo "         安装后在本终端执行： source <SDK目录>/setup-env.sh  再重跑本脚本。"
  exit 1
fi
echo "[Vulkan] VULKAN_SDK=$VULKAN_SDK"

# 3) 拉取并构建 llama.cpp（Vulkan 后端，关闭 Metal）
if [ ! -d "$LLAMA_DIR/.git" ]; then
  echo "[Build] 克隆 llama.cpp …"
  git clone https://github.com/ggml-org/llama.cpp "$LLAMA_DIR"
elif [ "${SKIP_UPDATE:-0}" != "1" ]; then
  echo "[Build] 更新 llama.cpp …"
  (cd "$LLAMA_DIR" && git pull --ff-only) || echo "[Build] 更新跳过。"
fi
if [ ! -x "$LLAMA_DIR/build/bin/llama-server" ] || [ "${REBUILD:-0}" = "1" ]; then
  echo "[Build] 编译 llama.cpp（Vulkan）… 首次较慢"
  cmake -S "$LLAMA_DIR" -B "$LLAMA_DIR/build" -DGGML_VULKAN=1 -DGGML_METAL=OFF -DLLAMA_CURL=ON
  cmake --build "$LLAMA_DIR/build" --config Release -j
fi

SERVER="$LLAMA_DIR/build/bin/llama-server"
[ -x "$SERVER" ] || { echo "[Build] 未找到 llama-server，构建可能失败。"; exit 1; }

# 4) 启动 OpenAI 兼容服务
echo "[Run] llama-server 监听 127.0.0.1:$PORT  ngl=$NGL ctx=$CTX"
if [ -n "$MODEL_GGUF" ]; then
  echo "[Run] 使用本地模型：$MODEL_GGUF  mmproj=${MMPROJ_GGUF:-<none>}"
  if [ -n "$MMPROJ_GGUF" ]; then
    exec "$SERVER" -m "$MODEL_GGUF" --mmproj "$MMPROJ_GGUF" -ngl "$NGL" -c "$CTX" --host 127.0.0.1 --port "$PORT"
  else
    exec "$SERVER" -m "$MODEL_GGUF" -ngl "$NGL" -c "$CTX" --host 127.0.0.1 --port "$PORT"
  fi
else
  echo "[Run] 从 HuggingFace 拉取：$HF_REPO（视觉模型会自动带上 mmproj）"
  exec "$SERVER" -hf "$HF_REPO" -ngl "$NGL" -c "$CTX" --host 127.0.0.1 --port "$PORT"
fi
