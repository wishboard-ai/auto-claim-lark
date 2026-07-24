import { RecognizedInvoice } from '../types';

function line(label: string, value?: string): string | null {
  return value ? `**${label}**：${value}` : null;
}

/** 将识别结果渲染成多行 Markdown */
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

/** 待确认卡片（confirm 模式）：展示识别结果并提示回复确认/取消 */
export function confirmCard(inv: RecognizedInvoice): string {
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { template: 'orange', title: { tag: 'plain_text', content: '请确认报销信息' } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: buildRecognitionLines(inv) } },
      { tag: 'hr' },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: '确认无误请回复 **确认**（或「提交」），机器人将为你创建并提交该费用报销审批；放弃请回复 **取消**。',
        },
      },
    ],
  });
}

/** 成功卡片：审批已创建（已进入审批流），附查看链接 */
export function successCard(inv: RecognizedInvoice, link?: string): string {
  const elements: Array<Record<string, unknown>> = [
    { tag: 'div', text: { tag: 'lark_md', content: buildRecognitionLines(inv) } },
  ];
  if (link) {
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '查看审批' },
          type: 'primary',
          url: link,
        },
      ],
    });
  }
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { template: 'green', title: { tag: 'plain_text', content: '费用报销审批已提交' } },
    elements,
  });
}
