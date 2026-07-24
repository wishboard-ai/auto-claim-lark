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
    return existing;
  }
  const claim: PendingClaim = { items: [item], createdAt: Date.now() };
  store.set(openId, claim);
  return claim;
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
