import * as fs from 'fs';
import * as path from 'path';
import { RecognizedInvoice, FormField } from '../types';
import { logger } from '../logger';

type ValueFormat = 'string' | 'number' | 'date' | 'datetime';

interface FieldSpec {
  /** 审批表单控件 ID（通过 npm run inspect:approval 获取） */
  widgetId: string;
  /** 控件类型：input | textarea | number | amount | date | ... */
  widgetType: string;
  /** 取值来源：RecognizedInvoice 字段名 / raw 原始字段名 / 模板 "{sellerName}-{invoiceNo}" */
  source: string;
  /** 值格式化方式，缺省按控件类型推断 */
  valueFormat?: ValueFormat;
}

interface MappingConfig {
  title?: string;
  fields: FieldSpec[];
}

const MAPPING_PATH =
  process.env.FIELD_MAPPING_PATH || path.resolve(process.cwd(), 'config', 'field-mapping.json');

let cached: MappingConfig | null = null;

function loadMapping(): MappingConfig {
  if (cached) return cached;
  const raw = fs.readFileSync(MAPPING_PATH, 'utf-8');
  const parsed = JSON.parse(raw) as MappingConfig;
  if (!Array.isArray(parsed.fields)) {
    throw new Error(`字段映射配置无效：${MAPPING_PATH} 缺少 fields 数组`);
  }
  cached = parsed;
  return parsed;
}

function renderTemplate(tpl: string, invoice: RecognizedInvoice): string {
  return tpl
    .replace(/\{(\w+)\}/g, (_, k: string) => {
      const val = (invoice as unknown as Record<string, unknown>)[k] ?? invoice.raw[k];
      return val != null ? String(val) : '';
    })
    .trim();
}

function pick(invoice: RecognizedInvoice, source: string): string | undefined {
  if (source.includes('{')) return renderTemplate(source, invoice);
  const direct = (invoice as unknown as Record<string, unknown>)[source] ?? invoice.raw[source];
  return direct != null ? String(direct) : undefined;
}

function defaultFormat(widgetType: string): ValueFormat {
  switch (widgetType) {
    case 'number':
    case 'amount':
      return 'number';
    case 'date':
    case 'dateInterval':
      return 'date';
    default:
      return 'string';
  }
}

function toIsoDate(v: string): string {
  const m = v.match(/(\d{4})\D*(\d{1,2})\D*(\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : v;
}

function formatValue(spec: FieldSpec, invoice: RecognizedInvoice): unknown {
  const rawVal = pick(invoice, spec.source);
  if (rawVal == null || rawVal === '') return undefined;
  const fmt = spec.valueFormat || defaultFormat(spec.widgetType);
  switch (fmt) {
    case 'number': {
      const cleaned = rawVal.replace(/[^\d.-]/g, '');
      return cleaned === '' ? undefined : cleaned; // 飞书数值/金额控件的值以字符串传入
    }
    case 'date':
      return toIsoDate(rawVal); // YYYY-MM-DD
    case 'datetime': {
      const d = toIsoDate(rawVal);
      return /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00+08:00` : rawVal;
    }
    default:
      return rawVal;
  }
}

/** 根据配置将识别结果映射为审批表单字段数组与标题 */
export function buildApprovalForm(invoice: RecognizedInvoice): { form: FormField[]; title: string } {
  const cfg = loadMapping();
  const form: FormField[] = [];
  for (const spec of cfg.fields) {
    if (!spec.widgetId || spec.widgetId.startsWith('REPLACE_')) {
      logger.warn(
        `字段映射未配置 widgetId（source=${spec.source}）；请运行 npm run inspect:approval 获取控件ID后填入 config/field-mapping.json`
      );
      continue;
    }
    const value = formatValue(spec, invoice);
    if (value === undefined) continue;
    form.push({ id: spec.widgetId, type: spec.widgetType, value });
  }
  const fallback = `费用报销-${invoice.typeLabel}`;
  const title = cfg.title
    ? cfg.title.includes('{')
      ? renderTemplate(cfg.title, invoice) || fallback
      : cfg.title
    : fallback;
  return { form, title };
}
