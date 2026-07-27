import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as lark from '@larksuiteoapi/node-sdk';
import { InvoiceType, RecognizedInvoice } from '../types';
import { logger } from '../logger';

type Entity = { type?: string; value?: string };
type SpecificType = Exclude<InvoiceType, 'unknown'>;

/** 飞书智能文档解析额度用尽的错误码。 */
const QUOTA_LIMIT_CODE = 2110003;

/** 识别额度用尽（document_ai 2110003）。用于向用户回复明确提示。 */
export class QuotaExceededError extends Error {
  constructor(message = '发票识别额度已用尽 (document_ai code 2110003)') {
    super(message);
    this.name = 'QuotaExceededError';
  }
}

/** 判断某次识别调用的错误是否为「额度用尽」。兼容 SDK 不同的错误结构。 */
function isQuotaLimitError(e: any): boolean {
  const code = e?.response?.data?.code ?? e?.code;
  if (code === QUOTA_LIMIT_CODE) return true;
  const msg = String(e?.response?.data?.msg ?? e?.msg ?? e?.message ?? '');
  return msg.includes('Intelligent document parsing limit');
}

export interface Candidate {
  invoice: RecognizedInvoice;
  score: number;
}

function entitiesToMap(entities?: Entity[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const e of entities ?? []) {
    if (e.type && e.value != null && String(e.value).trim() !== '' && map[e.type] === undefined) {
      map[e.type] = String(e.value).trim();
    }
  }
  return map;
}

function normAmount(v?: string): string | undefined {
  if (!v) return undefined;
  const m = v.replace(/[,，]/g, '').match(/-?\d+(?:\.\d+)?/);
  return m ? m[0] : undefined;
}

function normDate(v?: string): string | undefined {
  if (!v) return undefined;
  let m = v.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = v.match(/(\d{4})(\d{2})(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return v;
}

/**
 * 各票种的「特征字段」权重。
 * 关键在于：taxi/train 拥有增值税发票绝不会有的身份字段（车号、里程、车次、站点），
 * 给它们高权重，使其在同一图片上稳压增值税识别器的通用字段（发票号/代码）。
 */
const WEIGHTS: Record<SpecificType, Record<string, number>> = {
  taxi: {
    car_number: 4,
    distance: 3,
    dispatch_fee: 2,
    additional_fee: 1,
    start_time: 1,
    end_time: 1,
    total_amount: 1,
    invoice_no: 0.5,
  },
  train: {
    train_num: 4,
    start_station: 2,
    end_station: 2,
    seat_num: 1,
    seat_cls: 1,
    ticket_num: 1,
    total_amount: 1,
  },
  vat: {
    seller_taxpayer_no: 2,
    buyer_taxpayer_no: 2,
    total_tax: 2,
    invoice_special_seal: 1,
    total_price_and_tax: 1,
    invoice_no: 0.5,
    invoice_code: 0.5,
  },
};

function scoreOf(raw: Record<string, string>, weights: Record<string, number>): number {
  let s = 0;
  for (const [k, w] of Object.entries(weights)) if (raw[k]) s += w;
  return s;
}

/** 由原始字段构造候选（纯函数，便于单测分类逻辑）。score<=0 视为未命中。 */
export function buildCandidate(type: SpecificType, raw: Record<string, string>): Candidate | null {
  const score = scoreOf(raw, WEIGHTS[type]);
  if (score <= 0) return null;

  let invoice: RecognizedInvoice;
  if (type === 'taxi') {
    const timeRange = raw.start_time
      ? `${raw.start_time}${raw.end_time ? '-' + raw.end_time : ''}`
      : '';
    invoice = {
      type: 'taxi',
      typeLabel: '出租车票',
      amount: normAmount(raw.total_amount || raw.price),
      date: normDate(raw.start_date),
      sellerName: '出租车',
      invoiceNo: raw.invoice_no,
      summary: [timeRange, raw.distance ? `${raw.distance}km` : ''].filter(Boolean).join(' ') || undefined,
      raw,
    };
  } else if (type === 'train') {
    const route = [raw.start_station, raw.end_station].filter(Boolean).join(' → ');
    invoice = {
      type: 'train',
      typeLabel: '火车票',
      amount: normAmount(raw.total_amount || raw.price),
      date: normDate(raw.time),
      sellerName: '中国铁路',
      invoiceNo: raw.ticket_num,
      summary: [route, raw.train_num, raw.seat_cls].filter(Boolean).join(' ') || undefined,
      raw,
    };
  } else {
    invoice = {
      type: 'vat',
      typeLabel: raw.invoice_name || '增值税发票',
      amount: normAmount(raw.total_price_and_tax || raw.total_price),
      date: normDate(raw.invoice_date),
      sellerName: raw.seller_name,
      buyerName: raw.buyer_name,
      invoiceNo: raw.invoice_no,
      taxAmount: normAmount(raw.total_tax),
      summary: raw.remarks || undefined,
      raw,
    };
  }
  return { invoice, score };
}

/** 从候选中选出得分最高者；特征更强的票种胜出。无候选则未知票据。 */
export function selectBest(candidates: Array<Candidate | null>): RecognizedInvoice {
  const valid = candidates.filter((c): c is Candidate => !!c);
  if (valid.length === 0) return { type: 'unknown', typeLabel: '未知票据', raw: {} };
  valid.sort((a, b) => b.score - a.score);
  logger.debug('识别候选得分：', valid.map((c) => `${c.invoice.type}=${c.score}`).join(', '));
  return valid[0].invoice;
}

// 各票种调用飞书对应识别端点，返回原始字段 map（每次新建 ReadStream，流只能消费一次）。
const EXTRACTORS: Record<SpecificType, (client: lark.Client, filePath: string) => Promise<Record<string, string>>> = {
  vat: async (client, filePath) => {
    const resp = (await client.document_ai.v1.vatInvoice.recognize({
      data: { file: fs.createReadStream(filePath) },
    })) as any;
    return entitiesToMap(resp?.vat_invoices?.[0]?.entities ?? resp?.data?.vat_invoices?.[0]?.entities);
  },
  train: async (client, filePath) => {
    const resp = (await client.document_ai.v1.trainInvoice.recognize({
      data: { file: fs.createReadStream(filePath) },
    })) as any;
    return entitiesToMap(resp?.train_invoices?.[0]?.entities ?? resp?.data?.train_invoices?.[0]?.entities);
  },
  taxi: async (client, filePath) => {
    const resp = (await client.document_ai.v1.taxiInvoice.recognize({
      data: { file: fs.createReadStream(filePath) },
    })) as any;
    return entitiesToMap(resp?.taxi_invoices?.[0]?.entities ?? resp?.data?.taxi_invoices?.[0]?.entities);
  },
};

function extForImage(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.length >= 3 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif';
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';
  return 'jpg';
}

const DEFAULT_ORDER: SpecificType[] = ['vat', 'taxi', 'train'];

/** 得分达到此阈值即视为可信命中，提前结束，省下后续票种的识别调用。 */
const CONFIDENT_SCORE = 3;

/**
 * 识别发票：按 order 顺序逐个调用票种识别器，命中即止（节省 API 额度）。
 * 某票种得分达到 CONFIDENT_SCORE 即认为可信，直接返回，不再调用后续识别器；
 * 否则继续尝试，最终按特征字段打分选出最可能的票种。
 * 图片以临时文件 + ReadStream 传入（飞书 OCR 的 multipart 需要文件名，否则 400）。
 */
export async function recognizeInvoice(
  client: lark.Client,
  file: Buffer,
  order: SpecificType[] = DEFAULT_ORDER
): Promise<RecognizedInvoice> {
  const ext = extForImage(file);
  const tmpPath = path.join(
    os.tmpdir(),
    `invoice_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`
  );
  await fs.promises.writeFile(tmpPath, file);
  try {
    const candidates: Array<Candidate | null> = [];
    let quotaExceeded = false;
    for (const t of order) {
      try {
        const raw = await EXTRACTORS[t](client, tmpPath);
        const c = buildCandidate(t, raw);
        candidates.push(c);
        // 得分足够高即认为命中，提前结束（后续票种不再消耗额度）
        if (c && c.score >= CONFIDENT_SCORE) break;
      } catch (e) {
        if (isQuotaLimitError(e)) quotaExceeded = true;
        logger.warn(`${t} 识别调用失败：`, (e as Error).message);
        candidates.push(null);
      }
    }
    const invoice = selectBest(candidates);
    // 所有识别器均因额度用尽而失败时，抛出专门错误以便给用户明确提示
    if (invoice.type === 'unknown' && quotaExceeded) throw new QuotaExceededError();
    if (invoice.type !== 'unknown') logger.info(`识别命中：${invoice.typeLabel}`);
    return invoice;
  } finally {
    fs.promises.unlink(tmpPath).catch(() => {});
  }
}
