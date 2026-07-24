import { RecognizedInvoice, FormField } from '../types';

/** 一次待确认/待提交的报销 */
export interface PendingClaim {
  invoice: RecognizedInvoice;
  form: FormField[];
  title: string;
  createdAt: number;
}

/** 会话有效期：超过后需重新发送发票 */
const TTL_MS = 10 * 60 * 1000;

/** 简单的内存会话存储，key 为用户 open_id。多实例部署时需替换为共享存储。 */
const store = new Map<string, PendingClaim>();

export function setPending(openId: string, claim: Omit<PendingClaim, 'createdAt'>): void {
  store.set(openId, { ...claim, createdAt: Date.now() });
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
