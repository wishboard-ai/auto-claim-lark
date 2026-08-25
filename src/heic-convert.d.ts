declare module 'heic-convert' {
  interface HeicConvertOptions {
    /** HEIC/HEIF 原始字节 */
    buffer: Uint8Array | Buffer;
    /** 目标格式 */
    format: 'JPEG' | 'PNG';
    /** JPEG 质量 0~1（仅 JPEG 有效） */
    quality?: number;
  }
  const heicConvert: (options: HeicConvertOptions) => Promise<Buffer>;
  export default heicConvert;
}
