import * as path from 'path';
import { pathToFileURL } from 'url';
import { createRequire } from 'module';
import { logger } from '../logger';

/**
 * PDF 处理：优先读取 PDF 自带的文字层（很多电子发票是文本型 PDF），
 * 仅当没有可用文字（扫描件/图片型 PDF）时，才把首页栅格化成图片走视觉识别。
 *
 * 用 pdf-to-img / pdfjs-dist（内部含 @napi-rs/canvas 预编译二进制，跨平台免编译）。
 * 两库均为 ESM-only，本项目编译为 CommonJS，故用动态 import() 加载。
 */

/** 通过魔数判断是否 PDF（%PDF-）。 */
export function isPdf(buf: Buffer): boolean {
  return buf.length >= 5 && buf.toString('ascii', 0, 5) === '%PDF-';
}

/**
 * 提取 PDF 的文字层文本（所有页）。文本型 PDF 会返回可用文本，扫描件通常返回空/极少。
 * 失败或无文字层时返回空字符串（交由上层回退到栅格化识别）。
 */
export async function extractPdfText(pdfBuffer: Buffer): Promise<string> {
  try {
    const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(pdfBuffer),
      standardFontDataUrl: standardFontDataUrl(),
    }).promise;
    const parts: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const line = content.items.map((it: any) => ('str' in it ? it.str : '')).join('\n');
      if (line.trim()) parts.push(line);
    }
    await doc.destroy?.();
    return parts.join('\n');
  } catch (e) {
    logger.warn('提取 PDF 文字层失败，将回退到图片识别：', (e as Error).message);
    return '';
  }
}

/**
 * 判断 PDF 文字层是否“可用”（足以直接抽取字段，无需栅格化）。
 * 依据去空白后的有效字符数与是否含中日文/数字：扫描件通常几乎无文字。
 */
export function hasUsableText(text: string): boolean {
  const compact = text.replace(/\s+/g, '');
  if (compact.length < 20) return false;
  const meaningful = (compact.match(/[\u4e00-\u9fa5A-Za-z0-9]/g) || []).length;
  return meaningful >= 15;
}

// 解析 pdfjs-dist 附带的标准字体目录（消除渲染时的字体告警）。失败则返回 undefined。
function standardFontDataUrl(): string | undefined {
  try {
    const require = createRequire(__filename);
    const dir = path.join(path.dirname(require.resolve('pdfjs-dist')), '..', 'standard_fonts') + path.sep;
    return pathToFileURL(dir).href;
  } catch {
    return undefined;
  }
}

/**
 * 把 PDF 首页渲染为 PNG 图片 Buffer。
 * @param pdfBuffer PDF 原始字节
 * @param scale 渲染倍率，越大越清晰（默认 2.5，兼顾清晰度与体积）
 */
export async function pdfFirstPageToImage(pdfBuffer: Buffer, scale = 2.5): Promise<Buffer> {
  const { pdf } = await import('pdf-to-img');
  const doc = await pdf(new Uint8Array(pdfBuffer), {
    scale,
    docInitParams: { standardFontDataUrl: standardFontDataUrl() },
  });
  if (doc.length > 1) logger.info(`PDF 共 ${doc.length} 页，取第 1 页识别`);
  const page = await doc.getPage(1);
  return Buffer.isBuffer(page) ? page : Buffer.from(page);
}
