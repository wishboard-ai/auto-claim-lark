import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { RecognizedInvoice } from '../types';
import type { ClaimMode } from '../handlers/session';

export type InvoiceUsageStatus = 'reserved' | 'submitted';

export interface InvoiceUsageEntry {
  fingerprint: string;
  description: string;
  status: InvoiceUsageStatus;
  reservationId: string;
  mode: ClaimMode;
  applicantOpenId: string;
  createdAt: string;
  approvalInstanceCode?: string;
  submittedAt?: string;
}

interface InvoiceUsageFile {
  version: 1;
  entries: InvoiceUsageEntry[];
}

export interface InvoiceDuplicate {
  invoice: RecognizedInvoice;
  fingerprint: string;
  description: string;
  existing?: InvoiceUsageEntry;
  duplicateInBatch?: boolean;
}

export class InvoiceDuplicateError extends Error {
  constructor(public readonly duplicate: InvoiceDuplicate) {
    super(
      duplicate.duplicateInBatch
        ? `同一批次中存在重复发票：${duplicate.description}`
        : `发票已被使用：${duplicate.description}`
    );
    this.name = 'InvoiceDuplicateError';
  }
}

function normalized(value?: string): string {
  return (value || '').normalize('NFKC').toUpperCase().replace(/[^0-9A-Z\u4e00-\u9fff]/g, '');
}

function normalizedAmount(value?: string): string {
  const cleaned = (value || '').replace(/[^\d.-]/g, '');
  if (!cleaned) return '';
  const amount = Number(cleaned);
  return Number.isFinite(amount) ? amount.toFixed(2) : '';
}

/**
 * 生成稳定发票指纹。优先使用发票/票据号码；号码缺失时才使用票种、日期、金额、商家等字段哈希。
 * 使用 invoiceNo 单独作为主键，是为了同一发票一次识别到 invoiceCode、另一次未识别到时仍能检重。
 */
export function invoiceFingerprint(invoice: RecognizedInvoice): string {
  const number = normalized(invoice.invoiceNo);
  if (number) return `number:${invoice.type}:${number}`;

  const code = normalized(invoice.invoiceCode);
  if (code) return `code:${invoice.type}:${code}`;

  const canonical = [
    invoice.type,
    normalized(invoice.date),
    normalizedAmount(invoice.amount),
    normalized(invoice.sellerName),
    normalized(invoice.buyerName),
    normalized(invoice.summary),
    normalized(invoice.checkCode),
  ].join('|');
  return `fallback:${crypto.createHash('sha256').update(canonical).digest('hex')}`;
}

export function describeInvoice(invoice: RecognizedInvoice): string {
  const parts = [invoice.typeLabel];
  if (invoice.invoiceNo) parts.push(`号码 ${invoice.invoiceNo}`);
  if (invoice.date) parts.push(invoice.date);
  if (invoice.amount) parts.push(`¥${invoice.amount}`);
  return parts.join(' · ');
}

/** 跨费用报销与借款核销共用的发票使用台账。 */
export class InvoiceUsageLedger {
  private readonly filePath: string;
  private data: InvoiceUsageFile;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
    this.data = this.load();
  }

  private load(): InvoiceUsageFile {
    if (!fs.existsSync(this.filePath)) return { version: 1, entries: [] };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<InvoiceUsageFile>;
      if (!Array.isArray(parsed.entries)) throw new Error('缺少 entries 数组');
      return { version: 1, entries: parsed.entries as InvoiceUsageEntry[] };
    } catch (error) {
      throw new Error(`发票检重台账读取失败 ${this.filePath}：${(error as Error).message}`);
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, this.filePath);
  }

  find(invoice: RecognizedInvoice): InvoiceUsageEntry | undefined {
    const fingerprint = invoiceFingerprint(invoice);
    const entry = this.data.entries.find((item) => item.fingerprint === fingerprint);
    return entry ? { ...entry } : undefined;
  }

  /** 原子校验一批发票并占用；创建审批失败时必须调用 release。 */
  reserve(invoices: RecognizedInvoice[], mode: ClaimMode, applicantOpenId: string): string {
    const seen = new Set<string>();
    for (const invoice of invoices) {
      const fingerprint = invoiceFingerprint(invoice);
      const description = describeInvoice(invoice);
      if (seen.has(fingerprint)) {
        throw new InvoiceDuplicateError({ invoice, fingerprint, description, duplicateInBatch: true });
      }
      seen.add(fingerprint);
      const existing = this.data.entries.find((item) => item.fingerprint === fingerprint);
      if (existing) throw new InvoiceDuplicateError({ invoice, fingerprint, description, existing: { ...existing } });
    }

    const reservationId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    for (const invoice of invoices) {
      this.data.entries.push({
        fingerprint: invoiceFingerprint(invoice),
        description: describeInvoice(invoice),
        status: 'reserved',
        reservationId,
        mode,
        applicantOpenId,
        createdAt,
      });
    }
    try {
      this.save();
    } catch (error) {
      this.data.entries = this.data.entries.filter((entry) => entry.reservationId !== reservationId);
      throw error;
    }
    return reservationId;
  }

  markSubmitted(reservationId: string, approvalInstanceCode: string): void {
    const entries = this.data.entries.filter((entry) => entry.reservationId === reservationId);
    if (!entries.length) throw new Error(`发票检重台账中未找到预占记录 ${reservationId}`);
    const submittedAt = new Date().toISOString();
    for (const entry of entries) {
      entry.status = 'submitted';
      entry.approvalInstanceCode = approvalInstanceCode;
      entry.submittedAt = submittedAt;
    }
    this.save();
  }

  release(reservationId: string): void {
    const before = this.data.entries.length;
    this.data.entries = this.data.entries.filter(
      (entry) => entry.reservationId !== reservationId || entry.status === 'submitted'
    );
    if (this.data.entries.length !== before) this.save();
  }
}
