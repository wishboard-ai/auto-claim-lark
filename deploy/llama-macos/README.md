# Intel + AMD 显卡 Mac 上用 GPU 跑视觉模型（llama.cpp + Vulkan/MoltenVK）

给「Intel CPU + AMD 独显 + macOS」这类机器，用 **GPU** 跑 Qwen2.5-VL 之类视觉模型，替代 CPU 版 PaddleOCR。

## 为什么是这条路

- **Ollama**：Intel Mac 上对 AMD 显卡只用 CPU（官方未支持）。
- **LM Studio**：官方已不支持 Intel Mac。
- **stock llama.cpp Metal**：在「Intel+AMD」上被报输出损坏、走 PCIe 慢。
- ✅ **llama.cpp + Vulkan（经 MoltenVK）**：跨厂商的 GPU 路径，绕开上面的坑，是目前较可靠的选择。

## 前置：安装 Vulkan SDK（含 MoltenVK）

到 LunarG 下载并安装 macOS 版 Vulkan SDK：https://vulkan.lunarg.com/sdk/home#mac
安装后在终端执行（把路径换成你的 SDK 版本目录）：
```bash
source ~/VulkanSDK/<version>/setup-env.sh
vulkaninfo | head           # 能看到 AMD 显卡信息即 OK
```

## 一键构建并启动

```bash
cd deploy/llama-macos
chmod +x start-llama.sh
./start-llama.sh            # 首次：装 cmake/git → 克隆并编译 llama.cpp(Vulkan) → 拉取模型 → 起服务
# 服务： http://127.0.0.1:8080/v1   （OpenAI 兼容）
```

可用环境变量调整：
- `HF_REPO`：视觉模型 GGUF 仓库（默认 `ggml-org/Qwen2.5-VL-3B-Instruct-GGUF`，**请在 HuggingFace 上核对该仓库/量化是否存在**，不对就换一个，或改用本地权重）。
- `MODEL_GGUF` + `MMPROJ_GGUF`：用本地已下载的模型与视觉投影权重（设了就不走 HF）。
- `NGL`（默认 99，全部层上 GPU）、`CTX`（默认 4096，显存紧张设 2048）、`PORT`（默认 8080）。

## 让主服务使用它

项目根目录 `.env`：
```
OCR_PROVIDER=openai
OCR_BASE_URL=http://127.0.0.1:8080/v1
OCR_API_KEY=llama          # 任意非空
OCR_MODEL=qwen2.5vl        # 任意；llama-server 用已加载的模型
```
然后 `./start.sh` 起主服务即可。识别请求走本地 GPU 模型，字段由模型直接输出 JSON（比 PaddleOCR 规则准得多）。

> 我们代码里给 Ollama 写的「模型未拉取自动 pull」只在 11434 端口触发，指到 8080 的 llama-server 不受影响。

## 现实提醒（务必先小规模验证）

- **4GB 显存偏小**：3B 的 Q4 权重约 2.2GB，加视觉投影层+上下文可能吃紧。若报显存/OOM 或崩溃：把 `CTX` 降到 2048、或换更小的量化（如 Q4_K_S）、或把 `NGL` 调小让部分层回 CPU。
- **视觉编码器**可能仍在 CPU 上跑（llama.cpp 的多模态实现所限），但语言模型主体在 GPU，通常已明显更快。
- **实验性**：Intel+AMD Mac 的 GPU 加速属社区支持范围。若 Vulkan 输出异常，可尝试 KosmicKrisp 驱动（LunarG SDK 安装时勾选），或社区的 AMD-patched Metal 方案（ToshLLM）。
- 验证方式：`./start-llama.sh` 起来后，
  ```bash
  curl http://127.0.0.1:8080/v1/models
  ```
  能列出模型即服务正常；再用主服务发一张发票看识别与速度。

## 常驻（可选）

可仿照 `deploy/com.autoclaim.ocr.plist` 再写一份 launchd，把 `ProgramArguments` 指向本脚本；注意其中要能读到 `VULKAN_SDK` 环境变量（在 plist 的 `EnvironmentVariables` 里显式设置 SDK 路径与 `source` 后的 `PATH`/`DYLD_LIBRARY_PATH`）。
