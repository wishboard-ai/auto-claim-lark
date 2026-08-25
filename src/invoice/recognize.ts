import { AppConfig } from '../config';
import { InvoiceType, RecognizedInvoice } from '../types';
import { logger } from '../logger';
import { fetchWithTimeout } from '../util/http';
import { isPdf, extractPdfText, hasUsableText, pdfFirstPageToImage } from './pdf';
import { isHeic, heicToJpeg, isOfd, extractOfdText } from './formats';

/** OCR 前预处理图片：HEIC/HEIF 转 JPEG（视觉模型/本地OCR无法直接读取）。其余原样返回。 */
async function prepOcrImage(buf: Buffer): Promise<Buffer> {
  if (isHeic(buf)) {
    logger.info('检测到 HEIC/HEIF 图片，转换为 JPEG 后识别…');
    try {
      return await heicToJpeg(buf);
    } catch (e) {
      logger.warn('HEIC 转换失败，尝试按原样识别：', (e as Error).message);
      return buf;
    }
  }
  return buf;
}

/**
 * 发票识别。支持两种后端（OCR_PROVIDER）：
 * - openai：OpenAI 兼容的多模态大模型（云端 qwen-vl-max，或本地 Ollama 的 qwen2.5vl）。
 * - paddle：本地 PaddleOCR 微服务（见 ocr/ocr_service.py），零 API 成本、适合低配机器。
 * 两种后端都产出统一的结构化 JSON，经同一 buildFromParsed 归一化为 RecognizedInvoice。
 */

/** 识别额度/费用相关错误（额度用尽、欠费、限流）。用于向用户回复明确提示。 */
export class QuotaExceededError extends Error {
  constructor(message = '发票识别额度已用尽或账户欠费') {
    super(message);
    this.name = 'QuotaExceededError';
  }
}

/** 未配置 OCR（缺少 API Key）时抛出，便于给出配置指引。 */
export class OcrNotConfiguredError extends Error {
  constructor(message = '未配置发票识别服务（缺少 OCR/LLM API Key）') {
    super(message);
    this.name = 'OcrNotConfiguredError';
  }
}

// ---- 归一化工具（金额 / 日期） ----

function normAmount(v?: unknown): string | undefined {
  if (v == null) return undefined;
  const m = String(v).replace(/[,，]/g, '').match(/-?\d+(?:\.\d+)?/);
  return m ? m[0] : undefined;
}

function normDate(v?: unknown): string | undefined {
  if (v == null) return undefined;
  const s = String(v);
  let m = s.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/(\d{4})(\d{2})(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const t = s.trim();
  return t || undefined;
}

function strOrUndef(v?: unknown): string | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s && s.toLowerCase() !== 'null' && s !== '无' ? s : undefined;
}

// ---- 发票号码/代码清洗（按票种的标准位数校验，剔除占位词与明显错误） ----

// 占位/无意义取值（模型有时会把"未知/无/N/A"等填进号码字段）
const PLACEHOLDER_TOKENS = new Set([
  '未知', '无', '无号码', '未提供', '不详', '待定', '暂无', 'none', 'null', 'nil', 'na', 'n/a',
  '-', '—', '/', '?', '？', '*', '空',
]);
function isPlaceholderToken(s: string): boolean {
  const t = s.replace(/\s/g, '').toLowerCase();
  return t === '' || PLACEHOLDER_TOKENS.has(t);
}

/**
 * 清洗发票号码：按票种「统一的位数格式」校验，剔除占位词/明显错误（如误把统一社会信用代码、
 * 纳税人识别号当作发票号码）。校验不通过返回 undefined（视为无号码 → 指纹回退到字段哈希，
 * 避免不同发票因错误号码撞成同一"毒指纹"）。
 * - 增值税发票：发票号码为纯数字，8 位(传统专普票) 或 20 位(全电/电子发票)。
 * - 出租车票：发票号码为 8 位纯数字（与 12 位发票代码组合共 20 位才唯一）；亦接受已组合的 20 位。
 * - 火车票：字母+数字（如 E123456789）或电子发票号，长度 8~25。
 */
function cleanInvoiceNo(type: InvoiceType, raw?: unknown): string | undefined {
  const s = strOrUndef(raw);
  if (!s || isPlaceholderToken(s)) return undefined;
  const compact = s.replace(/[\s\-]/g, '');
  if (type === 'vat') return /^\d{8}$/.test(compact) || /^\d{20}$/.test(compact) ? compact : undefined;
  if (type === 'taxi') return /^\d{8}$/.test(compact) || /^\d{20}$/.test(compact) ? compact : undefined;
  if (type === 'train') return /^[0-9A-Za-z]{8,25}$/.test(compact) ? compact.toUpperCase() : undefined;
  return compact.length >= 6 ? compact : undefined;
}

/** 清洗发票代码：增值税/出租车发票代码为纯数字（增值税 10/12 位、出租车 12 位）；其余 6~15 位放宽。 */
function cleanInvoiceCode(type: InvoiceType, raw?: unknown): string | undefined {
  const s = strOrUndef(raw);
  if (!s || isPlaceholderToken(s)) return undefined;
  const compact = s.replace(/[\s\-]/g, '');
  if (type === 'vat') return /^\d{10}$/.test(compact) || /^\d{12}$/.test(compact) ? compact : undefined;
  if (type === 'taxi') return /^\d{12}$/.test(compact) ? compact : undefined;
  return /^\d{6,15}$/.test(compact) ? compact : undefined;
}

/**
 * 归一化发票号码与代码。出租车票唯一标识 = 12 位发票代码 + 8 位发票号码（共 20 位）：
 * - 有 12 位代码 + 8 位号码 → 组合成 20 位作为号码（指纹更唯一）；
 * - 已是 20 位号码 → 原样保留；
 * - 只有 8 位号码而无有效代码 → 不足以唯一 → 弃用号码，走 fallback 指纹。
 */
function resolveNoAndCode(
  type: InvoiceType,
  rawNo?: unknown,
  rawCode?: unknown
): { invoiceNo?: string; invoiceCode?: string } {
  let invoiceNo = cleanInvoiceNo(type, rawNo);
  const invoiceCode = cleanInvoiceCode(type, rawCode);
  if (type === 'taxi' && invoiceNo && /^\d{8}$/.test(invoiceNo)) {
    invoiceNo = invoiceCode && /^\d{12}$/.test(invoiceCode) ? invoiceCode + invoiceNo : undefined;
  }
  return { invoiceNo, invoiceCode };
}

// ---- 图片 MIME 识别 ----

function mimeForImage(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 3 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  return 'image/jpeg';
}

// ---- JSON 解析（容忍模型包裹 ```json 代码块或前后多余文字） ----

function extractJson(text: string): any | null {
  const stripped = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(stripped);
  } catch {
    /* ignore */
  }
  const m = stripped.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch {
      /* ignore */
    }
  }
  return null;
}

const TYPE_LABELS: Record<Exclude<InvoiceType, 'unknown'>, string> = {
  vat: '增值税发票',
  train: '火车票',
  taxi: '出租车票',
};

/** 统一映射：结构化对象 -> RecognizedInvoice（两种 provider 共用）。 */
function buildFromParsed(parsed: Record<string, unknown>): RecognizedInvoice {
  const rawType = String(parsed.type || '').toLowerCase();
  const type: InvoiceType =
    rawType === 'vat' || rawType === 'train' || rawType === 'taxi' ? (rawType as InvoiceType) : 'unknown';

  if (type === 'unknown') {
    logger.warn(`未识别为已知票种（vat/train/taxi）：type=${JSON.stringify(parsed.type)}`);
    return { type: 'unknown', typeLabel: '未知票据', raw: normalizeRaw(parsed) };
  }

  const { invoiceNo, invoiceCode } = resolveNoAndCode(type, parsed.invoiceNo, parsed.invoiceCode);
  const invoice: RecognizedInvoice = {
    type,
    typeLabel: strOrUndef(parsed.typeLabel) || TYPE_LABELS[type],
    amount: normAmount(parsed.amount),
    date: normDate(parsed.date),
    sellerName:
      strOrUndef(parsed.sellerName) || (type === 'train' ? '中国铁路' : type === 'taxi' ? '出租车' : undefined),
    buyerName: strOrUndef(parsed.buyerName),
    invoiceNo,
    invoiceCode,
    checkCode: strOrUndef(parsed.checkCode),
    taxAmount: normAmount(parsed.taxAmount),
    summary: strOrUndef(parsed.summary),
    raw: normalizeRaw(parsed),
  };
  logger.info(`识别命中：${invoice.typeLabel}`);
  return invoice;
}

/** 把结构化对象扁平化为 Record<string,string>，便于调试与字段映射的 raw 取值。 */
function normalizeRaw(parsed: Record<string, unknown>): Record<string, string> {
  const raw: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (v == null) continue;
    const s = String(v).trim();
    if (s) raw[k] = s;
  }
  return raw;
}

// ============ provider: openai（多模态大模型） ============

// 字段抽取规则（图片识别与文本识别共用）。「图片/票面」措辞用占位符 {SRC} 适配两种输入。
const FIELD_SPEC =
  '字段说明：\n' +
  '- type: 票种，取值 "vat"(增值税发票/电子发票/普票专票)、"train"(火车票)、"taxi"(出租车票/网约车行程单)，无法判断填 "unknown"。\n' +
  '  判定要点：只要票面具备增值税发票要素（有「价税合计」「纳税人识别号」「销售方/购买方」等），' +
  '即使服务内容是客运/出租车/网约车（如滴滴电子发票），也应归为 "vat"；' +
  '"taxi" 仅用于没有增值税发票要素的出租车定额发票/纸质车票/行程单，"train" 仅用于铁路车票；\n' +
  '- amount: 报销总额（元，含税），只要数字。务必取【含税总额】而非不含税金额：\n' +
  '  · 增值税发票/电子发票：取「价税合计」（即「价税合计（小写）」后的金额，等于 合计金额 + 合计税额），' +
  '严禁取「金额」列或不含税的「合计」小计（那是税前金额，通常比价税合计小）；\n' +
  '  · 火车票/出租车/网约车：取实付总额（含税）；\n' +
  '  · 若同时出现「金额/合计（不含税）」与「价税合计（含税）」两个数，一律取较大的价税合计；\n' +
  '- date: 开票/乘车日期，格式 YYYY-MM-DD；\n' +
  '- sellerName: 销售方/商家/承运方名称；\n' +
  '- buyerName: 购买方名称（无则留空）；\n' +
  '- invoiceNo: 发票号码/票号。增值税发票为【8 位或 20 位纯数字】；出租车票为【8 位纯数字】（其 12 位发票代码填到 invoiceCode）；' +
  '切勿把纳税人识别号/统一社会信用代码(18位含字母)/日期/金额当作发票号码，找不到就留空；\n' +
  '- invoiceCode: 发票代码（传统增值税发票 10 或 12 位、出租车票 12 位，纯数字；全电发票通常没有；无则留空）；\n' +
  '- checkCode: 校验码（票面有则填写，无则留空）；\n' +
  '- taxAmount: 税额（元，仅增值税发票，只要数字，无则留空）；\n' +
  '- summary: 摘要（如 出发站→到达站、车次、里程、时间等，无则留空）。\n' +
  '严禁编造{SRC}中不存在的信息，找不到的字段填空字符串。\n' +
  '返回示例：{"type":"train","amount":"553.5","date":"2024-01-15","sellerName":"中国铁路",' +
  '"buyerName":"","invoiceNo":"E123456789","invoiceCode":"","checkCode":"","taxAmount":"",' +
  '"summary":"北京南→上海虹桥 G1 二等座"}';

const EXTRACT_PROMPT =
  '你是发票识别助手。请识别图片中的票据类型并抽取关键字段，只返回一个严格的 JSON 对象，' +
  '不要输出任何解释、Markdown 代码块或多余文字。' +
  FIELD_SPEC.replace(/\{SRC\}/g, '图片');

// 文本型 PDF：直接把 PDF 文字层内容交给文本模型抽取（无需栅格化/视觉）。
const EXTRACT_PROMPT_TEXT =
  '你是发票识别助手。下面是从一张发票 PDF 中提取的文字层内容（可能顺序错乱、含多余换行/空格），' +
  '请据此判断票据类型并抽取关键字段，只返回一个严格的 JSON 对象，' +
  '不要输出任何解释、Markdown 代码块或多余文字。' +
  FIELD_SPEC.replace(/\{SRC\}/g, '文本');

function isQuotaOrBillingError(status: number, bodyText: string): boolean {
  if (status === 429) return true;
  const t = bodyText.toLowerCase();
  return (
    t.includes('arrearage') ||
    t.includes('insufficient') ||
    t.includes('quota') ||
    t.includes('throttling') ||
    t.includes('allocated') ||
    t.includes('欠费') ||
    t.includes('额度')
  );
}

// 是否为本地 Ollama 端点
function isLocalOllama(baseUrl: string): boolean {
  return /(?:localhost|127\.0\.0\.1):11434/.test(baseUrl);
}

// 由 OpenAI 兼容 base（.../v1）推出 Ollama 原生 API 根地址
function ollamaRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
}

// 同一模型的拉取只进行一次（并发请求共享同一个 Promise；失败则允许后续重试）
const pullInFlight = new Map<string, Promise<void>>();

/** 调用 Ollama /api/pull 流式拉取模型，读取进度以保持连接、避免超时。 */
async function pullOllamaModel(baseUrl: string, model: string): Promise<void> {
  const key = `${ollamaRoot(baseUrl)}|${model}`;
  const existing = pullInFlight.get(key);
  if (existing) return existing;

  const task = (async () => {
    const url = `${ollamaRoot(baseUrl)}/api/pull`;
    const t0 = Date.now();
    logger.info(`Ollama 模型未就绪，自动拉取：${model}（首次较慢，请稍候）…`);
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model }), // 默认流式，返回 NDJSON 进度
    });
    if (!resp.ok || !resp.body) {
      const b = await resp.text().catch(() => '');
      throw new Error(`自动拉取模型失败 HTTP ${resp.status}：${b.slice(0, 200)}`);
    }
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let lastLog = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const o: any = JSON.parse(line);
          if (o.error) throw new Error(String(o.error));
          const now = Date.now();
          if (o.status && now - lastLog > 3000) {
            const pct = o.completed && o.total ? ` ${Math.floor((o.completed / o.total) * 100)}%` : '';
            logger.info(`拉取 ${model}：${o.status}${pct}`);
            lastLog = now;
          }
        } catch {
          /* 忽略半行/非 JSON */
        }
      }
    }
    logger.info(`模型拉取完成：${model}（耗时 ${Math.floor((Date.now() - t0) / 1000)}s）`);
  })();

  // 失败时移除缓存，允许下次重试；成功则保留（避免重复拉取）
  const guarded = task.catch((e) => {
    pullInFlight.delete(key);
    throw e;
  });
  pullInFlight.set(key, guarded);
  return guarded;
}

async function recognizeViaOpenAI(cfg: AppConfig, file: Buffer): Promise<RecognizedInvoice> {
  const { ocr } = cfg;
  const img = await prepOcrImage(file);
  const dataUri = `data:${mimeForImage(img)};base64,${img.toString('base64')}`;
  logger.info(`调用 OCR 识别（provider=openai, model=${ocr.model}, 图片 ${img.length} 字节）…`);
  return openAIChatToInvoice(cfg, [
    { type: 'image_url', image_url: { url: dataUri } },
    { type: 'text', text: EXTRACT_PROMPT },
  ]);
}

/** 文本型 PDF：把提取到的文字层交给文本模型抽取（openai provider）。 */
async function recognizeTextViaOpenAI(cfg: AppConfig, text: string): Promise<RecognizedInvoice> {
  const { ocr } = cfg;
  logger.info(`调用文本识别（provider=openai, model=${ocr.model}, 文本 ${text.length} 字）…`);
  return openAIChatToInvoice(cfg, [
    { type: 'text', text: `${EXTRACT_PROMPT_TEXT}\n\n===== 发票文本 =====\n${text}` },
  ]);
}

/** 发送 OpenAI 兼容 chat/completions（图片或纯文本），解析返回为 RecognizedInvoice。 */
async function openAIChatToInvoice(cfg: AppConfig, content: unknown): Promise<RecognizedInvoice> {
  const { ocr } = cfg;
  if (!ocr.apiKey) throw new OcrNotConfiguredError();
  const url = `${ocr.baseUrl.replace(/\/$/, '')}/chat/completions`;

  const body = JSON.stringify({
    model: ocr.model,
    messages: [{ role: 'user', content }],
    temperature: 0,
  });
  const postChat = () =>
    fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ocr.apiKey}` },
        body,
      },
      cfg.requestTimeoutMs
    );

  let resp: Response;
  try {
    resp = await postChat();
  } catch (e) {
    logger.warn('OCR 请求发送失败：', (e as Error).message);
    throw e;
  }

  if (!resp.ok) {
    let bodyText = await resp.text().catch(() => '');
    // 本地 Ollama 且模型未拉取（404 model not found）→ 自动拉取并重试一次
    if (resp.status === 404 && isLocalOllama(ocr.baseUrl) && /not\s*found/i.test(bodyText)) {
      try {
        await pullOllamaModel(ocr.baseUrl, ocr.model);
        resp = await postChat();
      } catch (e) {
        throw new Error(`自动拉取模型失败：${(e as Error).message}`);
      }
      if (!resp.ok) bodyText = await resp.text().catch(() => '');
    }
    if (!resp.ok) {
      logger.warn(`OCR 调用失败 HTTP ${resp.status}：${bodyText.slice(0, 300)}`);
      if (isQuotaOrBillingError(resp.status, bodyText)) throw new QuotaExceededError();
      throw new Error(`OCR 调用失败 HTTP ${resp.status}`);
    }
  }

  const data: any = await resp.json();
  const text: string | undefined = data?.choices?.[0]?.message?.content;
  if (!text) {
    logger.warn('OCR 返回为空');
    return { type: 'unknown', typeLabel: '未知票据', raw: {} };
  }
  logger.debug(`OCR(${ocr.model}) 原始返回：${text.slice(0, 500)}`);

  const parsed = extractJson(text);
  if (!parsed || typeof parsed !== 'object') {
    logger.warn('OCR 返回无法解析为 JSON：', text.slice(0, 200));
    return { type: 'unknown', typeLabel: '未知票据', raw: { text } };
  }
  return buildFromParsed(parsed);
}

// ============ provider: paddle（本地 PaddleOCR 微服务） ============

async function recognizeViaPaddle(cfg: AppConfig, file: Buffer): Promise<RecognizedInvoice> {
  const { ocr } = cfg;
  const url = `${ocr.baseUrl.replace(/\/$/, '')}/recognize`;
  const img = await prepOcrImage(file);
  logger.info(`调用 OCR 识别（provider=paddle, ${url}, 图片 ${img.length} 字节）…`);

  let resp: Response;
  try {
    resp = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': mimeForImage(img) },
        // Node 原生 fetch 接受 Uint8Array 作为 body；用 any 规避 DOM BodyInit 类型缺失
        body: new Uint8Array(img) as any,
      },
      cfg.requestTimeoutMs
    );
  } catch (e) {
    logger.warn('本地 PaddleOCR 服务连接失败：', (e as Error).message);
    throw new Error(
      `无法连接本地 OCR 服务 ${ocr.baseUrl}。请先启动 PaddleOCR 服务（见 ocr/README.md）。`
    );
  }

  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => '');
    logger.warn(`本地 PaddleOCR HTTP ${resp.status}：${bodyText.slice(0, 300)}`);
    throw new Error(`本地 OCR 服务错误 HTTP ${resp.status}`);
  }

  const parsed: any = await resp.json().catch(() => null);
  if (!parsed || typeof parsed !== 'object') {
    logger.warn('本地 PaddleOCR 返回无法解析为 JSON');
    return { type: 'unknown', typeLabel: '未知票据', raw: {} };
  }
  logger.debug(`PaddleOCR 返回：${JSON.stringify(parsed).slice(0, 500)}`);
  return buildFromParsed(parsed);
}

/** 文本型 PDF：把文字层交给本地 PaddleOCR 服务的 /recognize_text（复用其规则抽取，免栅格化）。 */
async function recognizeTextViaPaddle(cfg: AppConfig, text: string): Promise<RecognizedInvoice> {
  const { ocr } = cfg;
  const url = `${ocr.baseUrl.replace(/\/$/, '')}/recognize_text`;
  logger.info(`调用文本识别（provider=paddle, ${url}, 文本 ${text.length} 字）…`);

  let resp: Response;
  try {
    resp = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      },
      cfg.requestTimeoutMs
    );
  } catch (e) {
    logger.warn('本地 PaddleOCR 服务连接失败：', (e as Error).message);
    throw new Error(
      `无法连接本地 OCR 服务 ${ocr.baseUrl}。请先启动 PaddleOCR 服务（见 ocr/README.md）。`
    );
  }
  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => '');
    logger.warn(`本地 PaddleOCR /recognize_text HTTP ${resp.status}：${bodyText.slice(0, 300)}`);
    throw new Error(`本地 OCR 服务错误 HTTP ${resp.status}`);
  }
  const parsed: any = await resp.json().catch(() => null);
  if (!parsed || typeof parsed !== 'object') return { type: 'unknown', typeLabel: '未知票据', raw: {} };
  return buildFromParsed(parsed);
}

// ============ 分发入口 ============

/**
 * 识别发票：按 OCR_PROVIDER 选择后端。识别不出票种时返回 { type: 'unknown' }。
 */
export async function recognizeInvoice(cfg: AppConfig, file: Buffer): Promise<RecognizedInvoice> {
  const { ocr } = cfg;
  if (!ocr.enabled) throw new OcrNotConfiguredError();
  if (ocr.provider === 'paddle') return recognizeViaPaddle(cfg, file);
  return recognizeViaOpenAI(cfg, file);
}

/**
 * 从文本识别发票（用于文本型 PDF 的文字层）。按 OCR_PROVIDER 选择后端。
 */
export async function recognizeInvoiceFromText(cfg: AppConfig, text: string): Promise<RecognizedInvoice> {
  const { ocr } = cfg;
  if (!ocr.enabled) throw new OcrNotConfiguredError();
  if (ocr.provider === 'paddle') return recognizeTextViaPaddle(cfg, text);
  return recognizeTextViaOpenAI(cfg, text);
}

/**
 * 统一识别任意受支持的票据文件（供文件消息与历史回填共用）：
 * - PDF：优先文字层，无文字层则栅格化首页走视觉识别；
 * - OFD（电子发票 ZIP 容器）：解压抽取文字层走文本识别；
 * - 图片（含 HEIC/HEIF）：直接视觉识别（HEIC 会先转 JPEG）。
 */
export async function recognizeFile(cfg: AppConfig, buf: Buffer): Promise<RecognizedInvoice> {
  if (isPdf(buf)) {
    const text = await extractPdfText(buf);
    if (hasUsableText(text)) return recognizeInvoiceFromText(cfg, text);
    return recognizeInvoice(cfg, await pdfFirstPageToImage(buf));
  }
  if (await isOfd(buf)) {
    const text = await extractOfdText(buf);
    if (hasUsableText(text)) return recognizeInvoiceFromText(cfg, text);
    logger.warn('OFD 无可用文字层，无法识别');
    return { type: 'unknown', typeLabel: '未知票据', raw: {} };
  }
  return recognizeInvoice(cfg, buf);
}
