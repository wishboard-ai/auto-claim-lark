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
      { tag: 'div', text: { tag: 'lark_md', content: '继续发送发票图片可累加；回复 **确认** 提交，或 **取消** 放弃。' } },
    ],
  });
}

/** 提交成功卡片 */
export function successCard(invoices: RecognizedInvoice[], link: string | undefined, title: string): string {
  const list = invoices.map((v, i) => briefLine(v, i + 1)).join('\n');
  const elements: Array<Record<string, unknown>> = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**${title}**\n共 ${invoices.length} 张，合计 ¥${totalAmount(invoices)}\n\n${list}`,
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
