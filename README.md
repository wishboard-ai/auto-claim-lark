# auto-claim-lark · 飞书发票报销机器人

给机器人发一张发票图片 → 自动 OCR 识别（增值税发票 / 火车票 / 出租车票等）→ 自动填充并创建费用报销审批 → 回复识别结果与审批链接。

基于飞书官方 `@larksuiteoapi/node-sdk`，通过 **WebSocket 长连接**接收消息，**无需公网地址**。

```
用户发送发票图片
      │  im.message.receive_v1（长连接推送）
      ▼
机器人（本服务）
      ├─ 1. 下载图片（消息资源接口）
      ├─ 2. 识别发票（阿里云百炼 通义千问 VL，一次调用识别票种并抽取字段）
      ├─ 3. 字段映射（发票字段 → 审批表单控件，配置驱动）
      ├─ 4. 创建费用报销审批实例（approval.v4.instance.create）
      └─ 5. 回复结果卡片（含「查看审批」链接）
```

## ⚠️ 关于「用户手动提交」的重要说明

飞书审批 OpenAPI **没有**「先创建草稿、由用户在审批中手动提交」的能力。`approval.v4.instance.create` 一经调用即**直接发起并进入审批流**（无草稿态、无 `/drafts` 接口）。

因此本项目提供两种提交模式（`.env` 中的 `SUBMIT_MODE`）：

| 模式 | 行为 | 人工关卡 |
| --- | --- | --- |
| `confirm`（默认） | 识别后先在聊天中展示结果，用户回复「**确认**」后才创建并提交审批 | ✅ 提交前人工复核 |
| `direct` | 识别后直接创建并提交审批 | ❌ 无 |

> 说明：无论哪种模式，一旦创建，审批即已提交。`confirm` 模式把「人工确认」前置到了聊天里（回复「确认/取消」），这是在 API 限制下最接近「人工把关后再进入审批」的方案。
>
> 如果确实需要「打开预填好的审批发起页、由用户点提交」，需改用飞书 **applink 预填发起页** 方案（本项目未内置，可作为后续扩展）。

## 1. 前置条件：飞书开放平台配置

在 [open.feishu.cn](https://open.feishu.cn) 你的企业自建应用中：

1. **启用机器人能力**：应用能力 → 添加「机器人」。
2. **开通权限**（权限管理，按关键词搜索并申请）：
   - 接收单聊消息：`获取用户发给机器人的单聊消息`（im.message.p2p_msg:readonly）
   - 读取消息资源（图片）：`获取消息中的资源文件`（im:resource）
   - 发送消息：`以应用的身份发送消息`（im:message:send_as_bot）
   - 审批：`查看审批`（读取审批定义）+ `发起审批 / 创建审批实例`（approval 相关）
3. **事件订阅 → 使用长连接**：订阅事件 `im.message.receive_v1`（消息与群组 → 接收消息）。长连接模式无需配置回调地址。
4. **创建版本并发布应用**，确保权限生效、机器人可用。

> 发起报销的申请人 = 给机器人发图片的用户；请确保该用户对目标审批有发起权限。

## 2. 安装与配置

```bash
npm install
cp .env.example .env      # Windows: copy .env.example .env
```

编辑 `.env`：

```
FEISHU_APP_ID=cli_aae9aaa7beb8dce3
FEISHU_APP_SECRET=<你的应用密钥>
APPROVAL_CODE=<费用报销审批定义 code>
SUBMIT_MODE=confirm       # confirm | direct
LOG_LEVEL=info
FEISHU_DOMAIN=feishu       # 国际版填 lark

# 发票识别（阿里云百炼 通义千问 VL，OpenAI 兼容接口）——必填 API Key
LLM_API_KEY=<你的百炼 API Key>
LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
OCR_MODEL=qwen-vl-max      # 发票识别模型（推荐 qwen-vl-max）；文案生成用 LLM_MODEL（如 qwen-flash）
```

> 发票识别（OCR）与文案生成默认复用同一个百炼 `LLM_API_KEY` / `LLM_BASE_URL`，只是识别用 `OCR_MODEL`（默认 `qwen-vl-max`）、文案用 `LLM_MODEL`。如需分开，可另配 `OCR_API_KEY` / `OCR_BASE_URL`。
>
> 识别模型建议用 `qwen-vl-max`（或 `qwen3-vl-plus`）：票种分类与价税合计更准。**不建议 `qwen-vl-ocr`**——它偏纯文本抽取，票种分类不稳（实测会把增值税发票误判为出租车票）。

> `.env` 含密钥，已在 `.gitignore` 中忽略，请勿提交。

## 3. 获取 approval_code 与表单控件 ID

- **approval_code**：飞书「审批」管理后台打开该审批，URL 中的 `definitionCode`；填入 `.env` 的 `APPROVAL_CODE`。
- **表单控件 ID**：运行下面的脚本，打印审批表单的每个控件（widgetId → 名称 [类型]）：

```bash
npm run inspect:approval -- <approval_code>
# 或已在 .env 配置 APPROVAL_CODE 时：
npm run inspect:approval
```

把打印出的 `widgetId` 与类型填入 `config/field-mapping.json`，替换 `REPLACE_*` 占位符：

```json
{
  "title": "费用报销-{typeLabel}",
  "fields": [
    { "widgetId": "widget17xxxx", "widgetType": "amount", "source": "amount" },
    { "widgetId": "widget17yyyy", "widgetType": "date",   "source": "date" },
    { "widgetId": "widget17zzzz", "widgetType": "input",  "source": "sellerName" }
  ]
}
```

- `source` 可选：`amount / date / sellerName / buyerName / invoiceNo / taxAmount / summary / typeLabel`，或 `raw` 中的原始字段名；也支持模板如 `"{sellerName}-{invoiceNo}"`。
- `widgetType` 需与审批控件类型一致。日期控件若报格式错误，可给该字段加 `"valueFormat": "datetime"`（输出 `YYYY-MM-DDT00:00:00+08:00`）。

> 未配置（仍为 `REPLACE_`）的字段会被跳过并打印告警；所有字段都未配置时，机器人会提示先配置映射。

## 4. 运行

**一键启动（Windows，推荐）**：双击项目根目录的 `start.bat`。它会**检查更新（git pull）→ 安装/更新依赖 → 编译 → 常驻运行**（`node dist`），关闭窗口即停止。设环境变量 `SKIP_UPDATE=1` 可跳过更新检查。

命令行方式：

```bash
npm run build && npm start   # 编译后常驻运行（稳定，推荐本地/生产）
npm run dev                  # 开发模式（tsx watch 热重载，仅供开发调试）
```

> 注意：`npm run dev` 使用 `tsx watch` 热重载，适合改代码时用；直接「双击运行」请用 `start.bat` 或 `npm start`，避免 watch 模式在非交互窗口下退出。
>
> **自更新**：`start.sh` / `start.bat` 每次启动都会 `git pull --ff-only` 拉取最新代码并重装依赖、重新编译；离线或有本地改动时会自动跳过、沿用当前代码。

启动后在飞书里单聊机器人、发送一张发票图片即可。

## 4.1 在 macOS 部署（苹果一体机，含全本地识别）

Apple Silicon（M 系列）的统一内存 + Metal 加速非常适合本地跑视觉模型，可实现 **OCR + 文案全本地、零 API 成本**。

> **关于显卡**：Ollama 会**自动使用可用 GPU**（Apple Silicon 的 Metal、NVIDIA 的 CUDA），无 GPU 时才回退 CPU——无需任何设置，也**不要**去设 `CUDA_VISIBLE_DEVICES=""` 之类禁用 GPU 的变量。`qwen2.5vl:3b` 这类模型在有显卡的机器上会自动走显卡加速。`start.sh` 也会在缺 Ollama/模型时自动安装并拉取。

**步骤**：

```bash
# 1) 安装 Node 与 Ollama（Homebrew）
brew install node
brew install --cask ollama       # 或到 https://ollama.com/download 下载

# 2) 拉取视觉模型（统一内存 ≥16GB 建议 7b，更准；较小内存用 3b）
ollama pull qwen2.5vl:7b

# 3) 配置 .env（本地 Ollama）
cp .env.example .env
#   OCR_BASE_URL=http://localhost:11434/v1
#   OCR_API_KEY=ollama
#   OCR_MODEL=qwen2.5vl:7b
#   （文案生成也可复用同模型：LLM_BASE_URL 同上、LLM_MODEL=qwen2.5vl:7b）
#   仍需填 FEISHU_APP_ID/SECRET、APPROVAL_CODE

# 4) 启动
chmod +x start.sh && ./start.sh   # 一键：装依赖→编译→（必要时拉起 ollama）→运行
```

**常驻 / 开机自启（含每次启动检查更新）**：用 `deploy/com.autoclaim.lark.plist`（launchd）。它经 `start.sh` 启动，因此每次开机/重启都会自动 `git pull` + 装依赖 + 编译再运行。改好其中 `{{PROJECT_DIR}}` 与 `PATH`（Apple Silicon 用 `/opt/homebrew/bin`，Intel Mac 用 `/usr/local/bin`）后：

```bash
mkdir -p logs && chmod +x start.sh
cp deploy/com.autoclaim.lark.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.autoclaim.lark.plist   # 启动并开机自启
# 停止： launchctl unload ~/Library/LaunchAgents/com.autoclaim.lark.plist
```

> 若用 PaddleOCR 全本地方案，OCR 是独立进程，另用 `deploy/com.autoclaim.ocr.plist` 让它一起开机自启。
> 想临时关闭「启动时检查更新」，把 plist 里 `SKIP_UPDATE` 设为 `1`（或运行时 `SKIP_UPDATE=1 ./start.sh`）。

> Intel 款 iMac（无 Apple Silicon）跑本地视觉模型较慢，建议改用下面的 **PaddleOCR 全本地方案**。

### 4.2 全本地方案 B：PaddleOCR（适合低配 / Intel / 无 GPU，如 8GB iMac）

不依赖大模型，用轻量 OCR 引擎，CPU 即可跑，内存占用小、零 API 成本。

```bash
# 1) 启动本地 PaddleOCR 服务（首次会建 venv、装依赖、下载模型）
cd ocr && chmod +x start-ocr.sh && ./start-ocr.sh    # 自动选用 Python 3.12/3.11/3.10

# 2) 主服务 .env 指向本地 OCR
#   OCR_PROVIDER=paddle
#   OCR_BASE_URL=http://localhost:8000
#   （标题生成 LLM_* 可留空 → 回退模板；仍需填 FEISHU_*、APPROVAL_CODE）

# 3) 另开一个终端启动主服务
./start.sh
```

字段抽取为基于 OCR 文本的规则匹配，不同版式可能需微调，详见 `ocr/README.md`。

## 5. 支持的票种

由通义千问 VL（默认 `qwen-vl-max`）**一次调用**识别票种并抽取字段：

- 增值税发票（专票 / 普票 / 电子发票）
- 火车票
- 出租车票

需要扩展其它票种或调整抽取字段，只需修改 `src/invoice/recognize.ts` 中的提示词（`EXTRACT_PROMPT`）与 `type` 取值即可，无需为每个票种单独接入接口。

## 目录结构

```
src/
  index.ts                 入口：加载配置、启动长连接
  config.ts                环境变量加载与校验
  lark.ts                  飞书 Client / WSClient 工厂
  logger.ts                轻量日志
  types.ts                 共享类型（RecognizedInvoice 等）
  invoice/
    download.ts            下载消息中的图片资源
    recognize.ts           发票识别分发（provider: openai 多模态大模型 / paddle 本地OCR）
  approval/
    fieldMapping.ts        发票字段 → 审批表单（配置驱动）
    submit.ts              创建审批实例
  handlers/
    messageHandler.ts      消息编排（去重、识别、确认、创建、回复）
    session.ts             confirm 模式的待确认会话（内存）
  reply/
    cards.ts               结果 / 确认卡片
scripts/
  inspect-approval.ts      查看审批定义的表单控件 ID
config/
  field-mapping.json       字段映射配置（需填入 widgetId）
ocr/                       本地 PaddleOCR 微服务（OCR_PROVIDER=paddle 时使用）
  ocr_service.py           FastAPI：图片→PaddleOCR→规则抽取→JSON
  requirements.txt         Python 依赖
  start-ocr.sh             一键启动（建 venv、装依赖、跑服务）
deploy/
  com.autoclaim.lark.plist  机器人：macOS launchd 常驻/开机自启（经 start.sh，含自更新）
  com.autoclaim.ocr.plist   PaddleOCR 服务：launchd 常驻/开机自启（经 ocr/start-ocr.sh）
```

## 备注

- **幂等**：以 `message_id` 去重，避免长连接超时重推导致重复创建。
- **会话/去重为内存实现**：多实例部署时需替换为共享存储（如 Redis）。长连接为集群单点接收，单实例即可稳定运行。
- **票种识别**：由 qwen-vl-ocr 单次调用完成票种判断与字段抽取（每张图片 1 次 API 调用）；提示词与字段在 `src/invoice/recognize.ts` 的 `EXTRACT_PROMPT` 中调整。
