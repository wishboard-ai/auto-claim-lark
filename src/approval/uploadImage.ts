import * as lark from '@larksuiteoapi/node-sdk';
import { AppConfig } from '../config';
import { logger } from '../logger';
import { fetchWithTimeout } from '../util/http';

let cachedToken: { token: string; expireAt: number } | null = null;

function apiBase(cfg: AppConfig): string {
  return cfg.domain === lark.Domain.Lark ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
}

async function getTenantToken(cfg: AppConfig): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expireAt) return cachedToken.token;
  const r = await fetchWithTimeout(
    `${apiBase(cfg)}/open-apis/auth/v3/tenant_access_token/internal`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
    },
    cfg.requestTimeoutMs
  );
  const d: any = await r.json();
  if (!d?.tenant_access_token) throw new Error(`获取 tenant_access_token 失败：${d?.msg ?? r.status}`);
  cachedToken = { token: d.tenant_access_token, expireAt: Date.now() + Math.max(60, (d.expire ?? 7200) - 120) * 1000 };
  return d.tenant_access_token;
}

/**
 * 上传文件到审批附件存储，返回可用于「图片(image)」/「附件(attachmentV2)」控件的文件 code。
 * 失败返回 null（不阻断报销创建）。
 * 接口：POST /approval/openapi/v2/file/upload （multipart: name/type/content）。
 * @param type 'image' 用于图片控件；'attachment' 用于附件控件。两者控件值均为 code 字符串数组。
 * 注意：控件的值必须是 code 字符串数组（传 url 会被静默丢弃、文件不显示）。
 */
export async function uploadApprovalFile(
  cfg: AppConfig,
  buffer: Buffer,
  filename: string,
  type: 'image' | 'attachment' = 'image'
): Promise<string | null> {
  try {
    const token = await getTenantToken(cfg);
    const fd = new FormData();
    fd.append('name', filename);
    fd.append('type', type);
    const contentType = type === 'image' ? 'image/*' : 'application/octet-stream';
    fd.append('content', new Blob([new Uint8Array(buffer)], { type: contentType }), filename);
    const r = await fetchWithTimeout(
      `${apiBase(cfg)}/approval/openapi/v2/file/upload`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      },
      cfg.requestTimeoutMs
    );
    const d: any = await r.json();
    if (d?.code !== 0 || !d?.data?.code) {
      logger.warn(`审批文件上传失败(type=${type})：${JSON.stringify(d).slice(0, 200)}`);
      return null;
    }
    return d.data.code as string;
  } catch (e) {
    logger.warn(`审批文件上传异常(type=${type})：`, (e as Error).message);
    return null;
  }
}

/** 兼容旧调用：上传图片到「图片」控件。 */
export async function uploadApprovalImage(
  cfg: AppConfig,
  buffer: Buffer,
  filename = 'invoice.jpg'
): Promise<string | null> {
  return uploadApprovalFile(cfg, buffer, filename, 'image');
}
