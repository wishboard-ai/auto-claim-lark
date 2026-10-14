import type { PendingClaim } from '../handlers/session';

/** 仅呈现现有命令的 deterministic 展示，不改变会话或决定任何操作。 */
export function buildOperationHint(
  pending?: PendingClaim,
  options: { directExpense?: boolean; loanEnabled?: boolean } = {}
): string {
  const modes = options.loanEnabled === false ? '「费用报销」' : '「借款核销」或「费用报销」';
  const cancel = '回复「取消」放弃本次办理。';
  if (!pending) {
    return `可用操作：\n回复${modes}选择办理类型。\n${cancel}`;
  }

  const directExpense = options.directExpense === true && pending.mode === 'expense';
  const invoiceUpload = directExpense
    ? '上传发票图片/PDF/OFD，识别成功后直接提交费用报销审批。'
    : '继续上传发票图片/PDF/OFD，可累加多张发票。';
  const media = pending.collectingAttachments
    ? `继续上传辅助材料（图片或文件）；回复「发票」切回发票模式后${directExpense ? '上传发票，识别成功后直接提交费用报销审批' : '继续上传发票'}。`
    : `${invoiceUpload}\n回复「附件」进入辅助材料模式，上传支付截图、行程单等材料。`;
  const lines = ['可用操作：', media];
  if (pending.items.length === 0) {
    lines.push(`尚未添加发票；可回复${modes}重新选择办理类型。`);
  } else if (pending.draft) {
    const total = pending.items.reduce((sum, item) => sum + (Number(item.invoice.amount) || 0), 0);
    lines.push(
      '回复「确认」提交当前预览。',
      `回复「金额 数字」修改本次${pending.mode === 'loan_writeoff' ? '核销' : '报销'}金额（大于 0，且不超过发票合计 ¥${total.toFixed(2)}）。`,
      '预览列出类别时，可回复其中一个名称修改类别。',
      `直接回复新的${pending.mode === 'loan_writeoff' ? '核销' : '报销'}事由，重新生成预览。`,
      '追加发票或辅助材料后，请重新回复事由生成预览，再确认提交。'
    );
  } else if (pending.loanCandidates?.length) {
    lines.push(`回复 1-${pending.loanCandidates.length} 之间的序号选择付款申请。`);
  } else {
    lines.push(pending.mode === 'loan_writeoff'
      ? '直接回复本次核销事由，查询付款申请并生成预览。'
      : '直接回复本次报销事由，生成预览。');
  }
  lines.push(cancel);
  return lines.join('\n');
}
