import * as lark from '@larksuiteoapi/node-sdk';
import { AppConfig } from '../config';
import { logger } from '../logger';
import { downloadImage } from '../invoice/download';
import { recognizeInvoice } from '../invoice/recognize';
import { buildApprovalForm } from '../approval/fieldMapping';
import { createApprovalInstance } from '../approval/submit';
import { setPending, getPending, clearPending, PendingClaim } from './session';
import { confirmCard, successCard, buildRecognitionLines } from '../reply/cards';

const CONFIRM_WORDS = ['确认', '提交', 'confirm', 'ok', 'y', 'yes', '是', '好'];
const CANCEL_WORDS = ['取消', '放弃', 'cancel', 'n', 'no', '否'];

const HELP_TEXT =
  '你好，我是发票报销助手 🧾\n直接发送发票图片（增值税发票 / 火车票 / 出租车票），我会识别并为你创建费用报销审批。';

export function makeMessageHandler(client: lark.Client, cfg: AppConfig) {
  // 幂等去重：长连接下若处理超过 3 秒，平台会重推同一事件；
  // 以 message_id 去重，避免重复识别与重复创建报销单。
  const processed = new Map<string, number>();
  const DEDUP_TTL_MS = 5 * 60 * 1000;
  function seenBefore(messageId: string): boolean {
    const now = Date.now();
    for (const [k, t] of processed) {
      if (now - t > DEDUP_TTL_MS) processed.delete(k);
    }
    if (processed.has(messageId)) return true;
    processed.set(messageId, now);
    return false;
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

  async function submitAndReport(
    chatId: string,
    openId: string,
    claim: Pick<PendingClaim, 'invoice' | 'form' | 'title'>
  ): Promise<void> {
    try {
      const { instanceLink } = await createApprovalInstance(
        client,
        cfg,
        openId,
        claim.form,
        claim.title
      );
      await sendCard(chatId, successCard(claim.invoice, instanceLink));
    } catch (e) {
      logger.error('创建审批失败', e);
      await sendText(chatId, `创建审批失败：${(e as Error).message}`);
    }
  }

  async function handleImage(
    chatId: string,
    openId: string | undefined,
    messageId: string,
    content: string
  ): Promise<void> {
    const imageKey = JSON.parse(content).image_key as string;
    await sendText(chatId, '📷 收到发票，正在识别…');

    const buffer = await downloadImage(client, messageId, imageKey);
    const invoice = await recognizeInvoice(client, buffer);
    if (invoice.type === 'unknown') {
      await sendText(chatId, '未能识别该图片中的发票信息，请确认是清晰的增值税发票 / 火车票 / 出租车票图片。');
      return;
    }

    const { form, title } = buildApprovalForm(invoice);
    if (form.length === 0) {
      await sendText(
        chatId,
        `已识别为「${invoice.typeLabel}」，但字段映射尚未配置。请运行 npm run inspect:approval 获取控件ID并填入 config/field-mapping.json。\n\n识别结果：\n${buildRecognitionLines(invoice)}`
      );
      return;
    }

    if (!openId) {
      await sendText(chatId, '无法获取你的用户身份（open_id），无法发起审批。');
      return;
    }

    if (cfg.submitMode === 'direct') {
      await submitAndReport(chatId, openId, { invoice, form, title });
    } else {
      setPending(openId, { invoice, form, title });
      await sendCard(chatId, confirmCard(invoice));
    }
  }

  async function handleText(
    chatId: string,
    openId: string | undefined,
    content: string
  ): Promise<void> {
    const text = String(JSON.parse(content).text || '').trim().toLowerCase();
    if (openId && CONFIRM_WORDS.includes(text)) {
      const pending = getPending(openId);
      if (!pending) {
        await sendText(chatId, '没有待提交的报销。请先发送一张发票图片。');
        return;
      }
      clearPending(openId);
      await submitAndReport(chatId, openId, pending);
    } else if (openId && CANCEL_WORDS.includes(text)) {
      clearPending(openId);
      await sendText(chatId, '已取消本次报销。');
    } else {
      await sendText(chatId, HELP_TEXT);
    }
  }

  // 用户进入与机器人的单聊会话时发送欢迎语（节流，避免频繁进入刷屏）
  const welcomed = new Map<string, number>();
  const WELCOME_TTL_MS = 30 * 60 * 1000;

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

    try {
      if (msgType === 'image') {
        await handleImage(chatId, openId, messageId, message.content);
      } else if (msgType === 'text') {
        await handleText(chatId, openId, message.content);
      } else {
        await sendText(chatId, '请发送发票图片（增值税发票 / 火车票 / 出租车票）。');
      }
    } catch (e) {
      logger.error('处理消息出错', e);
      try {
        await sendText(chatId, `处理失败：${(e as Error).message}`);
      } catch {
        /* 忽略二次失败 */
      }
    }
  }

  return { onMessage, onChatEntered };
}
