import * as lark from '@larksuiteoapi/node-sdk';
import { AppConfig } from '../config';
import { FormField } from '../types';

export interface CreatedInstance {
  instanceCode: string;
  instanceLink?: string;
}

/**
 * 创建费用报销审批实例（自动填充表单）。
 *
 * 说明：飞书 approval.v4.instance.create 创建后会直接发起、进入审批流；
 * OpenAPI 不提供「仅创建草稿、由用户在审批中手动提交」的能力。
 * 若需人工复核关卡，请使用 confirm 提交模式（识别后先在聊天中确认再创建）。
 */
export async function createApprovalInstance(
  client: lark.Client,
  cfg: AppConfig,
  openId: string,
  form: FormField[],
  title: string
): Promise<CreatedInstance> {
  const resp = await client.approval.v4.instance.create({
    data: {
      approval_code: cfg.approvalCode,
      open_id: openId,
      form: JSON.stringify(form),
      title,
    },
  });

  if (typeof resp.code === 'number' && resp.code !== 0) {
    throw new Error(`飞书返回错误 code=${resp.code} msg=${resp.msg}`);
  }
  const data = resp.data;
  if (!data?.instance_code) {
    throw new Error(`创建审批实例失败：未返回 instance_code（msg=${resp.msg ?? '未知'}）`);
  }

  const rawLink = (data as { instance_link?: unknown }).instance_link;
  const instanceLink =
    typeof rawLink === 'string'
      ? rawLink
      : (rawLink as { pc_link?: string; mobile_link?: string } | undefined)?.pc_link ??
        (rawLink as { pc_link?: string; mobile_link?: string } | undefined)?.mobile_link;

  return { instanceCode: data.instance_code, instanceLink };
}
