import { logger } from '../logger';

/**
 * 特殊票据文件格式处理：
 * - HEIC/HEIF（iPhone 照片）：OCR/视觉模型无法直接读取，先转成 JPEG。
 * - OFD（中国电子发票常用格式，本质是 ZIP 容器）：解压后抽取文字层，走文本识别。
 * 依赖 heic-convert / jszip 均为纯 JS（含 WASM），跨平台免编译；按需动态 import。
 */

/** 通过 ISO-BMFF ftyp 品牌判断是否 HEIC/HEIF。 */
export function isHeic(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  if (buf.toString('ascii', 4, 8) !== 'ftyp') return false;
  const brand = buf.toString('ascii', 8, 12).toLowerCase();
  return ['heic', 'heix', 'heif', 'hevc', 'hevx', 'mif1', 'msf1', 'heim', 'heis', 'hevm', 'hevs'].includes(brand);
}

/** HEIC/HEIF → JPEG。 */
export async function heicToJpeg(buf: Buffer): Promise<Buffer> {
  const heicConvert = (await import('heic-convert')).default;
  const out = await heicConvert({ buffer: new Uint8Array(buf), format: 'JPEG', quality: 0.92 });
  return Buffer.from(out);
}

/** ZIP 魔数（PK\x03\x04 / PK\x05\x06 / PK\x07\x08）。 */
export function isZip(buf: Buffer): boolean {
  return (
    buf.length >= 4 &&
    buf[0] === 0x50 &&
    buf[1] === 0x4b &&
    (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07)
  );
}

/** 是否为 OFD：ZIP 容器且包含入口 OFD.xml。 */
export async function isOfd(buf: Buffer): Promise<boolean> {
  if (!isZip(buf)) return false;
  try {
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(buf);
    return Object.keys(zip.files).some((n) => /(^|\/)OFD\.xml$/i.test(n));
  } catch {
    return false;
  }
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => cp(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => cp(parseInt(d, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}
function cp(n: number): string {
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}

/**
 * 抽取 OFD 内所有页面 XML 的可见文字（<ofd:TextCode> 元素内容），拼接为文本。
 * 用于交给文本识别提取票种/号码/金额等（与文本型 PDF 同路）。失败/无文字返回空串。
 */
export async function extractOfdText(buf: Buffer): Promise<string> {
  try {
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(buf);
    const names = Object.keys(zip.files).filter((n) => /\.xml$/i.test(n) && !zip.files[n].dir);
    const parts: string[] = [];
    for (const name of names) {
      const xml = await zip.files[name].async('string');
      const re = /<(?:\w+:)?TextCode\b[^>]*>([\s\S]*?)<\/(?:\w+:)?TextCode>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(xml)) !== null) {
        const t = decodeXmlEntities(m[1]).trim();
        if (t) parts.push(t);
      }
    }
    return parts.join('\n');
  } catch (e) {
    logger.warn('解析 OFD 文本失败：', (e as Error).message);
    return '';
  }
}
