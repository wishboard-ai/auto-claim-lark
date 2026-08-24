import * as lark from '@larksuiteoapi/node-sdk';
import { AppConfig } from '../config';
import { logger } from '../logger';
import { RecognizedInvoice } from '../types';
import { downloadImage, downloadFile } from '../invoice/download';
import { pdfFirstPageToImage, extractPdfText, hasUsableText, isPdf } from '../invoice/pdf';
import { recognizeInvoice, recognizeInvoiceFromText, QuotaExceededError, OcrNotConfiguredError } from '../invoice/recognize';
import { buildApprovalForm, FormOverrides, getCategoryOptionNames } from '../approval/fieldMapping';
import { createApprovalInstance } from '../approval/submit';
import { addItem, getPending, clearPending, setDraft, CartItem, Draft } from './session';
import { addedCard, successCard, previewCard } from '../reply/cards';
import { generateContent } from '../llm';
import { uploadApprovalFile } from '../approval/uploadImage';

const CONFIRM_WORDS = ['确认', '提交', 'confirm', 'ok', 'y', 'yes', '是', '好'];
const CANCEL_WORDS = ['取消', '放弃', 'cancel', 'n', 'no', '否'];

const HELP_TEXT =
  '你好，我是发票报销助手 🧾\n发送发票图片或 PDF（增值税发票 / 火车票 / 出租车票），可连续发送多张累加到同一张报销单；\n发完后回复本次「报销事由」（例如：1月客户拜访交通费），我会生成预览，回复「确认」后再提交，或回复「取消」放弃。';

export function makeMessageHandler(client: lark.Client, cfg: AppConfig) {
  // 幂等去重
  const processed = new Map<string, number>();
  const DEDUP_TTL_MS = 60 * 60 * 1000;
  function seenBefore(messageId: string): boolean {
    const now = Date.now();
    for (const [k, t] of processed) if (now - t > DEDUP_TTL_MS) processed.delete(k);
    if (processed.has(messageId)) return true;
    processed.set(messageId, now);
    return false;
  }

  // 进入会话欢迎语节流
  const welcomed = new Map<string, number>();
  const WELCOME_TTL_MS = 30 * 60 * 1000;

  // 每个用户一条串行队列：消息按「到达顺序」逐条处理，不同用户之间仍并行。
  // 作用：① 多张发票严格按发送顺序累加；② 避免「报销事由」抢在图片识别完成前被处理
  //      （否则会误判为无待办报销单而回复帮助语，导致对话像被“中断”）。
  const userChains = new Map<string, Promise<void>>();
  function enqueue(key: string, task: () => Promise<void>): void {
    const prev = userChains.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(task);
    userChains.set(key, next);
    void next.finally(() => {
      if (userChains.get(key) === next) userChains.delete(key);
    });
  }

  async function sendCard(chatId: string, card: string): Promise<void> {
    await client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, content: card, msg_type: 'interactive' },
    });
  }
  async function sendText(chatId: string, text: string): Promise<void> {
    await client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, content: JSON.stringify({ text }), msg_type: 'text' },
    });
  }

  function draftToOverrides(draft: Draft): FormOverrides {
    return { reason: draft.reason, title: draft.title, contents: draft.contents, category: draft.category };
  }

  /** 计算 LLM 文案与类别，产出待确认草稿（不创建审批）。 */
  async function buildDraft(items: CartItem[], reason: string): Promise<Draft> {
    const invoices = items.map((i) => i.invoice);
    const gen = await generateContent(cfg, invoices, reason, getCategoryOptionNames());
    if (gen) {
      logger.info(`LLM 生成标题：${gen.title}`);
      if (gen.category) logger.info(`LLM 选择报销类别：${gen.category}`);
    }
    return { reason, title: gen?.title, contents: gen?.contents, category: gen?.category };
  }

  /** 展示「提交前预览/确认」卡片（不创建审批）。 */
  async function showPreview(chatId: string, items: CartItem[], draft: Draft): Promise<void> {
    const invoices = items.map((i) => i.invoice);
    const { title, categoryLabel } = buildApprovalForm(invoices, draftToOverrides(draft), []);
    await sendCard(chatId, previewCard(invoices, title, categoryLabel, draft.reason, getCategoryOptionNames()));
  }

  /** 用草稿实际创建审批：上传图片 → 构建表单 → 创建 → 回复结果卡片。 */
  async function submitDraft(
    chatId: string,
    openId: string,
    items: CartItem[],
    draft: Draft
  ): Promise<void> {
    const invoices = items.map((i) => i.invoice);
    // 上传素材：图片 → 「图片」控件；原始 PDF → 「附件」控件（失败不阻断）
    const imageCodes: string[] = [];
    const attachmentCodes: string[] = [];
    for (const it of items) {
      if (it.imageBuffer) {
        const code = await uploadApprovalFile(cfg, it.imageBuffer, `invoice.${it.imageExt || 'jpg'}`, 'image');
        if (code) imageCodes.push(code);
      }
      if (it.fileBuffer) {
        const code = await uploadApprovalFile(cfg, it.fileBuffer, it.fileName || 'invoice.pdf', 'attachment');
        if (code) attachmentCodes.push(code);
      }
    }
    const { form, title, categoryLabel } = buildApprovalForm(
      invoices,
      draftToOverrides(draft),
      imageCodes,
      attachmentCodes
    );
    if (form.length === 0) {
      await sendText(
        chatId,
        '字段映射尚未配置。请运行 npm run inspect:approval 获取控件ID并填入 config/field-mapping.json。'
      );
      return;
    }
    try {
      const { instanceLink } = await createApprovalInstance(client, cfg, openId, form, title);
      await sendCard(chatId, successCard(invoices, instanceLink, title, categoryLabel));
    } catch (e) {
      logger.error('创建审批失败', e);
      await sendText(chatId, `创建审批失败：${(e as Error).message}`);
    }
  }

  function imgExt(buf: Buffer): string {
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
    if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50) return 'png';
    if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF') return 'webp';
    return 'jpg';
  }

  async function handleImage(
    chatId: string,
    openId: string | undefined,
    messageId: string,
    content: string
  ): Promise<void> {
    const imageKey = JSON.parse(content).image_key as string;
    logger.info(`收到图片消息（messageId=${messageId}），开始下载…`);
    const buffer = await downloadImage(client, messageId, imageKey);
    logger.info(`图片已下载：${buffer.length} 字节`);
    await recognizeAndCollect(chatId, openId, buffer);
  }

  async function handleFile(
    chatId: string,
    openId: string | undefined,
    messageId: string,
    content: string
  ): Promise<void> {
    const meta = JSON.parse(content) as { file_key?: string; file_name?: string };
    const fileName = meta.file_name || '';
    if (!meta.file_key) return;
    const isPdfName = /\.pdf$/i.test(fileName);
    logger.info(`收到文件消息（messageId=${messageId}, name=${fileName}），开始下载…`);
    const fileBuf = await downloadFile(client, messageId, meta.file_key);
    logger.info(`文件已下载：${fileBuf.length} 字节`);

    if (!isPdfName && !isPdf(fileBuf)) {
      await sendText(chatId, '暂不支持该文件类型。请发送发票图片，或 PDF 格式的电子发票。');
      return;
    }

    // 优先读取 PDF 文字层：文本型 PDF 直接按文本识别（更快/更省/更准，无需栅格化）。
    // 注意：原始 PDF 作为「附件」提交；栅格化仅在无文字层时用于识别、不作为提交内容。
    const pdfText = await extractPdfText(fileBuf);
    let invoice: RecognizedInvoice | null;

    if (hasUsableText(pdfText)) {
      logger.info(`PDF 含文字层（${pdfText.replace(/\s+/g, '').length} 字），按文本识别…`);
      invoice = await recognizeGuarded(chatId, () => recognizeInvoiceFromText(cfg, pdfText));
    } else {
      // 无文字层（扫描件/图片型 PDF）→ 栅格化首页仅用于视觉识别（不上传）。
      logger.info('PDF 无可用文字层，栅格化首页后走视觉识别…');
      let imageBuf: Buffer;
      try {
        imageBuf = await pdfFirstPageToImage(fileBuf);
        logger.info(`PDF 已转为图片用于识别：${imageBuf.length} 字节`);
      } catch (e) {
        logger.error('PDF 转图片失败', e);
        await sendText(chatId, `PDF 解析失败：${(e as Error).message}\n可尝试改发发票截图/图片。`);
        return;
      }
      invoice = await recognizeGuarded(chatId, () => recognizeInvoice(cfg, imageBuf));
    }
    if (!invoice) return;

    // 原始 PDF 以「附件」形式进入审批（不进图片控件）。
    const attachName = /\.pdf$/i.test(fileName) ? fileName : 'invoice.pdf';
    await finalizeInvoice(chatId, openId, invoice, { fileBuffer: fileBuf, fileName: attachName });
  }

  /** 识别一张发票图片并按模式加入报销单 / 直接创建（图片消息用）。 */
  async function recognizeAndCollect(
    chatId: string,
    openId: string | undefined,
    buffer: Buffer
  ): Promise<void> {
    const invoice = await recognizeGuarded(chatId, () => recognizeInvoice(cfg, buffer));
    if (!invoice) return;
    await finalizeInvoice(chatId, openId, invoice, { imageBuffer: buffer });
  }

  /** 执行识别并处理额度/未配置类错误（已处理则回复并返回 null，交由上层中止）。 */
  async function recognizeGuarded(
    chatId: string,
    recognize: () => Promise<RecognizedInvoice>
  ): Promise<RecognizedInvoice | null> {
    try {
      return await recognize();
    } catch (e) {
      if (e instanceof QuotaExceededError) {
        await sendText(
          chatId,
          '发票识别额度已用尽或账户欠费，暂时无法识别 😥\n请联系管理员在阿里云百炼（DashScope）控制台确认 qwen-vl-ocr 的额度 / 账户余额后再试。'
        );
        return null;
      }
      if (e instanceof OcrNotConfiguredError) {
        await sendText(
          chatId,
          '尚未配置发票识别服务。请在 .env 中填写百炼 API Key（LLM_API_KEY，或单独的 OCR_API_KEY）后重启服务。'
        );
        return null;
      }
      throw e;
    }
  }

  /** 识别结果落地：校验 → 按模式加入报销单或直接创建。
   *  media：图片消息给 imageBuffer（进「图片」控件）；PDF 给 fileBuffer+fileName（进「附件」控件）。 */
  async function finalizeInvoice(
    chatId: string,
    openId: string | undefined,
    invoice: RecognizedInvoice,
    media?: { imageBuffer?: Buffer; fileBuffer?: Buffer; fileName?: string }
  ): Promise<void> {
    if (invoice.type === 'unknown') {
      await sendText(chatId, '未能识别其中的发票信息，请确认是清晰的增值税发票 / 火车票 / 出租车票（图片或 PDF）。');
      return;
    }
    if (!openId) {
      await sendText(chatId, '无法获取你的用户身份（open_id），无法发起审批。');
      return;
    }
    const item: CartItem = { invoice };
    if (media?.imageBuffer) {
      item.imageBuffer = media.imageBuffer;
      item.imageExt = imgExt(media.imageBuffer);
    }
    if (media?.fileBuffer) {
      item.fileBuffer = media.fileBuffer;
      item.fileName = media.fileName;
    }
    if (cfg.submitMode === 'direct') {
      const draft = await buildDraft([item], '');
      await submitDraft(chatId, openId, [item], draft);
    } else {
      const claim = addItem(openId, item);
      await sendCard(chatId, addedCard(claim.items.map((i) => i.invoice)));
    }
  }

  async function handleText(
    chatId: string,
    openId: string | undefined,
    content: string
  ): Promise<void> {
    const raw = String(JSON.parse(content).text ?? '').trim();
    const lower = raw.toLowerCase();

    if (openId && CANCEL_WORDS.includes(lower)) {
      clearPending(openId);
      await sendText(chatId, '已取消本次报销。');
      return;
    }
    const pending = openId ? getPending(openId) : undefined;
    if (!openId || !pending || pending.items.length === 0) {
      await sendText(chatId, HELP_TEXT);
      return;
    }

    // 阶段二：已生成预览，等待「确认」或修改
    if (pending.draft) {
      if (CONFIRM_WORDS.includes(lower)) {
        const items = pending.items;
        const draft = pending.draft;
        clearPending(openId);
        await submitDraft(chatId, openId, items, draft);
        return;
      }
      // 回复某个合法类别名 → 仅改类别并重新预览（无需再调用 LLM）
      if (getCategoryOptionNames().includes(raw)) {
        const draft: Draft = { ...pending.draft, category: raw };
        setDraft(openId, draft);
        await showPreview(chatId, pending.items, draft);
        return;
      }
      // 其他文字 → 作为新的报销事由，重新整理并再次预览
      const draft = await buildDraft(pending.items, raw);
      setDraft(openId, draft);
      await showPreview(chatId, pending.items, draft);
      return;
    }

    // 阶段一：收集完成，首次回复事由 → 生成预览（不直接提交）
    if (CONFIRM_WORDS.includes(lower) || raw === '') {
      await sendText(chatId, '请先回复本次报销的事由（例如：1月客户拜访交通费），我会生成预览，确认后再提交。');
      return;
    }
    const draft = await buildDraft(pending.items, raw);
    setDraft(openId, draft);
    await showPreview(chatId, pending.items, draft);
  }

  async function onChatEntered(event: any): Promise<void> {
    const chatId: string | undefined = event?.chat_id;
    if (!chatId) return;
    const now = Date.now();
    const last = welcomed.get(chatId);
    if (last && now - last < WELCOME_TTL_MS) return;
    welcomed.set(chatId, now);
    try {
      await sendText(chatId, HELP_TEXT);
    } catch (e) {
      logger.warn('发送欢迎语失败：', (e as Error).message);
    }
  }

  async function onMessage(event: any): Promise<void> {
    const message = event?.message;
    const openId: string | undefined = event?.sender?.sender_id?.open_id;
    const chatId: string | undefined = message?.chat_id;
    const messageId: string | undefined = message?.message_id;
    const msgType: string | undefined = message?.message_type;
    if (!chatId || !messageId) return;
    if (seenBefore(messageId)) {
      logger.debug(`忽略重复推送的消息 ${messageId}`);
      return;
    }

    // 立即返回以在 3 秒内完成 ack；实际处理进入「每用户串行队列」按到达顺序执行。
    // 既避免长连接超时(>3s)重推重复处理，又保证顺序：事由不会抢在图片识别完成前处理、
    // 多张发票严格按发送顺序累加。
    const key = openId || chatId;
    enqueue(key, async () => {
      try {
        if (msgType === 'image') {
          await handleImage(chatId, openId, messageId, message.content);
        } else if (msgType === 'file') {
          await handleFile(chatId, openId, messageId, message.content);
        } else if (msgType === 'text') {
          await handleText(chatId, openId, message.content);
        } else {
          logger.warn(
            `收到未支持的消息类型 message_type=${msgType}；content=${String(message?.content ?? '').slice(0, 300)}`
          );
          await sendText(chatId, '请发送发票图片或 PDF（增值税发票 / 火车票 / 出租车票）。');
        }
      } catch (e) {
        logger.error('处理消息出错', e);
        try {
          await sendText(chatId, `处理失败：${(e as Error).message}`);
        } catch {
          /* 忽略二次失败 */
        }
      }
    });
  }

  return { onMessage, onChatEntered };
}
