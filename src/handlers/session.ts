import { RecognizedInvoice } from '../types';

/** 购物车中的一张发票（含原图，便于后续上传到审批图片栏） */
export interface CartItem {
  invoice: RecognizedInvoice;
  imageBuffer?: Buffer;
  imageExt?: string;
}

/** 一次待提交的报销（可含多张发票） */
export interface PendingClaim {
  items: CartItem[];
  createdAt: number;
  /** 进入「提交前预览/待确认」阶段后填充；用户回复「确认」时据此创建审批。 */
  draft?: Draft;
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
    return existing;
  }
  const claim: PendingClaim = { items: [item], createdAt: Date.now() };
  store.set(openId, claim);
  return claim;
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
