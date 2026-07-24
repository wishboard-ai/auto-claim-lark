# auto-claim-lark · 飞书发票报销机器人

给机器人发一张发票图片 → 自动 OCR 识别（增值税发票 / 火车票 / 出租车票等）→ 自动填充并创建费用报销审批 → 回复识别结果与审批链接。

基于飞书官方 `@larksuiteoapi/node-sdk`，通过 **WebSocket 长连接**接收消息，**无需公网地址**。

```
用户发送发票图片
      │  im.message.receive_v1（长连接推送）
      ▼
机器人（本服务）
      ├─ 1. 下载图片（消息资源接口）
      ├─ 2. 识别发票（document_ai：vat/train/taxi，按序尝试）
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
   - 发票识别：`增值税发票识别`、`火车票识别`、`出租车发票识别`（document_ai 相关）
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
```

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

**一键启动（Windows，推荐）**：双击项目根目录的 `start.bat`。它会自动安装依赖、编译并以常驻方式运行（`node dist`），关闭窗口即停止。

命令行方式：

```bash
npm run build && npm start   # 编译后常驻运行（稳定，推荐本地/生产）
npm run dev                  # 开发模式（tsx watch 热重载，仅供开发调试）
```

> 注意：`npm run dev` 使用 `tsx watch` 热重载，适合改代码时用；直接「双击运行」请用 `start.bat` 或 `npm start`，避免 watch 模式在非交互窗口下退出。

启动后在飞书里单聊机器人、发送一张发票图片即可。

## 5. 支持的票种

按 `vat → train → taxi` 顺序尝试识别，命中即止：

- 增值税发票（专票 / 普票 / 电子发票）
- 火车票
- 出租车票

需要扩展其它票种（如机动车销售发票 `vehicle_invoice`、机票行程单等），在 `src/invoice/recognize.ts` 中新增识别器并注册即可（SDK `document_ai.v1` 已支持多种类型）。

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
    recognize.ts           分类 + 多票种识别（可插拔）
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
```

## 备注

- **幂等**：以 `message_id` 去重，避免长连接超时重推导致重复创建。
- **会话/去重为内存实现**：多实例部署时需替换为共享存储（如 Redis）。长连接为集群单点接收，单实例即可稳定运行。
- **票种分类**：飞书无统一票种分类接口，故按序调用各识别器（最多 3 次 API 调用）；可在 `recognizeInvoice` 的 `order` 参数中调整顺序或裁剪。
