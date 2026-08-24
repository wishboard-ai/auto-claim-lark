import { RecognizedInvoice } from '../types';

function line(label: string, value?: string): string | null {
  return value ? `**${label}**：${value}` : null;
}

/** 单张发票的多行明细（用于识别结果展示） */
export function buildRecognitionLines(inv: RecognizedInvoice): string {
  return [
    line('票据类型', inv.typeLabel),
    line('金额(元)', inv.amount),
    line('日期', inv.date),
    line('商家/承运', inv.sellerName),
    line('发票号', inv.invoiceNo),
    line('税额(元)', inv.taxAmount),
    line('摘要', inv.summary),
  ]
    .filter(Boolean)
    .join('\n');
}

function totalAmount(invoices: RecognizedInvoice[]): string {
  const sum = invoices.reduce((s, v) => s + (parseFloat(v.amount || '0') || 0), 0);
  return sum.toFixed(2);
}

function briefLine(inv: RecognizedInvoice, idx: number): string {
  return `${idx}. ${inv.typeLabel}　¥${inv.amount ?? '-'}　${inv.date ?? ''}　${inv.sellerName ?? ''}`.trim();
}

/** 发票加入购物车后的卡片（含累计） */
export function addedCard(invoices: RecognizedInvoice[]): string {
  const list = invoices.map((v, i) => briefLine(v, i + 1)).join('\n');
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: `已加入报销（共 ${invoices.length} 张，合计 ¥${totalAmount(invoices)}）` },
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: list } },
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lark_md', content: '继续发送发票图片可累加；回复本次「报销事由」（如：1月客户拜访交通费）后我会生成预览、确认后再提交，或回复「取消」放弃。' } },
    ],
  });
}

/** 提交成功卡片 */
export function successCard(
  invoices: RecognizedInvoice[],
  link: string | undefined,
  title: string,
  categoryLabel?: string
): string {
  const list = invoices.map((v, i) => briefLine(v, i + 1)).join('\n');
  const head = categoryLabel
    ? `**${title}**\n**报销类别**：${categoryLabel}\n共 ${invoices.length} 张，合计 ¥${totalAmount(invoices)}\n\n${list}`
    : `**${title}**\n共 ${invoices.length} 张，合计 ¥${totalAmount(invoices)}\n\n${list}`;
  const elements: Array<Record<string, unknown>> = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: head,
      },
    },
  ];
  if (link) {
    elements.push({
      tag: 'action',
      actions: [{ tag: 'button', text: { tag: 'plain_text', content: '查看审批' }, type: 'primary', url: link }],
    });
  }
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { template: 'green', title: { tag: 'plain_text', content: '费用报销审批已提交' } },
    elements,
  });
}

/**
 * 提交前预览/确认卡片（confirm 模式）：展示标题/类别/事由/明细，等待用户回复「确认」再提交。
 * 用户也可回复某个类别名改类别、或回复新的事由文字重新整理。
 */
export function previewCard(
  invoices: RecognizedInvoice[],
  title: string,
  categoryLabel: string | undefined,
  reason: string | undefined,
  categoryNames: string[] = []
): string {
  const list = invoices.map((v, i) => briefLine(v, i + 1)).join('\n');
  const rows = [`**${title}**`];
  if (categoryLabel) rows.push(`**报销类别**：${categoryLabel}`);
  if (reason) rows.push(`**报销事由**：${reason}`);
  rows.push(`共 ${invoices.length} 张，合计 ¥${totalAmount(invoices)}`);
  rows.push('');
  rows.push(list);
  const hint =
    '回复「**确认**」提交审批；回复「**取消**」放弃。\n' +
    (categoryNames.length ? `如需改类别，回复其中一个名称：${categoryNames.join(' / ')}。\n` : '') +
    '如需改事由，直接回复新的事由文字，我会重新整理并再次预览。';
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { template: 'orange', title: { tag: 'plain_text', content: '请核对，回复「确认」后提交' } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: rows.join('\n') } },
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lark_md', content: hint } },
    ],
  });
}
