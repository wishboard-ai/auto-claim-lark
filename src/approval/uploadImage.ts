import * as lark from '@larksuiteoapi/node-sdk';
import { AppConfig } from '../config';
import { logger } from '../logger';

let cachedToken: { token: string; expireAt: number } | null = null;

function apiBase(cfg: AppConfig): string {
  return cfg.domain === lark.Domain.Lark ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
}

async function getTenantToken(cfg: AppConfig): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expireAt) return cachedToken.token;
  const r = await fetch(`${apiBase(cfg)}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
  });
  const d: any = await r.json();
  if (!d?.tenant_access_token) throw new Error(`获取 tenant_access_token 失败：${d?.msg ?? r.status}`);
  cachedToken = { token: d.tenant_access_token, expireAt: Date.now() + Math.max(60, (d.expire ?? 7200) - 120) * 1000 };
  return d.tenant_access_token;
}

/**
 * 上传图片到审批附件存储，返回可用于「图片」控件的 url。失败返回 null（不阻断报销创建）。
 * 接口：POST /approval/openapi/v2/file/upload （multipart: name/type/content）。
 */
export async function uploadApprovalImage(
  cfg: AppConfig,
  buffer: Buffer,
  filename = 'invoice.jpg'
): Promise<string | null> {
  try {
    const token = await getTenantToken(cfg);
    const fd = new FormData();
    fd.append('name', filename);
    fd.append('type', 'image');
    fd.append('content', new Blob([new Uint8Array(buffer)], { type: 'image/*' }), filename);
    const r = await fetch(`${apiBase(cfg)}/approval/openapi/v2/file/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: fd,
    });
    const d: any = await r.json();
    if (d?.code !== 0 || !d?.data?.url) {
      logger.warn(`审批图片上传失败：${JSON.stringify(d).slice(0, 200)}`);
      return null;
    }
    return d.data.url as string;
  } catch (e) {
    logger.warn('审批图片上传异常：', (e as Error).message);
    return null;
  }
}
