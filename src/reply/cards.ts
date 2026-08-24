import { RecognizedInvoice } from '../types';
import { LoanReference } from '../writeoff/loans';

type ClaimMode = 'loan_writeoff' | 'expense';

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
    line('发票代码', inv.invoiceCode),
    line('税额(元)', inv.taxAmount),
    line('摘要', inv.summary),
  ]
    .filter(Boolean)
    .join('\n');
}

/** 审批通过并完成自动核销后的通知卡片。 */
export function writeOffCard(
  loanInstanceCode: string,
  instanceCode: string,
  writeOffAmount: number,
  remainingAmount: number
): string {
  const completed = remainingAmount <= 0.005;
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { template: 'green', title: { tag: 'plain_text', content: completed ? '借款已完成全部核销' : '本次借款核销已通过' } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `原付款申请 **${loanInstanceCode}**\n\n本次已核销 **¥${writeOffAmount.toFixed(2)}**，剩余可核销 **¥${remainingAmount.toFixed(2)}**。` } },
      { tag: 'note', elements: [{ tag: 'plain_text', content: `审批实例：${instanceCode}` }] },
    ],
  });
}

export function loanSelectionCard(loans: Array<{ serialNumber: string; approvedDate: string; amount?: string; reason?: string }>): string {
  const lines = loans.map((loan: any, i) => `${i + 1}. **${loan.serialNumber}**　借款 ¥${loan.amount ?? '-'}　剩余 ¥${loan.remainingAmount ?? loan.amount ?? '-'}　${loan.approvedDate}\n   ${loan.reason ?? ''}`).join('\n');
  return JSON.stringify({ config: { wide_screen_mode: true }, header: { template: 'blue', title: { tag: 'plain_text', content: '请选择要核销的借款' } }, elements: [{ tag: 'div', text: { tag: 'lark_md', content: lines } }, { tag: 'hr' }, { tag: 'div', text: { tag: 'lark_md', content: '回复序号（例如 **1**）选择付款申请。日期为该付款申请审批真正通过的日期。' } }] });
}

export function modeSelectionCard(): string {
  return JSON.stringify({ config: { wide_screen_mode: true }, header: { template: 'blue', title: { tag: 'plain_text', content: '请选择办理类型' } }, elements: [{ tag: 'div', text: { tag: 'lark_md', content: '回复 **借款核销**：关联已通过的付款申请，可分批核销。\n\n回复 **费用报销**：直接发起费用报销审批。' } }] });
}

function totalAmount(invoices: RecognizedInvoice[]): string {
  const sum = invoices.reduce((s, v) => s + (parseFloat(v.amount || '0') || 0), 0);
  return sum.toFixed(2);
}

function briefLine(inv: RecognizedInvoice, idx: number): string {
  return `${idx}. ${inv.typeLabel}　¥${inv.amount ?? '-'}　${inv.date ?? ''}　${inv.sellerName ?? ''}`.trim();
}

/** 发票加入购物车后的卡片（含累计） */
export function addedCard(invoices: RecognizedInvoice[], mode: ClaimMode): string {
  const isLoan = mode === 'loan_writeoff';
  const list = invoices.map((v, i) => briefLine(v, i + 1)).join('\n');
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: `已加入${isLoan ? '核销' : '报销'}（共 ${invoices.length} 张，合计 ¥${totalAmount(invoices)}）` },
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: list } },
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lark_md', content: isLoan
        ? '继续发送发票可累加；回复本次「核销事由」后，我会查询并关联已通过的付款申请。'
        : '继续发送发票可累加；回复本次「报销事由」后，我会生成费用报销预览。' } },
    ],
  });
}

/** 提交成功卡片 */
export function successCard(
  invoices: RecognizedInvoice[],
  link: string | undefined,
  title: string,
  categoryLabel: string | undefined,
  mode: ClaimMode
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
    header: { template: 'green', title: { tag: 'plain_text', content: mode === 'loan_writeoff' ? '借款核销审批已提交' : '费用报销审批已提交' } },
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
  categoryNames: string[] = [],
  loan: LoanReference | undefined,
  mode: ClaimMode
): string {
  const list = invoices.map((v, i) => briefLine(v, i + 1)).join('\n');
  const rows = [`**${title}**`];
  if (categoryLabel) rows.push(`**报销类别**：${categoryLabel}`);
  if (reason) rows.push(`**${mode === 'loan_writeoff' ? '核销' : '报销'}事由**：${reason}`);
  if (loan) {
    rows.push(`**原付款申请**：${loan.serialNumber}`);
    rows.push(`**实际借款时间**：${new Date(loan.approvedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`);
    if (loan.amount) rows.push(`**借款金额**：¥${loan.amount}`);
    if (loan.remainingAmount) {
      const after = Math.max(0, Number(loan.remainingAmount) - Number(totalAmount(invoices)));
      rows.push(`**核销前剩余**：¥${loan.remainingAmount}　**本次后剩余**：¥${after.toFixed(2)}`);
    }
  }
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
