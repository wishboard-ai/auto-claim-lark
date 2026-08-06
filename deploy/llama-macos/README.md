# Intel + AMD 显卡 Mac 上用 GPU 跑视觉模型（llama.cpp + Vulkan/MoltenVK）

给「Intel CPU + AMD 独显 + macOS」机器，用 **GPU** 跑 Qwen2.5-VL-3B 识别发票（替代 CPU 版 PaddleOCR）。
本方案已在真实机器（AMD Radeon Pro 5300 / 8GB RAM / macOS 26）**实测跑通**。

## 实测结论（重要）

- 该硬件上 llama.cpp 的 **Metal 后端不可用**：视觉段 `SIGSEGV`、语言段 GPU 看门狗超时（`kIOAccelCommandBufferCallbackErrorTimeout`），即使把图像 token 砍到 256、批大小砍到 128 仍在第一个命令缓冲就超时。
- ✅ **Vulkan（经 MoltenVK）可用**：语言模型上 GPU、视觉编码器留 CPU（`--no-mmproj-offload`）。热推理约 16–17s/张。
- 依赖全部用 **Homebrew** 安装，**无需 LunarG 图形化 Vulkan SDK**。

## 一键脚本

```bash
cd deploy/llama-macos && chmod +x start-llama.sh && ./start-llama.sh
```
它会：用 brew 装 `cmake vulkan-loader vulkan-headers molten-vk shaderc vulkan-tools` → 修复 CLT 的 SDK 头路径 → 用 `-DGGML_VULKAN=1 -DGGML_METAL=OFF` 编译（`-j2` 防 8GB OOM）→ 下载模型/mmproj → 启动 `llama-server`（OpenAI 兼容，:8080）。

首次编译很慢（Vulkan 着色器很多），且**务必 `-j2`**——满核并行会把 8GB 内存打爆导致 **系统崩溃重启**（实测踩过）。

## 手动步骤（脚本背后做的事）

```bash
# 依赖
brew install cmake vulkan-loader vulkan-headers molten-vk shaderc vulkan-tools
export VK_ICD_FILENAMES=$(find /usr/local -iname MoltenVK_icd.json | head -1)
export DYLD_LIBRARY_PATH=/usr/local/lib
vulkaninfo | grep deviceName        # 应看到 AMD Radeon ...

# CLT 的 clang 在 macOS 升级后默认找不到 SDK 的 C++ 头，需注入：
SDK=$(xcrun --show-sdk-path)
export CPLUS_INCLUDE_PATH=$SDK/usr/include/c++/v1
export CPATH=$SDK/usr/include

# 编译（Vulkan）
git clone https://github.com/ggml-org/llama.cpp ~/llama.cpp
cmake -S ~/llama.cpp -B ~/llama.cpp/build-vk -DGGML_VULKAN=1 -DGGML_METAL=OFF -DLLAMA_CURL=ON -DCMAKE_PREFIX_PATH=/usr/local
cmake --build ~/llama.cpp/build-vk --config Release -j 2

# 运行（视觉留 CPU、小 ubatch 防 GPU 超时）
~/llama.cpp/build-vk/bin/llama-server \
  -m ~/models/Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf \
  --mmproj ~/models/mmproj-Qwen2.5-VL-3B-Instruct-Q8_0.gguf \
  -ngl 99 --no-mmproj-offload -c 4096 -b 512 -ub 256 \
  --image-min-tokens 512 --image-max-tokens 512 --parallel 1 \
  --host 127.0.0.1 --port 8080
```

## 主服务 .env

```
OCR_PROVIDER=openai
OCR_BASE_URL=http://127.0.0.1:8080/v1
OCR_API_KEY=llama          # 任意非空（llama-server 不校验，但本项目需非空才算启用）
OCR_MODEL=qwen             # 任意；llama-server 用已加载的模型
```

## 开机自启（launchd，用户登录后启动）

给 llama-server 与机器人各写一份 LaunchAgent（示例见本目录部署过程；`~/run-llama-vk.sh` 里 `exec` 上面的 llama-server 命令并带上 `VK_ICD_FILENAMES`/`DYLD_LIBRARY_PATH`）：

```bash
launchctl load -w ~/Library/LaunchAgents/com.autoclaim.llama.plist   # GPU 模型服务
launchctl load -w ~/Library/LaunchAgents/com.autoclaim.lark.plist    # 机器人
launchctl list | grep autoclaim                                      # 状态
```
> 因无 sudo，用的是用户级 LaunchAgent（登录后启动），非 root 级 LaunchDaemon（开机预登录）。

## 调参

- 识别不准（密集小字）：把 `--image-min/max-tokens` 提到 768/1024（更准、更慢、更吃显存）。
- 报 GPU 超时：把 `-ub` 调更小（128）。
- 报显存不足：降 `-c`（如 2048）或图像 token。
- 4GB 显存偏小，属够用但不宽裕；速度约 16–17s/张（热）。
