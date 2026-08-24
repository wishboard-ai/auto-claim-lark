import { AppConfig } from './config';
import { RecognizedInvoice } from './types';
import { logger } from './logger';

export interface GeneratedContent {
  title: string;
  /** 每张发票对应的明细「内容」，顺序与传入发票一致（仅整理已有信息，不编造） */
  contents: string[];
  /** 结合发票内容与用户说明选出的报销类别名称（须为允许列表中的一项，否则为 undefined） */
  category?: string;
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
 * 用 LLM 生成报销标题，并「整理」每张发票的明细内容（不生成事由，事由由员工输入）。
 * 若给定 categories，则同时让模型结合「发票内容 + 员工填写的说明(reason)」选出报销类别。
 * 严格要求只基于发票已有信息整理，不得编造用途。未启用或失败时返回 null，回退模板。
 */
export async function generateContent(
  cfg: AppConfig,
  invoices: RecognizedInvoice[],
  reason?: string,
  categories?: string[]
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

  const hasCats = Array.isArray(categories) && categories.length > 0;
  const reasonText = (reason || '').trim();

  const system =
    '你是企业费用报销助手，负责整理发票信息为规范的报销单文案。严禁编造任何发票中不存在的信息（尤其是用途、事由），只能基于给定字段进行归纳和格式化。只返回严格的 JSON，不要输出解释或额外文字。';

  const lines: string[] = [];
  lines.push(`发票列表（共 ${invoices.length} 张）：\n${JSON.stringify(items, null, 2)}`);
  if (reasonText) lines.push(`\n员工填写的报销说明/事由：${reasonText}`);
  lines.push(`\n请返回 JSON：`);
  lines.push(`- "title": 报销单标题，不超过 20 字，概括票据类型与商家，不要编造用途；`);
  lines.push(
    `- "contents": 字符串数组，长度必须等于 ${invoices.length}，与发票顺序一一对应；每项仅根据该发票已有信息（类型/商家/日期/金额）整理成简洁明细，不要编造用途或事由。`
  );
  if (hasCats) {
    lines.push(
      `- "category": 报销类别，必须从下列选项中选择一个、文字完全一致：${categories!.join(' / ')}。` +
        `请结合发票内容（类型/商家/摘要/金额）与上面的「报销说明」综合判断最贴合的类别；若都无法明确判断，则填 "其他"。`
    );
  }
  lines.push(
    hasCats
      ? `示例：{"title":"客户拜访交通费(2张)","contents":["出租车 2024-01-15 ¥35.00","高铁 北京→上海 2024-01-16 ¥553.50"],"category":"交通费"}`
      : `示例：{"title":"通讯费报销(2张)","contents":["中国移动 2024-02 话费 ¥450.24","出租车 2024-01-15 ¥35.00"]}`
  );
  const user = lines.join('\n');

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
        temperature: 0.2,
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
    let category: string | undefined;
    if (hasCats) {
      const c = String(parsed.category ?? '').trim();
      if (c && categories!.includes(c)) category = c;
      else if (c) logger.warn(`LLM 返回的类别「${c}」不在允许列表内，忽略并回退默认规则。`);
    }
    return {
      title: (String(parsed.title || '').trim() || '费用报销').slice(0, 40),
      contents,
      category,
    };
  } catch (e) {
    logger.warn('LLM 生成失败：', (e as Error).message);
    return null;
  }
}
