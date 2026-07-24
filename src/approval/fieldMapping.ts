import * as fs from 'fs';
import * as path from 'path';
import { RecognizedInvoice, FormField } from '../types';
import { logger } from '../logger';

type ValueFormat = 'string' | 'number' | 'date' | 'datetime';
type FieldRole = 'reason' | 'content' | 'title';

interface FieldSpec {
  widgetId: string;
  widgetType: string;
  source?: string;
  constValue?: string;
  valueByType?: Record<string, string>;
  valueFormat?: ValueFormat;
  /** 语义角色：可被 LLM 生成结果覆盖（reason=事由, content=明细内容） */
  role?: FieldRole;
}

interface FieldListSpec {
  widgetId: string;
  widgetType: string;
  rowFields: FieldSpec[];
}

interface MappingConfig {
  title?: string;
  fields: FieldSpec[];
  fieldList?: FieldListSpec;
  /** 图片控件：把发票原图 url 填入此控件 */
  imageField?: { widgetId: string; widgetType: string };
  /** 合计金额控件（如费用汇总 formula）：填入所有发票金额之和，供条件分流判断 */
  sumField?: { widgetId: string; widgetType: string };
}

/** LLM/外部生成的覆盖值 */
export interface FormOverrides {
  title?: string;
  reason?: string;
  contents?: string[]; // 与 invoices 顺序一致，每张发票的明细内容
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

function resolveRaw(spec: FieldSpec, invoice: RecognizedInvoice): string | undefined {
  if (spec.valueByType && spec.valueByType[invoice.type] != null) return spec.valueByType[invoice.type];
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

function applyFormat(spec: FieldSpec, rawVal: string): unknown {
  const fmt = spec.valueFormat || defaultFormat(spec.widgetType);
  switch (fmt) {
    case 'number': {
      const cleaned = rawVal.replace(/[^\d.-]/g, '');
      return cleaned === '' ? undefined : cleaned;
    }
    case 'date':
      return toIsoDate(rawVal);
    case 'datetime': {
      const d = toIsoDate(rawVal);
      return /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00+08:00` : rawVal;
    }
    default:
      return rawVal;
  }
}

function formatValue(spec: FieldSpec, invoice: RecognizedInvoice): unknown {
  const rawVal = resolveRaw(spec, invoice);
  if (rawVal == null || rawVal === '') return undefined;
  return applyFormat(spec, rawVal);
}

function isPlaceholder(widgetId?: string): boolean {
  return !widgetId || widgetId.startsWith('REPLACE_');
}

/**
 * 将一张或多张发票映射为审批表单。
 * - 顶层字段（报销类型/事由）基于聚合信息；role=reason 可被 overrides.reason 覆盖。
 * - fieldList 每张发票生成一行；role=content 可被 overrides.contents[i] 覆盖。
 */
export function buildApprovalForm(
  invoices: RecognizedInvoice[],
  overrides: FormOverrides = {},
  imageUrls: string[] = []
): { form: FormField[]; title: string } {
  const cfg = loadMapping();
  const form: FormField[] = [];
  const primary = invoices[0];
  const allSame = invoices.every((v) => v.type === primary.type);
  const aggType = allSame ? primary.type : 'unknown';
  const aggLabel = allSame ? primary.typeLabel : `${invoices.length}张发票`;
  const aggInvoice: RecognizedInvoice = { ...primary, type: aggType, typeLabel: aggLabel };

  for (const spec of cfg.fields) {
    if (isPlaceholder(spec.widgetId)) {
      logger.warn(`字段映射未配置 widgetId（${spec.role ?? spec.widgetType}），已跳过`);
      continue;
    }
    let value: unknown;
    if (spec.role === 'reason' && overrides.reason) value = overrides.reason;
    else value = formatValue(spec, aggInvoice);
    if (value === undefined || value === '') continue;
    form.push({ id: spec.widgetId, type: spec.widgetType, value });
  }

  if (cfg.fieldList && !isPlaceholder(cfg.fieldList.widgetId)) {
    const rows: FormField[][] = [];
    invoices.forEach((inv, i) => {
      const row: FormField[] = [];
      for (const rf of cfg.fieldList!.rowFields) {
        if (isPlaceholder(rf.widgetId)) continue;
        let v: unknown;
        if (rf.role === 'content' && overrides.contents?.[i]) v = overrides.contents[i];
        else v = formatValue(rf, inv);
        if (v === undefined || v === '') continue;
        row.push({ id: rf.widgetId, type: rf.widgetType, value: v });
      }
      if (row.length > 0) rows.push(row);
    });
    if (rows.length > 0) {
      form.push({ id: cfg.fieldList.widgetId, type: cfg.fieldList.widgetType, value: rows });
    }
  }

  // 图片控件：填入发票原图 url 数组
  if (cfg.imageField && !isPlaceholder(cfg.imageField.widgetId) && imageUrls.length > 0) {
    form.push({ id: cfg.imageField.widgetId, type: cfg.imageField.widgetType, value: imageUrls });
  }

  // 合计金额控件：填入所有发票金额之和（条件分流依据此字段，必须填，否则默认走高限额分支）
  if (cfg.sumField && !isPlaceholder(cfg.sumField.widgetId)) {
    const total = invoices.reduce((s, v) => s + (parseFloat((v.amount || '0').replace(/[^\d.-]/g, '')) || 0), 0);
    form.push({ id: cfg.sumField.widgetId, type: cfg.sumField.widgetType, value: total.toFixed(2) });
  }

  const fallback = `费用报销-${aggLabel}`;
  const title = overrides.title
    ? overrides.title
    : cfg.title
      ? cfg.title.includes('{')
        ? renderTemplate(cfg.title, aggInvoice) || fallback
        : cfg.title
      : fallback;
  return { form, title };
}
