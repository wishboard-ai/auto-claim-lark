import { logger } from '../logger';

/**
 * 发票二维码解析：从发票图片中定位并解码二维码，解析增值税发票二维码的明文字段，
 * 用于交叉校正 OCR 结果（发票号码/代码/开票日期这类机器编码字段，二维码比 OCR 更可信）。
 *
 * 依赖：
 * - @napi-rs/canvas：解码 JPEG/PNG 为 RGBA 像素（项目已通过 pdf-to-img 间接引入，跨平台预编译）。
 * - jsqr：纯 JS 二维码识别（无原生编译），输入 RGBA 像素。
 * 两者均按需动态 import，解析失败时安全降级（返回 undefined，不影响原识别流程）。
 */

/** 增值税发票二维码解析出的字段（均为票面机器编码，较 OCR 更可信）。 */
export interface InvoiceQrData {
  /** 发票代码（全电发票通常为空） */
  invoiceCode?: string;
  /** 发票号码 */
  invoiceNo?: string;
  /** 不含税金额（注意：增值税发票二维码里的金额是税前小计，不是价税合计） */
  netAmount?: string;
  /** 开票日期，归一化为 YYYY-MM-DD */
  date?: string;
  /** 原始二维码文本，便于调试 */
  raw: string;
}

/**
 * 解析增值税发票二维码明文。典型格式为逗号分隔：
 *   01,<版本>,<发票代码>,<发票号码>,<不含税金额>,<开票日期YYYYMMDD>,<校验码后6位>,<其他>
 * 仅当以 "01," 开头且字段数足够时才解析；否则返回 undefined（可能是火车票等非此格式）。
 */
export function parseVatQrText(text: string): InvoiceQrData | undefined {
  const t = (text || '').trim();
  if (!t.startsWith('01,')) return undefined;
  const parts = t.split(',');
  if (parts.length < 7) return undefined;

  const codeRaw = (parts[2] || '').trim();
  const noRaw = (parts[3] || '').trim();
  const amtRaw = (parts[4] || '').trim();
  const dateRaw = (parts[5] || '').trim();

  const invoiceCode = /^\d{10,12}$/.test(codeRaw) ? codeRaw : undefined;
  const invoiceNo = /^\d{8}$|^\d{20}$/.test(noRaw) ? noRaw : undefined;
  const netAmount = /^\d+(\.\d+)?$/.test(amtRaw) && Number(amtRaw) > 0 ? amtRaw : undefined;
  const date = /^\d{8}$/.test(dateRaw)
    ? `${dateRaw.slice(0, 4)}-${dateRaw.slice(4, 6)}-${dateRaw.slice(6, 8)}`
    : undefined;

  // 至少要解出号码或代码之一才算有效
  if (!invoiceNo && !invoiceCode) return undefined;
  return { invoiceCode, invoiceNo, netAmount, date, raw: t };
}

/**
 * 从图片字节（JPEG/PNG/WebP 等 @napi-rs/canvas 可解码格式）中解码二维码文本。
 * 会尝试原图与放大 2x 两种尺度以提高低分辨率照片的成功率。失败返回 undefined。
 */
export async function decodeQrFromImage(imageBuffer: Buffer): Promise<string | undefined> {
  let canvasMod: typeof import('@napi-rs/canvas');
  let jsQR: (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null;
  try {
    canvasMod = await import('@napi-rs/canvas');
    const jsqrMod = await import('jsqr');
    jsQR = ((jsqrMod as { default?: unknown }).default ?? jsqrMod) as unknown as typeof jsQR;
  } catch (e) {
    logger.warn('二维码依赖加载失败，跳过二维码解析：', (e as Error).message);
    return undefined;
  }

  let image: import('@napi-rs/canvas').Image;
  try {
    image = await canvasMod.loadImage(imageBuffer);
  } catch (e) {
    logger.debug?.(`二维码：图片解码失败，跳过：${(e as Error).message}`);
    return undefined;
  }

  const baseW = image.width;
  const baseH = image.height;
  if (!baseW || !baseH) return undefined;

  // 原始尺度优先；再试 2x 放大（对小图/远拍的二维码有帮助）。上限约束避免超大图占内存。
  const scales = [1, 2];
  for (const scale of scales) {
    const w = Math.min(Math.round(baseW * scale), 4000);
    const h = Math.min(Math.round(baseH * scale), 4000);
    try {
      const canvas = canvasMod.createCanvas(w, h);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0, w, h);
      const imageData = ctx.getImageData(0, 0, w, h);
      const result = jsQR(imageData.data as unknown as Uint8ClampedArray, w, h);
      if (result?.data) return result.data;
    } catch (e) {
      logger.debug?.(`二维码：scale=${scale} 解析失败：${(e as Error).message}`);
    }
  }
  return undefined;
}

/**
 * 从图片字节中提取并解析增值税发票二维码数据。无二维码或非增值税格式时返回 undefined。
 */
export async function extractInvoiceQr(imageBuffer: Buffer): Promise<InvoiceQrData | undefined> {
  const text = await decodeQrFromImage(imageBuffer);
  if (!text) return undefined;
  const data = parseVatQrText(text);
  if (data) {
    logger.info(
      `二维码解析成功：号码=${data.invoiceNo || '-'} 代码=${data.invoiceCode || '-'} 日期=${data.date || '-'}`
    );
  }
  return data;
}
