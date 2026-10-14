import { RecognizedInvoice } from '../types';
import { LoanReference } from '../writeoff/loans';
import { buildOperationHint } from './actions';

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

export function loanSelectionCard(loans: Array<{ serialNumber: string; approvedDate: string; applicantOpenId?: string; amount?: string; remainingAmount?: string; reason?: string }>, showApplicant = false, hint?: string): string {
  const lines = loans.map((loan, i) => {
    const applicant = showApplicant && loan.applicantOpenId ? `　申请人 <at id=${loan.applicantOpenId}></at>` : '';
    return `${i + 1}. **${loan.serialNumber}**　借款 ¥${loan.amount ?? '-'}　剩余 ¥${loan.remainingAmount ?? loan.amount ?? '-'}　${loan.approvedDate}${applicant}\n   ${loan.reason ?? ''}`;
  }).join('\n');
  const operationHint = hint ?? `可用操作：\n回复 1-${loans.length} 之间的序号选择付款申请。\n继续上传发票；回复「附件」上传辅助材料，材料模式中回复「发票」切回。\n回复「取消」放弃本次办理。`;
  return JSON.stringify({ config: { wide_screen_mode: true }, header: { template: 'blue', title: { tag: 'plain_text', content: '请选择要核销的借款' } }, elements: [{ tag: 'div', text: { tag: 'lark_md', content: lines } }, { tag: 'hr' }, { tag: 'div', text: { tag: 'lark_md', content: `日期为该付款申请审批真正通过的日期。\n\n${operationHint}` } }] });
}

export function modeSelectionCard(loanEnabled = true): string {
  const description = (loanEnabled ? '借款核销：关联已通过的付款申请，可分批核销。\n\n' : '') + '费用报销：发起费用报销审批。';
  return JSON.stringify({ config: { wide_screen_mode: true }, header: { template: 'blue', title: { tag: 'plain_text', content: '请选择办理类型' } }, elements: [{ tag: 'div', text: { tag: 'lark_md', content: `${description}\n\n${buildOperationHint(undefined, { loanEnabled })}` } }] });
}

function totalAmount(invoices: RecognizedInvoice[]): string {
  const sum = invoices.reduce((s, v) => s + (parseFloat(v.amount || '0') || 0), 0);
  return sum.toFixed(2);
}

function briefLine(inv: RecognizedInvoice, idx: number): string {
  return `${idx}. ${inv.typeLabel}　¥${inv.amount ?? '-'}　${inv.date ?? ''}　${inv.sellerName ?? ''}`.trim();
}

/** 发票加入购物车后的卡片（含累计） */
export function addedCard(invoices: RecognizedInvoice[], mode: ClaimMode, hint?: string): string {
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
      { tag: 'div', text: { tag: 'lark_md', content: hint ?? buildOperationHint({ items: invoices.map((invoice) => ({ invoice })), attachments: [], createdAt: 0, mode }) } },
    ],
  });
}

/** 提交成功卡片 */
export function successCard(
  invoices: RecognizedInvoice[],
  link: string | undefined,
  title: string,
  categoryLabel: string | undefined,
  mode: ClaimMode,
  loanEnabled = true,
  claimAmount?: number
): string {
  const list = invoices.map((v, i) => briefLine(v, i + 1)).join('\n');
  const invoiceTotal = Number(totalAmount(invoices));
  const actualAmount = claimAmount ?? invoiceTotal;
  const rows = [`**${title}**`];
  if (categoryLabel) rows.push(`**报销类别**：${categoryLabel}`);
  rows.push(`共 ${invoices.length} 张，发票合计 ¥${invoiceTotal.toFixed(2)}`);
  if (mode === 'expense') {
    rows.push(`**实际报销金额**：¥${actualAmount.toFixed(2)}${actualAmount < invoiceTotal ? '（少于发票合计）' : ''}`);
  }
  const head = `${rows.join('\n')}\n\n${list}`;
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
  elements.push({ tag: 'div', text: { tag: 'lark_md', content: `办理下一笔，请回复${loanEnabled ? '「费用报销」或「借款核销」' : '「费用报销」'}。` } });
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
  mode: ClaimMode,
  attachmentCount = 0,
  claimAmount?: number,
  hint?: string
): string {
  const list = invoices.map((v, i) => briefLine(v, i + 1)).join('\n');
  const invoiceTotal = Number(totalAmount(invoices));
  const claim = claimAmount != null ? claimAmount : invoiceTotal;
  const rows = [`**${title}**`];
  if (categoryLabel) rows.push(`**报销类别**：${categoryLabel}`);
  if (reason) rows.push(`**${mode === 'loan_writeoff' ? '核销' : '报销'}事由**：${reason}`);
  if (loan) {
    rows.push(`**原付款申请**：${loan.serialNumber}`);
    rows.push(`**实际借款时间**：${new Date(loan.approvedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`);
    if (loan.amount) rows.push(`**借款金额**：¥${loan.amount}`);
    if (loan.remainingAmount) {
      const after = Math.max(0, Number(loan.remainingAmount) - claim);
      rows.push(`**核销前剩余**：¥${loan.remainingAmount}　**本次后剩余**：¥${after.toFixed(2)}`);
    }
  }
  rows.push(`共 ${invoices.length} 张，发票合计 ¥${invoiceTotal.toFixed(2)}`);
  rows.push(`**本次${mode === 'loan_writeoff' ? '核销' : '报销'}金额**：¥${claim.toFixed(2)}${claim < invoiceTotal ? '（少于发票合计）' : ''}`);
  if (attachmentCount > 0) rows.push(`**附加材料**：${attachmentCount} 个（仅附件，不计入金额）`);
  rows.push('');
  rows.push(list);
  const operationHint = hint ?? buildOperationHint({
    items: invoices.map((invoice) => ({ invoice })), attachments: [], createdAt: 0, mode,
    draft: { reason: reason ?? '', title, category: categoryLabel },
  });
  const categoryHint = categoryNames.length ? `\n可选类别名称：${categoryNames.join(' / ')}。` : '';
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { template: 'orange', title: { tag: 'plain_text', content: '请核对，回复「确认」后提交' } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: rows.join('\n') } },
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lark_md', content: operationHint + categoryHint } },
    ],
  });
}
