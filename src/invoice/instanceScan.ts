import * as lark from '@larksuiteoapi/node-sdk';
import { AppConfig } from '../config';
import { logger } from '../logger';
import { RecognizedInvoice } from '../types';
import { fetchWithTimeout } from '../util/http';
import { recognizeFileMulti } from './recognize';
import { InvoiceUsageLedger } from './dedup';
import type { ClaimMode } from '../handlers/session';

/** 秒/毫秒时间戳或日期串 → ISO 字符串；无法解析时返回当前时间。 */
function isoTime(value?: string): string {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return new Date(n < 1e10 ? n * 1000 : n).toISOString();
  const parsed = value ? new Date(value) : new Date(NaN);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

/** 从审批表单 JSON 里抽取「图片(image)/附件(attachmentV2)」控件中的所有可下载 URL。 */
export function extractFileUrls(form: string): string[] {
  let widgets: unknown[] = [];
  try {
    widgets = JSON.parse(form || '[]') as unknown[];
  } catch {
    return [];
  }
  const urls: string[] = [];
  for (const raw of widgets) {
    const w = raw as { type?: string; value?: unknown };
    if (w?.type !== 'image' && w?.type !== 'attachmentV2') continue;
    const s = typeof w.value === 'string' ? w.value : JSON.stringify(w.value ?? '');
    const matched = s.match(/https?:\/\/[^\s"'\\]+/g);
    if (matched) urls.push(...matched);
  }
  return Array.from(new Set(urls));
}

async function download(url: string, cfg: AppConfig): Promise<Buffer> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetchWithTimeout(url, {}, cfg.requestTimeoutMs);
      if (!r.ok) throw new Error(`下载 HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      lastErr = e;
      if (attempt < 3) await new Promise((res) => setTimeout(res, 1500 * attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export interface ScanResult {
  /** 是否因已处理过/已在台账而跳过（未下载、未识别）。 */
  skipped: boolean;
  /** 本次识别到的发票张数（含重复）。 */
  scanned: number;
  /** 本次新增写入台账的指纹数。 */
  added: number;
  /** 表单中是否含可下载的图片/附件。 */
  hasFiles: boolean;
}

/**
 * 扫描单个审批实例：下载表单里的发票 → OCR → 写入检重台账（status=submitted）。
 * 幂等：若该实例已在台账中登记（含机器人自建实例）则直接跳过。
 * 注意：调用方需自行做「同一实例并发去重」（见 approvalHandler 的 in-flight 集合）。
 */
export async function scanInstanceInvoices(
  client: lark.Client,
  cfg: AppConfig,
  ledger: InvoiceUsageLedger,
  instanceCode: string,
  mode: ClaimMode
): Promise<ScanResult> {
  if (ledger.hasInstance(instanceCode)) {
    return { skipped: true, scanned: 0, added: 0, hasFiles: false };
  }

  const detail = (await client.approval.v4.instance.get({ path: { instance_id: instanceCode } })) as {
    data?: { status?: string; form?: string; open_id?: string; user_id?: string; start_time?: string; end_time?: string };
  };
  const d = detail.data || {};
  const urls = extractFileUrls(d.form || '');
  if (urls.length === 0) {
    return { skipped: false, scanned: 0, added: 0, hasFiles: false };
  }

  const openId = d.open_id || d.user_id || '';
  const invoices: RecognizedInvoice[] = [];
  for (const url of urls) {
    try {
      const buf = await download(url, cfg);
      const invs = await recognizeFileMulti(cfg, buf);
      invoices.push(...invs);
    } catch (e) {
      logger.warn(`外部审批发票下载/识别失败（instance=${instanceCode}）：`, (e as Error).message);
    }
  }

  const added = ledger.ingestSubmitted(invoices, mode, openId, instanceCode, {
    createdAt: isoTime(d.start_time),
    submittedAt: isoTime(d.end_time || d.start_time),
  });
  return { skipped: false, scanned: invoices.length, added, hasFiles: true };
}
