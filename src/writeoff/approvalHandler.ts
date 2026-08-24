import * as lark from '@larksuiteoapi/node-sdk';
import { AppConfig } from '../config';
import { logger } from '../logger';
import { writeOffCard } from '../reply/cards';
import { LoanWriteOffLedger } from './ledger';

const RELEASE_STATUSES = new Set(['REJECTED', 'CANCELED', 'DELETED', 'REVERTED']);

function eventTime(value?: string): string | undefined {
  if (!value) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    const millis = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    return new Date(millis).toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

async function sendCard(client: lark.Client, chatId: string, card: string): Promise<void> {
  await client.im.v1.message.create({
    params: { receive_id_type: 'chat_id' },
    data: { receive_id: chatId, content: card, msg_type: 'interactive' },
  });
}

export function makeApprovalStatusHandler(
  client: lark.Client,
  cfg: AppConfig,
  ledger?: LoanWriteOffLedger
) {
  return async function onApprovalStatus(data: {
    approval_code?: string;
    instance_code?: string;
    status?: string;
    operate_time?: string;
  }): Promise<void> {
    if (!cfg.writeOff.enabled || !ledger) return;
    if (!data.instance_code || data.approval_code !== cfg.approvalCode) return;

    const status = (data.status || '').toUpperCase();
    const time = eventTime(data.operate_time);
    if (status === 'APPROVED') {
      const result = ledger.markWrittenOff(data.instance_code, time);
      if (!result.matched || !result.changed) return;
      logger.info(`借款核销审批通过（instance=${data.instance_code}）`);
      const chatId = result.entries[0]?.chatId;
      if (chatId) {
        const entry = result.entries[0];
        const remaining = ledger.remaining(entry.loanInstanceCode, entry.loanAmount);
        await sendCard(
          client,
          chatId,
          writeOffCard(entry.loanInstanceCode, data.instance_code, entry.writeOffAmount, remaining)
        ).catch((error) => logger.warn('发送核销通知失败：', (error as Error).message));
      }
      return;
    }

    if (RELEASE_STATUSES.has(status)) {
      const result = ledger.release(data.instance_code, status, time);
      if (result.changed) {
        logger.info(`核销审批状态 ${status}，已释放原付款申请的核销占用`);
      }
    }
  };
}

/** 开启应用对其管理审批实例的状态订阅。失败只降级告警，不阻止机器人处理报销。 */
export async function ensureApprovalStatusSubscription(
  client: lark.Client,
  cfg: AppConfig
): Promise<void> {
  if (!cfg.writeOff.enabled) return;
  try {
    const approvalResponse = await client.approval.v4.approval.subscribe({
      path: { approval_code: cfg.approvalCode },
    });
    if (typeof approvalResponse.code === 'number' && approvalResponse.code !== 0) {
      throw new Error(`订阅审批定义失败 code=${approvalResponse.code} msg=${approvalResponse.msg}`);
    }

    const scopeResponse = await client.approval.v4.instance.subscription({
      data: { subscription_type: 'MANAGED_APPROVAL' },
    });
    if (typeof scopeResponse.code === 'number' && scopeResponse.code !== 0) {
      throw new Error(`订阅实例范围失败 code=${scopeResponse.code} msg=${scopeResponse.msg}`);
    }
    logger.info('已启用借款核销审批状态订阅');
  } catch (error) {
    logger.warn(
      '无法启用核销审批状态订阅，借款选择仍可用，但审批通过后无法自动关闭原付款申请：',
      (error as Error).message
    );
  }
}
