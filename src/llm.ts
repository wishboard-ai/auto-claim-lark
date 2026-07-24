import { AppConfig } from './config';
import { RecognizedInvoice } from './types';
import { logger } from './logger';

export interface GeneratedContent {
  title: string;
  reason: string;
  /** 每张发票对应的明细「内容」，顺序与传入发票一致 */
  contents: string[];
}

function extractJson(text: string): any | null {
  const stripped = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(stripped);
  } catch {
    /* ignore */
  }
  const m = stripped.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch {
      /* ignore */
    }
  }
  return null;
}

/**
 * 用 LLM 生成报销标题 / 事由 / 每张发票的明细内容。
 * 未启用（无 API Key）或调用失败时返回 null，调用方回退到模板生成。
 */
export async function generateContent(
  cfg: AppConfig,
  invoices: RecognizedInvoice[]
): Promise<GeneratedContent | null> {
  if (!cfg.llm.enabled || invoices.length === 0) return null;

  const items = invoices.map((inv, i) => ({
    序号: i + 1,
    类型: inv.typeLabel,
    商家: inv.sellerName,
    金额: inv.amount,
    日期: inv.date,
    摘要: inv.summary,
    发票号: inv.invoiceNo,
  }));

  const system =
    '你是企业费用报销助手。根据发票信息生成简洁、正式、符合中文财务习惯的报销单文案。只返回严格的 JSON，不要输出任何解释或额外文字。';
  const user =
    `发票列表（共 ${invoices.length} 张）：\n${JSON.stringify(items, null, 2)}\n\n` +
    `请返回 JSON，字段：\n` +
    `- "title": 报销单标题，不超过 20 字；\n` +
    `- "reason": 报销事由，1-2 句话说明用途与合理性；\n` +
    `- "contents": 字符串数组，长度必须等于发票数量(${invoices.length})，与发票顺序一一对应，每项是该发票的明细内容（商家+用途，简明）。\n` +
    `示例：{"title":"...","reason":"...","contents":["...","..."]}`;

  try {
    const resp = await fetch(`${cfg.llm.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.llm.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.llm.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.3,
      }),
    });
    if (!resp.ok) {
      logger.warn(`LLM 调用失败 HTTP ${resp.status}：${(await resp.text().catch(() => '')).slice(0, 200)}`);
      return null;
    }
    const data: any = await resp.json();
    const text: string | undefined = data?.choices?.[0]?.message?.content;
    if (!text) return null;
    const parsed = extractJson(text);
    if (!parsed) {
      logger.warn('LLM 返回无法解析为 JSON');
      return null;
    }
    const contents = Array.isArray(parsed.contents) ? parsed.contents.map((x: any) => String(x)) : [];
    return {
      title: (String(parsed.title || '').trim() || '费用报销').slice(0, 40),
      reason: String(parsed.reason || '').trim(),
      contents,
    };
  } catch (e) {
    logger.warn('LLM 生成失败：', (e as Error).message);
    return null;
  }
}
