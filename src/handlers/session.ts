import { RecognizedInvoice } from '../types';
import { LoanReference } from '../writeoff/loans';

/**
 * 购物车中的一张发票。
 * - 图片消息：存 imageBuffer(+imageExt)，提交时上传到审批「图片」控件。
 * - PDF 消息：存 fileBuffer(+fileName)，提交时以附件上传到审批「附件」控件。
 */
export interface CartItem {
  invoice: RecognizedInvoice;
  imageBuffer?: Buffer;
  imageExt?: string;
  /** 原始文件字节（如 PDF），用于上传到「附件」控件 */
  fileBuffer?: Buffer;
  /** 原始文件名（含扩展名，用于附件展示） */
  fileName?: string;
}
export type ClaimMode = 'loan_writeoff' | 'expense';

/** 辅助材料附件（支付截图/行程单等）：不识别、不查重，仅随审批一起提交。 */
export interface Attachment {
  imageBuffer?: Buffer;
  imageExt?: string;
  fileBuffer?: Buffer;
  fileName?: string;
}

/** 一次待提交的报销（可含多张发票） */
export interface PendingClaim {
  items: CartItem[];
  /** 辅助材料（支付截图/行程单等，仅附件、不识别） */
  attachments: Attachment[];
  /** 是否处于「附件模式」：此时收到的图片/文件作为材料附件而非发票 */
  collectingAttachments?: boolean;
  createdAt: number;
  mode: ClaimMode;
  /** 进入「提交前预览/待确认」阶段后填充；用户回复「确认」时据此创建审批。 */
  draft?: Draft;
  loan?: LoanReference;
  loanCandidates?: LoanReference[];
  pendingReason?: string;
}

/** 待确认草稿：LLM 整理出的文案与类别，用户可在确认前修改类别/事由。 */
export interface Draft {
  reason: string;
  title?: string;
  contents?: string[];
  /** 报销类别名称（LLM 选出或用户改写；须为 field-mapping 里 category 的一项） */
  category?: string;
}

/** 会话有效期：超过后需重新发送发票 */
const TTL_MS = 30 * 60 * 1000;

/** 内存会话，key 为用户 open_id。多实例部署时需替换为共享存储。 */
const store = new Map<string, PendingClaim>();

/** 追加一张发票到购物车，返回最新购物车 */
export function addItem(openId: string, item: CartItem): PendingClaim {
  const existing = getPending(openId);
  if (existing) {
    existing.items.push(item);
    existing.createdAt = Date.now();
    existing.draft = undefined; // 发票集合已变化，作废旧预览，回到收集阶段
    existing.loan = undefined;
    existing.loanCandidates = undefined;
    existing.pendingReason = undefined;
    return existing;
  }
  // 正常流程会先选择模式；兜底按费用报销，避免旧调用方产生无效会话。
  const claim: PendingClaim = { items: [item], attachments: [], createdAt: Date.now(), mode: 'expense' };
  store.set(openId, claim);
  return claim;
}

export function startSession(openId: string, mode: ClaimMode): PendingClaim {
  const claim: PendingClaim = { items: [], attachments: [], createdAt: Date.now(), mode };
  store.set(openId, claim);
  return claim;
}

/** 追加一个辅助材料附件（不识别）。作废旧预览。会话不存在返回 undefined。 */
export function addAttachment(openId: string, att: Attachment): PendingClaim | undefined {
  const c = getPending(openId);
  if (!c) return undefined;
  c.attachments.push(att);
  c.draft = undefined;
  c.createdAt = Date.now();
  return c;
}

/** 开关「附件模式」。 */
export function setCollecting(openId: string, on: boolean): void {
  const c = getPending(openId);
  if (!c) return;
  c.collectingAttachments = on;
  c.createdAt = Date.now();
}

export function setLoanSelection(openId: string, candidates: LoanReference[], reason: string): void {
  const c = getPending(openId); if (!c) return;
  c.loanCandidates = candidates; c.pendingReason = reason; c.createdAt = Date.now();
}

export function selectLoan(openId: string, loan: LoanReference): void {
  const c = getPending(openId); if (!c) return;
  c.loan = loan; c.loanCandidates = undefined; c.pendingReason = undefined; c.createdAt = Date.now();
}

/** 写入/更新待确认草稿，并刷新有效期（确认等待期间避免过期）。 */
export function setDraft(openId: string, draft: Draft): PendingClaim | undefined {
  const c = getPending(openId);
  if (!c) return undefined;
  c.draft = draft;
  c.createdAt = Date.now();
  return c;
}

export function getPending(openId: string): PendingClaim | undefined {
  const c = store.get(openId);
  if (!c) return undefined;
  if (Date.now() - c.createdAt > TTL_MS) {
    store.delete(openId);
    return undefined;
  }
  return c;
}

export function clearPending(openId: string): void {
  store.delete(openId);
}
