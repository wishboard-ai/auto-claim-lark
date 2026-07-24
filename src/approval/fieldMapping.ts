import * as fs from 'fs';
import * as path from 'path';
import { RecognizedInvoice, FormField } from '../types';
import { logger } from '../logger';

type ValueFormat = 'string' | 'number' | 'date' | 'datetime';

interface FieldSpec {
  /** 审批表单控件 ID（通过 npm run inspect:approval 获取） */
  widgetId: string;
  /** 控件类型：input | textarea | number | amount | date | radioV2 | ... */
  widgetType: string;
  /** 取值来源：RecognizedInvoice 字段名 / raw 原始字段名 / 模板 "{sellerName}-{invoiceNo}" */
  source?: string;
  /** 固定值（优先于 source）；如 radioV2 的选项 id */
  constValue?: string;
  /** 按票种取值（优先于 constValue/source）；键为 vat|train|taxi */
  valueByType?: Record<string, string>;
  /** 值格式化方式，缺省按控件类型推断 */
  valueFormat?: ValueFormat;
}

/** 明细控件组（fieldList），每张发票生成一行 */
interface FieldListSpec {
  widgetId: string;
  widgetType: string; // 通常为 fieldList
  rowFields: FieldSpec[];
}

interface MappingConfig {
  title?: string;
  fields: FieldSpec[];
  fieldList?: FieldListSpec;
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
    .replace(/\s+/g, ' ')
    .trim();
}

function pick(invoice: RecognizedInvoice, source: string): string | undefined {
  if (source.includes('{')) return renderTemplate(source, invoice);
  const direct = (invoice as unknown as Record<string, unknown>)[source] ?? invoice.raw[source];
  return direct != null ? String(direct) : undefined;
}

/** 解析出格式化前的原始取值：valueByType > constValue > source */
function resolveRaw(spec: FieldSpec, invoice: RecognizedInvoice): string | undefined {
  if (spec.valueByType && spec.valueByType[invoice.type] != null) {
    return spec.valueByType[invoice.type];
  }
  if (spec.constValue != null) return spec.constValue;
  if (spec.source) return pick(invoice, spec.source);
  return undefined;
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
  const rawVal = resolveRaw(spec, invoice);
  if (rawVal == null || rawVal === '') return undefined;
  const fmt = spec.valueFormat || defaultFormat(spec.widgetType);
  switch (fmt) {
    case 'number': {
      const cleaned = rawVal.replace(/[^\d.-]/g, '');
      return cleaned === '' ? undefined : cleaned; // 数值/金额控件的值以字符串传入
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

function isPlaceholder(widgetId?: string): boolean {
  return !widgetId || widgetId.startsWith('REPLACE_');
}

/** 根据配置将识别结果映射为审批表单字段数组与标题 */
export function buildApprovalForm(invoice: RecognizedInvoice): { form: FormField[]; title: string } {
  const cfg = loadMapping();
  const form: FormField[] = [];

  for (const spec of cfg.fields) {
    if (isPlaceholder(spec.widgetId)) {
      logger.warn(`字段映射未配置 widgetId（source=${spec.source ?? spec.widgetType}），已跳过`);
      continue;
    }
    const value = formatValue(spec, invoice);
    if (value === undefined) continue;
    form.push({ id: spec.widgetId, type: spec.widgetType, value });
  }

  // 明细控件组：生成单行
  if (cfg.fieldList && !isPlaceholder(cfg.fieldList.widgetId)) {
    const row: FormField[] = [];
    for (const rf of cfg.fieldList.rowFields) {
      if (isPlaceholder(rf.widgetId)) continue;
      const v = formatValue(rf, invoice);
      if (v === undefined) continue;
      row.push({ id: rf.widgetId, type: rf.widgetType, value: v });
    }
    if (row.length > 0) {
      form.push({ id: cfg.fieldList.widgetId, type: cfg.fieldList.widgetType, value: [row] });
    }
  }

  const fallback = `费用报销-${invoice.typeLabel}`;
  const title = cfg.title
    ? cfg.title.includes('{')
      ? renderTemplate(cfg.title, invoice) || fallback
      : cfg.title
    : fallback;
  return { form, title };
}
