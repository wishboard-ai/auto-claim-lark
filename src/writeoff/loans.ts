import * as lark from '@larksuiteoapi/node-sdk';
import { AppConfig } from '../config';
import { LoanWriteOffLedger } from './ledger';

const REASON_ID = 'widget17742552760470001';
const DETAIL_ID = 'widget17742539539820001';
const AMOUNT_ID = 'widget17742540352210001';
const TYPE_ID = 'widget17742532667420001';
export interface LoanReference { instanceCode: string; serialNumber: string; title: string; approvedAt: string; approvedDate: string; amount?: string; reason?: string; paymentType?: string; link?: string; writtenOffAmount?: string; pendingAmount?: string; remainingAmount?: string }
type FormNode = { id?: string; name?: string; value?: unknown; [key: string]: unknown };
function nodes(value: unknown): FormNode[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object') return [];
  const node = value as FormNode;
  return [node, ...Object.values(node).flatMap(nodes)];
}
function display(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(display).filter(Boolean).join('、') || undefined;
  if (typeof value === 'object') { const o = value as Record<string, unknown>; return display(o.text ?? o.name ?? o.label ?? o.value); }
  return undefined;
}
function numeric(value: unknown): number { return Number((display(value) || '').replace(/[^\d.-]/g, '')) || 0; }
function isoTime(value?: string): string {
  const n = Number(value); if (Number.isFinite(n) && n > 0) return new Date(n < 10_000_000_000 ? n * 1000 : n).toISOString();
  const d = new Date(value || ''); return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}
function shanghaiDate(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso));
  const part = (type: string) => parts.find((item) => item.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}
/** 实际借款时间严格取付款申请审批实例的 end_time。 */
export function parseLoanDetail(data: { instance_code: string; serial_number: string; approval_name: string; end_time: string; form: string }, link?: string): LoanReference {
  const all = nodes(JSON.parse(data.form || '[]'));
  const find = (id: string) => all.find((n) => n.id === id);
  const total = nodes(find(DETAIL_ID)?.value).filter((n) => n.id === AMOUNT_ID).reduce((s, n) => s + numeric(n.value), 0);
  const approvedAt = isoTime(data.end_time);
  return { instanceCode: data.instance_code, serialNumber: data.serial_number, title: data.approval_name, approvedAt, approvedDate: shanghaiDate(approvedAt), amount: total > 0 ? total.toFixed(2) : undefined, reason: display(find(REASON_ID)?.value), paymentType: display(find(TYPE_ID)?.value), link };
}
export async function listOutstandingLoans(client: lark.Client, cfg: AppConfig, openId: string, ledger: LoanWriteOffLedger): Promise<LoanReference[]> {
  const now = Date.now();
  const oldest = now - cfg.writeOff.lookbackDays * 86_400_000;
  // 飞书要求起止时间同时传递，且单次查询跨度不得超过 30 天。
  const maxWindowMs = 29 * 86_400_000;
  const summaries = new Map<string, { instance?: { code?: string; link?: { pc_link?: string; mobile_link?: string } } }>();
  for (let windowEnd = now; windowEnd > oldest;) {
    const windowStart = Math.max(oldest, windowEnd - maxWindowMs);
    let pageToken: string | undefined;
    do {
      const response = await client.approval.v4.instance.query({
        data: {
          user_id: openId,
          approval_code: cfg.writeOff.loanApprovalCode,
          instance_status: 'APPROVED',
          instance_start_time_from: String(windowStart),
          instance_start_time_to: String(windowEnd),
        },
        params: { user_id_type: 'open_id', page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
      });
      if (typeof response.code === 'number' && response.code !== 0) {
        throw new Error(`查询已通过付款申请失败 code=${response.code} msg=${response.msg}`);
      }
      for (const item of response.data?.instance_list || []) {
        const code = item.instance?.code;
        if (code) summaries.set(code, item);
      }
      pageToken = response.data?.has_more ? response.data.page_token : undefined;
      if (response.data?.has_more && !pageToken) throw new Error('查询已通过付款申请失败：飞书返回 has_more 但缺少 page_token');
    } while (pageToken);
    windowEnd = windowStart - 1;
  }
  const result: LoanReference[] = [];
  for (const item of summaries.values()) {
    const code = item.instance!.code!;
    const detail = await client.approval.v4.instance.get({ path: { instance_id: code }, params: { user_id_type: 'open_id' } });
    if (detail.data?.status !== 'APPROVED') continue;
    const loan = parseLoanDetail(detail.data, item.instance?.link?.pc_link || item.instance?.link?.mobile_link);
    const total = Number(loan.amount) || 0;
    const used = ledger.amounts(code);
    const remaining = Math.max(0, total - used.writtenOff - used.pending);
    if (remaining <= 0.005) continue;
    loan.writtenOffAmount = used.writtenOff.toFixed(2);
    loan.pendingAmount = used.pending.toFixed(2);
    loan.remainingAmount = remaining.toFixed(2);
    result.push(loan);
  }
  return result.sort((a, b) => b.approvedAt.localeCompare(a.approvedAt));
}
