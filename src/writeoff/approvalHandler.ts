import * as lark from '@larksuiteoapi/node-sdk';
import { AppConfig } from '../config';
import { logger } from '../logger';
import { writeOffCard } from '../reply/cards';
import { LoanWriteOffLedger } from './ledger';
import { InvoiceUsageLedger } from '../invoice/dedup';
import { scanInstanceInvoices } from '../invoice/instanceScan';
import type { ClaimMode } from '../handlers/session';

const RELEASE_STATUSES = new Set(['REJECTED', 'CANCELED', 'DELETED', 'REVERTED']);
// 触发外部审批发票扫描的状态：创建(PENDING) 与 通过(APPROVED)。
const SCAN_STATUSES = new Set(['PENDING', 'APPROVED']);

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
  ledger?: LoanWriteOffLedger,
  invoiceUsageLedger?: InvoiceUsageLedger
) {
  // 同一实例并发去重：状态回调会多次触发（创建、每节点、通过），避免重复下载/OCR。
  const scanning = new Set<string>();

  async function scanExternalInvoices(instanceCode: string, mode: ClaimMode): Promise<void> {
    if (!invoiceUsageLedger) return;
    if (scanning.has(instanceCode)) return;
    if (invoiceUsageLedger.hasInstance(instanceCode)) return; // 已入账/机器人自建实例
    scanning.add(instanceCode);
    try {
      const result = await scanInstanceInvoices(client, cfg, invoiceUsageLedger, instanceCode, mode);
      if (result.added > 0) {
        logger.info(
          `外部审批发票已入检重台账（instance=${instanceCode}, mode=${mode}, 新增=${result.added}/${result.scanned}）`
        );
      } else if (!result.skipped && result.hasFiles && result.scanned > 0) {
        logger.info(`外部审批发票均已在台账或无法识别（instance=${instanceCode}）`);
      }
    } catch (e) {
      logger.warn(`外部审批发票扫描失败（instance=${instanceCode}）：`, (e as Error).message);
    } finally {
      scanning.delete(instanceCode);
    }
  }

  return async function onApprovalStatus(data: {
    approval_code?: string;
    instance_code?: string;
    status?: string;
    operate_time?: string;
  }): Promise<void> {
    if (!data.instance_code || !data.approval_code) return;
    const status = (data.status || '').toUpperCase();
    const time = eventTime(data.operate_time);

    // A) 外部审批发票扫描：监听「非机器人直接发起」的费用报销/借款核销审批，
    //    在创建(PENDING)/通过(APPROVED)时把表单里的发票补入检重台账（幂等）。
    if (cfg.invoiceScan.enabled && invoiceUsageLedger) {
      let mode: ClaimMode | undefined;
      if (data.approval_code === cfg.expenseApprovalCode) mode = 'expense';
      else if (data.approval_code === cfg.approvalCode) mode = 'loan_writeoff';
      if (mode) {
        logger.info(
          `收到审批状态事件（approval=${data.approval_code}, status=${status}, instance=${data.instance_code}）`
        );
        if (SCAN_STATUSES.has(status)) await scanExternalInvoices(data.instance_code, mode);
      }
    }

    // B) 借款核销台账维护：仅针对借款核销审批定义、且启用了自动核销时生效。
    if (!cfg.writeOff.enabled || !ledger) return;
    if (data.approval_code !== cfg.approvalCode) return;

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

/** 开启应用对审批实例的状态订阅。失败只降级告警，不阻止机器人处理报销。 */
export async function ensureApprovalStatusSubscription(
  client: lark.Client,
  cfg: AppConfig
): Promise<void> {
  const scanEnabled = cfg.invoiceScan.enabled;
  if (!cfg.writeOff.enabled && !scanEnabled) return;

  // 需要订阅的审批定义：借款核销（自动核销/扫描）+ 费用报销（仅扫描时需要）。
  const codes = new Set<string>();
  if (cfg.writeOff.enabled || scanEnabled) codes.add(cfg.approvalCode);
  if (scanEnabled) codes.add(cfg.expenseApprovalCode);

  const errBody = (e: unknown): { code?: number; msg?: string } | undefined =>
    (e as { response?: { data?: { code?: number; msg?: string } } })?.response?.data;

  // 1) 定义级订阅：让应用能收到这些审批定义下实例的状态变更事件（幂等，重复订阅返回 1390007）。
  for (const code of codes) {
    try {
      const r = await client.approval.v4.approval.subscribe({ path: { approval_code: code } });
      if (typeof r.code === 'number' && r.code !== 0) {
        if (r.code === 1390007) logger.info(`审批定义 ${code} 已处于订阅状态`);
        else logger.warn(`订阅审批定义 ${code} 返回异常 code=${r.code} msg=${r.msg}`);
      } else {
        logger.info(`已订阅审批定义 ${code}`);
      }
    } catch (e) {
      const body = errBody(e);
      if (body?.code === 1390007) logger.info(`审批定义 ${code} 已处于订阅状态`);
      else logger.warn(`订阅审批定义 ${code} 失败：${body?.msg || (e as Error).message}`);
    }
  }

  // 2) 实例事件范围（INVOLVED_APPROVAL/MANAGED_APPROVAL）。
  //    注意：该接口需 user_access_token，应用的 tenant token 会被拒（99991663），故仅尽力尝试、失败不阻断。
  //    该范围为应用级、一次设置长期生效，通常由管理员用「用户身份」在 API Explorer 调用一次即可。
  const scopeType = scanEnabled ? cfg.invoiceScan.scopeType : 'MANAGED_APPROVAL';
  try {
    const r = await client.approval.v4.instance.subscription({ data: { subscription_type: scopeType } });
    if (typeof r.code === 'number' && r.code !== 0) {
      logger.info(`设置实例事件范围返回 code=${r.code} msg=${r.msg}（期望 ${scopeType}）`);
    } else {
      logger.info(`已设置审批实例事件范围为 ${scopeType}`);
    }
  } catch (e) {
    const body = errBody(e);
    logger.info(
      `未能以应用身份设置实例事件范围（code=${body?.code ?? (e as Error).message}）；` +
        `该接口需用户身份，请由管理员在 API Explorer 用「用户身份」将范围设为 ${scopeType}（一次生效、长期有效）。`
    );
  }
  logger.info(`审批状态订阅初始化完成（定义=${[...codes].join(',')}，期望范围=${scopeType}）`);
}
