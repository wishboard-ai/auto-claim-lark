import * as lark from '@larksuiteoapi/node-sdk';
import { InvoiceType, RecognizedInvoice } from '../types';
import { logger } from '../logger';

type Entity = { type?: string; value?: string };

function entitiesToMap(entities?: Entity[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const e of entities ?? []) {
    if (e.type && e.value != null && map[e.type] === undefined) {
      map[e.type] = e.value;
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

type Recognizer = (client: lark.Client, file: Buffer) => Promise<RecognizedInvoice | null>;

const recognizeVat: Recognizer = async (client, file) => {
  const resp = (await client.document_ai.v1.vatInvoice.recognize({ data: { file } })) as any;
  const entities: Entity[] | undefined =
    resp?.vat_invoices?.[0]?.entities ?? resp?.data?.vat_invoices?.[0]?.entities;
  const raw = entitiesToMap(entities);
  if (!raw.total_price_and_tax && !raw.invoice_no && !raw.invoice_code) return null;
  return {
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
};

const recognizeTrain: Recognizer = async (client, file) => {
  const resp = (await client.document_ai.v1.trainInvoice.recognize({ data: { file } })) as any;
  const entities: Entity[] | undefined =
    resp?.train_invoices?.[0]?.entities ?? resp?.data?.train_invoices?.[0]?.entities;
  const raw = entitiesToMap(entities);
  if (!raw.total_amount && !raw.ticket_num && !raw.train_num) return null;
  const route = [raw.start_station, raw.end_station].filter(Boolean).join(' → ');
  return {
    type: 'train',
    typeLabel: '火车票',
    amount: normAmount(raw.total_amount || raw.price),
    date: normDate(raw.time),
    sellerName: '中国铁路',
    invoiceNo: raw.ticket_num,
    summary: [route, raw.train_num, raw.seat_cls].filter(Boolean).join(' ') || undefined,
    raw,
  };
};

const recognizeTaxi: Recognizer = async (client, file) => {
  const resp = (await client.document_ai.v1.taxiInvoice.recognize({ data: { file } })) as any;
  const entities: Entity[] | undefined =
    resp?.taxi_invoices?.[0]?.entities ?? resp?.data?.taxi_invoices?.[0]?.entities;
  const raw = entitiesToMap(entities);
  if (!raw.total_amount && !raw.invoice_no) return null;
  const timeRange = raw.start_time
    ? `${raw.start_time}${raw.end_time ? '-' + raw.end_time : ''}`
    : '';
  return {
    type: 'taxi',
    typeLabel: '出租车票',
    amount: normAmount(raw.total_amount || raw.price),
    date: normDate(raw.start_date),
    sellerName: '出租车',
    invoiceNo: raw.invoice_no,
    summary: [timeRange, raw.distance ? `${raw.distance}km` : ''].filter(Boolean).join(' ') || undefined,
    raw,
  };
};

const RECOGNIZERS: Record<Exclude<InvoiceType, 'unknown'>, Recognizer> = {
  vat: recognizeVat,
  train: recognizeTrain,
  taxi: recognizeTaxi,
};

const DEFAULT_ORDER: Array<Exclude<InvoiceType, 'unknown'>> = ['vat', 'train', 'taxi'];

/**
 * 识别发票。飞书未提供统一的票种分类接口，故按优先级顺序尝试各识别器，
 * 命中（返回结构化字段）即返回，最多 3 次 API 调用。可通过 order 调整顺序或裁剪票种。
 */
export async function recognizeInvoice(
  client: lark.Client,
  file: Buffer,
  order: Array<Exclude<InvoiceType, 'unknown'>> = DEFAULT_ORDER
): Promise<RecognizedInvoice> {
  for (const t of order) {
    try {
      const result = await RECOGNIZERS[t](client, file);
      if (result) {
        logger.info(`识别命中：${result.typeLabel}`);
        return result;
      }
    } catch (e) {
      logger.warn(`${t} 识别调用失败：`, (e as Error).message);
    }
  }
  return { type: 'unknown', typeLabel: '未知票据', raw: {} };
}
