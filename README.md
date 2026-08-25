# auto-claim-lark · 飞书发票报销机器人

先选择「借款核销」或「费用报销」→ 发送实际消费发票 → 自动 OCR 识别 → 自动填充并创建对应审批。借款核销会关联本人已通过的付款申请，并支持同一笔借款分批核销。

> 支持图片与 PDF 电子发票：收到 PDF 时优先读取其自带的文字层直接识别（更快/更省/更准）；仅当是扫描件/图片型 PDF（无文字层）时，才自动把首页栅格化为图片走视觉识别。

基于飞书官方 `@larksuiteoapi/node-sdk`，通过 **WebSocket 长连接**接收消息，**无需公网地址**。

```
用户选择借款核销 / 费用报销，再发送发票
      │  im.message.receive_v1（长连接推送）
      ▼
机器人（本服务）
      ├─ 1. 下载图片（消息资源接口）
      ├─ 2. 识别发票（阿里云百炼 通义千问 VL，一次调用识别票种并抽取字段）
      ├─ 3. 字段映射（发票字段 → 审批表单控件，配置驱动）
      ├─ 4. 借款核销时选择仍有可核销余额的付款申请（实际借款时间取 end_time）
      ├─ 5. 按所选模式创建借款核销或费用报销审批实例
      └─ 6. 回复结果卡片（含「查看审批」链接）
```

开启借款核销后，系统会查询当前用户已审批通过且仍有可核销余额的付款申请。每次提交只占用本次发票合计金额，审批通过后计入已核销金额；剩余金额可在以后继续核销。

## ⚠️ 关于「用户手动提交」的重要说明

飞书审批 OpenAPI **没有**「先创建草稿、由用户在审批中手动提交」的能力。`approval.v4.instance.create` 一经调用即**直接发起并进入审批流**（无草稿态、无 `/drafts` 接口）。

因此本项目提供两种提交模式（`.env` 中的 `SUBMIT_MODE`）：

| 模式 | 行为 | 人工关卡 |
| --- | --- | --- |
| `confirm`（默认） | 先选办理类型；识别后累加发票，填写事由并预览，回复「确认」后提交对应审批 | ✅ 提交前人工复核 |
| `direct` | 先选办理类型；费用报销识别后直接提交，借款核销仍强制选择付款申请并确认 | 借款核销时有 |

> 说明：无论哪种模式，一旦创建，审批即已提交。`confirm` 模式把「人工确认」前置到了聊天里：识别 → 回复事由 → **先预览、可改类别/事由、再回复「确认」才提交**（回复「取消」放弃），这是在 API 限制下最接近「人工把关后再进入审批」的方案。
>
> **核销类型**由模型结合「发票内容 + 你填写的事由」自动选择（候选见 `config/field-mapping.json` 的 `options`）；预览时可回复某个类别名直接改写。
>
> 如果确实需要「打开预填好的审批发起页、由用户点提交」，需改用飞书 **applink 预填发起页** 方案（本项目未内置，可作为后续扩展）。

## 1. 前置条件：飞书开放平台配置

在 [open.feishu.cn](https://open.feishu.cn) 你的企业自建应用中：

1. **启用机器人能力**：应用能力 → 添加「机器人」。
2. **开通权限**（权限管理，按关键词搜索并申请）：
   - 接收单聊消息：`获取用户发给机器人的单聊消息`（im.message.p2p_msg:readonly）
   - 读取消息资源（图片）：`获取消息中的资源文件`（im:resource）
   - 发送消息：`以应用的身份发送消息`（im:message:send_as_bot）
   - 审批：`查看审批`（读取审批定义）+ `发起审批 / 创建审批实例` + `订阅审批实例状态`（approval 相关）
3. **事件订阅 → 使用长连接**：订阅事件 `im.message.receive_v1`（消息与群组 → 接收消息）；启用自动核销时再订阅 `approval.instance.status_changed_v4`（审批实例状态变更）。长连接模式无需配置回调地址。
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
APPROVAL_CODE=75DCE71F-7160-4966-9DE5-D4B0E3E34A9B
EXPENSE_APPROVAL_CODE=08835DC3-456D-4EC8-BC60-D4433588821C
SUBMIT_MODE=confirm       # confirm | direct
LOAN_WRITE_OFF_ENABLED=true
LOAN_APPROVAL_CODE=FC505937-DA1D-471E-AC90-13C7AEB306B7
LOAN_WRITE_OFF_LEDGER_PATH=data/loan-writeoff-ledger.json
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

### 2.1 自动借款核销

设置 `LOAN_WRITE_OFF_ENABLED=true` 后：

1. 用户先回复「借款核销」，上传实际消费发票并填写核销事由；机器人按申请人查询 `LOAN_APPROVAL_CODE` 下近 `LOAN_LOOKBACK_DAYS` 天已通过且仍有余额的付款申请。付款申请审批定义的管理员可查询所有申请人的未结束付款申请，普通用户仍只能查询本人申请。超过飞书单次查询上限的回看范围会自动拆成不超过 30 天的窗口，并自动处理分页。
2. 只有一笔可核销借款时自动关联；有多笔时展示审批编号、借款金额、剩余金额、事由和实际借款日期，由用户回复序号选择；管理员的选择卡片还会标出申请人。
3. 实际借款时间严格取付款申请审批实例的 `end_time`，并写入借款核销“费用明细 → 日期”字段；核销事由自动带上原付款申请编号。
4. 提交时按本次发票合计金额占用余额；如果超过剩余可核销金额则拒绝提交。审批通过后该笔金额转为已核销，剩余部分仍可再次发起核销；拒绝、撤回、删除或撤销通过后释放本次占用金额。
5. 台账默认保存在 `data/loan-writeoff-ledger.json`，已被 Git 忽略。生产部署请持久化并备份此文件。

飞书开放平台还需完成两项配置：

- 在事件订阅中添加“审批实例状态变更”；长连接模式无需公网回调地址。
- 给应用开通订阅/读取审批实例所需权限并发布新版本。机器人启动时会调用 `approval.v4.approval.subscribe` 订阅目标审批定义，并调用 `approval.v4.instance.subscription` 限定为应用管理的审批实例；若订阅失败，日志会明确告警，此时提交前查重仍生效，但审批通过后不会自动变更为已核销。

付款申请审批定义默认为 `FC505937-DA1D-471E-AC90-13C7AEB306B7`，借款核销审批定义由 `APPROVAL_CODE` 配置（当前为 `75DCE71F-7160-4966-9DE5-D4B0E3E34A9B`），费用报销审批定义由 `EXPENSE_APPROVAL_CODE` 配置（当前为 `08835DC3-456D-4EC8-BC60-D4433588821C`）。

### 2.2 发票检重

机器人在费用报销和借款核销之间共用一套发票检重规则：

1. 同一会话重复发送同一张发票时，识别完成后立即提示并拒绝加入。
2. 已由机器人成功创建过费用报销或借款核销审批的发票，会写入 `INVOICE_USAGE_LEDGER_PATH`（默认 `data/invoice-usage-ledger.json`），以后在任一流程中都不能再次使用。
3. 创建审批前会再次原子校验并预占发票，避免不同会话同时提交同一张发票。明确创建失败时释放预占；网络超时等结果不确定时保留预占，防止服务端已创建成功却再次提交。
4. 优先用规范化后的发票号码生成指纹；号码缺失时使用票种、日期、金额、商家、摘要等字段的哈希。台账已被 Git 忽略，生产部署请持久化并备份。

“已使用”以成功创建审批实例为准，即使该审批后来被拒绝或撤回，也不会自动释放发票。如确需重新使用，应由管理员核实后维护台账。检重台账只能覆盖启用该功能后由本机器人创建的审批；由于旧审批表单不一定保存可检索的发票号码，无法可靠地自动追溯上线前的历史发票。

### 2.3 监听「非机器人直接发起」的报销/核销审批（外部审批发票扫描）

如果有人不走机器人、直接在飞书里发起费用报销或借款核销审批，默认机器人是**收不到**其发票、也不会计入检重台账的（详见 2.2）。开启本功能后，机器人会实时监听这两类审批：在实例**创建(PENDING)/通过(APPROVED)**时，自动读取审批表单里「图片/附件」控件中的发票，下载→OCR→按指纹写入同一份检重台账（`status=submitted`），此后这些发票在机器人流程里也不能再被重复使用。

开启方式（`.env`）：

```
EXTERNAL_INVOICE_SCAN_ENABLED=true
EXTERNAL_INVOICE_SCAN_SCOPE=INVOLVED_APPROVAL   # 含他人直接发起的实例（默认）；MANAGED_APPROVAL 仅机器人自建
```

飞书开放平台需要额外确认：

1. **事件**：事件订阅里已添加「审批实例状态变更」`approval.instance.status_changed_v4`（长连接无需公网回调）。这与自动借款核销所需事件相同。
2. **订阅范围**：机器人启动时会自动订阅 `APPROVAL_CODE`（借款核销）与 `EXPENSE_APPROVAL_CODE`（费用报销）两个审批定义，并将实例事件订阅范围设为 `INVOLVED_APPROVAL`（放开到「参与范围内的全部实例」，才能收到他人直接发起的实例事件）。
3. **读取权限**：应用需能对**他人发起**的审批实例调用 `approval.v4.instance.get` 读取表单（下载发票）。请确认应用具备读取目标审批实例的权限（通常应用为该审批定义订阅方/管理员）。若权限不足，`instance.get` 会失败，日志会告警，但不影响聊天内报销与查重。

行为与限制：

- **触发时机**：创建(PENDING)时即入账，尽早堵住「他人已发起、别人又拿同一张发票走机器人」的并发窗口；APPROVED 再补扫一次以防漏。按 `instance_code` 幂等，机器人自建实例（已在台账）会自动跳过。
- **释放策略**：与机器人流程一致——一旦入账即视为已用，审批后续被拒绝/撤回**不会**自动释放。
- **成本**：每条相关审批都会下载并 OCR 其附件，量大时有 API 成本；无「图片/附件」控件的审批无法取得发票（会跳过）。
- 历史（开启前）的审批仍需用 `scripts/backfill-usage-ledger.ts` 一次性回填（见备注）。

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
  "title": "借款核销-{typeLabel}",
  "fields": [
    { "widgetId": "widget17xxxx", "widgetType": "amount", "source": "amount" },
    { "widgetId": "widget17yyyy", "widgetType": "date",   "source": "loanApprovedDate" },
    { "widgetId": "widget17zzzz", "widgetType": "input",  "source": "sellerName" }
  ]
}
```

- `source` 可选：`amount / date / sellerName / buyerName / invoiceNo / invoiceCode / checkCode / taxAmount / summary / typeLabel`，或 `raw` 中的原始字段名；也支持模板如 `"{sellerName}-{invoiceNo}"`。借款核销需换来源时可配置 `loanSource`（当前日期字段用它读取付款申请 `end_time` 转换出的 `loanApprovedDate`）。
- 单选项可用 `optionsByMode.loan_writeoff` / `optionsByMode.expense` 分别配置；只属于某个审批的字段可在 `modes` 中限定流程类型。
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

启动后在飞书里单聊机器人，先回复「借款核销」或「费用报销」，再发送发票图片或 PDF。

## 4.4 每天定时检查更新并自动重启（Windows 计划任务）

除了「每次启动时」检查更新外，还可以让机器人**每天早上 08:00 自动检查更新**：有更新就 `git pull` + 装依赖 + 编译，然后**后台重启**机器人；没有更新则不打扰当前实例。

一次性注册（当前用户、登录时运行，无需管理员）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-daily-update.ps1
# 自定义时间： -At 07:30 ；移除： -Unregister
```

- 计划任务名：`AutoClaimLark-DailyUpdate`（可在「任务计划程序」里看到）。
- 更新逻辑脚本：`scripts\update-and-restart.ps1`
  - `-CheckOnly` 只检查不改动（测试用）；`-Force` 即使无更新也强制重启一次。
  - 重启采用**后台运行**（`scripts\run-bot.cmd`，隐藏窗口），输出写入 `logs\bot.out.log`；更新过程写入 `logs\update.log`。
  - 停止时按命令行匹配 `dist\src\index.js` 定位 node 进程；因此**同一时间只保留一个实例**（若你另开了 `start.bat` 前台窗口，08:00 有更新时会被这个后台实例接管）。

手动跑一次 / 查看状态：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\update-and-restart.ps1        # 立即检查+按需更新重启
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\update-and-restart.ps1 -CheckOnly   # 只看有没有更新
Get-ScheduledTask -TaskName AutoClaimLark-DailyUpdate | Get-ScheduledTaskInfo               # 下次运行时间等
```

> 说明：
> - 任务以「用户已登录」为条件运行；机器需在 08:00 处于开机且已登录状态（错过时间会在可用时补跑）。
> - 若工作区有**未提交的本地改动**且与远端更新冲突，`git pull --ff-only` 会失败并跳过（沿用当前代码），与 `start.bat` 的自更新行为一致。
> - 依赖本地 Ollama 时，请确保 Ollama 已随开机自启（安装器默认如此）；后台重启不会再走 `start.bat` 的 Ollama 拉起步骤。

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

### 4.3 全本地方案 C：Intel + AMD 显卡 Mac 用 GPU 跑视觉模型（llama.cpp + Vulkan）

若想用 AMD 独显加速、直接跑视觉大模型（识别更准，免规则调参），见 `deploy/llama-macos/README.md`：
用 **llama.cpp + Vulkan(MoltenVK)** 起一个 OpenAI 兼容服务，`.env` 设 `OCR_PROVIDER=openai` + `OCR_BASE_URL=http://127.0.0.1:8080/v1` 即可。属实验性方案（4GB 显存偏小、需装 Vulkan SDK），请先小规模验证。

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
    dedup.ts               发票指纹与跨费用报销/借款核销持久化检重台账
    instanceScan.ts        外部审批扫描：读取审批实例表单→下载发票→识别→写检重台账
  approval/
    fieldMapping.ts        发票字段 → 审批表单（配置驱动）
    submit.ts              创建审批实例
  handlers/
    messageHandler.ts      消息编排（去重、识别、确认、创建、回复）
    session.ts             confirm 模式的待确认会话（内存）
  writeoff/
    loans.ts               查询/解析已通过付款申请（end_time → 实际借款时间）
    ledger.ts              JSON 持久化核销台账与状态迁移
    approvalHandler.ts     审批结果事件 → 自动核销/释放
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
- **会话/消息去重为内存实现**：发票使用台账已持久化为 JSON；多实例部署时仍需将会话、消息去重及发票台账替换为带原子约束的共享存储（如 Redis/数据库）。长连接为集群单点接收，单实例即可稳定运行。
- **票种识别**：由 qwen-vl-ocr 单次调用完成票种判断与字段抽取（每张图片 1 次 API 调用）；提示词与字段在 `src/invoice/recognize.ts` 的 `EXTRACT_PROMPT` 中调整。
