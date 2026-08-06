#!/usr/bin/env bash
# 在 Intel CPU + AMD 独显的 macOS 上，用 GPU（Vulkan / MoltenVK）跑视觉模型（llama.cpp）。
# 本脚本为「已在真实机器（AMD Radeon Pro 5300 / 8GB RAM / macOS 26）验证跑通」的配方。
#
# 关键结论（来自实测）：
#  - 该硬件上 llama.cpp 的 **Metal 后端跑不了**：视觉段 SIGSEGV、语言段 GPU 看门狗超时。
#  - **Vulkan（经 MoltenVK）可用**：语言模型上 GPU、视觉编码器留 CPU（--no-mmproj-offload）。
#  - 依赖全部用 Homebrew 安装，**无需 LunarG 图形化 SDK**。
#
# 兼容 macOS bash 3.2：不使用 nounset/数组。
set -eo pipefail
cd "$(dirname "$0")"

export PATH=/usr/local/bin:$PATH
LLAMA_DIR="${LLAMA_DIR:-$HOME/llama.cpp}"
MODELS="${MODELS:-$HOME/models}"
PORT="${PORT:-8080}"
# 视觉模型 GGUF（含 mmproj）
MODEL_FILE="${MODEL_FILE:-Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf}"
MMPROJ_FILE="${MMPROJ_FILE:-mmproj-Qwen2.5-VL-3B-Instruct-Q8_0.gguf}"
HF_BASE="https://huggingface.co/ggml-org/Qwen2.5-VL-3B-Instruct-GGUF/resolve/main"
IMG_TOKENS="${IMG_TOKENS:-512}"   # 每张图像的视觉token（越大越准、越慢/越吃显存）

# 1) 依赖（cmake + Vulkan/MoltenVK 工具链，均来自 Homebrew）
for f in cmake vulkan-loader vulkan-headers molten-vk shaderc vulkan-tools; do
  brew list "$f" >/dev/null 2>&1 || brew install "$f"
done

ICD="$(/usr/bin/find /usr/local -iname MoltenVK_icd.json 2>/dev/null | head -1)"
[ -n "$ICD" ] || ICD=/usr/local/etc/vulkan/icd.d/MoltenVK_icd.json
export VK_ICD_FILENAMES="$ICD"
export DYLD_LIBRARY_PATH=/usr/local/lib

# 2) SDK 头修复：macOS 升级后 CLT 的 clang 默认找不到 SDK 里的 C++ 头，显式注入
SDK="$(xcrun --show-sdk-path 2>/dev/null)"
if [ -n "$SDK" ]; then
  export CPLUS_INCLUDE_PATH="$SDK/usr/include/c++/v1"
  export CPATH="$SDK/usr/include"
fi

# 3) 拉取并用 Vulkan 后端编译 llama.cpp（关闭 Metal；-j2 避免 8GB 机器 OOM 崩溃）
[ -d "$LLAMA_DIR/.git" ] || git clone https://github.com/ggml-org/llama.cpp "$LLAMA_DIR"
if [ ! -x "$LLAMA_DIR/build-vk/bin/llama-server" ] || [ "${REBUILD:-0}" = "1" ]; then
  echo "[Build] 配置并编译 llama.cpp（Vulkan）… 首次很慢，-j2 防止内存打爆"
  cmake -S "$LLAMA_DIR" -B "$LLAMA_DIR/build-vk" -DGGML_VULKAN=1 -DGGML_METAL=OFF -DLLAMA_CURL=ON -DCMAKE_PREFIX_PATH=/usr/local
  cmake --build "$LLAMA_DIR/build-vk" --config Release -j 2
fi

# 4) 下载模型（缺失时）
mkdir -p "$MODELS"
[ -f "$MODELS/$MODEL_FILE" ]  || curl -fL -o "$MODELS/$MODEL_FILE"  "$HF_BASE/$MODEL_FILE"
[ -f "$MODELS/$MMPROJ_FILE" ] || curl -fL -o "$MODELS/$MMPROJ_FILE" "$HF_BASE/$MMPROJ_FILE"

# 5) 启动 OpenAI 兼容服务
#   --no-mmproj-offload：视觉编码器留 CPU（否则 Metal/MoltenVK 下 clip 会崩）
#   -ub 256：小 ubatch，避免大命令缓冲触发 GPU 看门狗超时
echo "[Run] llama-server(Vulkan) :$PORT  img_tokens=$IMG_TOKENS"
exec "$LLAMA_DIR/build-vk/bin/llama-server" \
  -m "$MODELS/$MODEL_FILE" --mmproj "$MODELS/$MMPROJ_FILE" \
  -ngl 99 --no-mmproj-offload -c 4096 -b 512 -ub 256 \
  --image-min-tokens "$IMG_TOKENS" --image-max-tokens "$IMG_TOKENS" --parallel 1 \
  --host 127.0.0.1 --port "$PORT"
