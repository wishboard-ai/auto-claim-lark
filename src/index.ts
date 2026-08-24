import * as lark from '@larksuiteoapi/node-sdk';
import { loadConfig } from './config';
import { createClient, createWSClient } from './lark';
import { makeMessageHandler } from './handlers/messageHandler';
import { logger } from './logger';
import { LoanWriteOffLedger } from './writeoff/ledger';
import { ensureApprovalStatusSubscription, makeApprovalStatusHandler } from './writeoff/approvalHandler';

async function main(): Promise<void> {
  const cfg = loadConfig();
  logger.info(`启动发票报销机器人（appId=${cfg.appId}, submitMode=${cfg.submitMode}）`);

  const client = createClient(cfg);
  const wsClient = createWSClient(cfg);
  const ledger = cfg.writeOff.enabled ? new LoanWriteOffLedger(cfg.writeOff.ledgerPath) : undefined;
  const { onMessage, onChatEntered } = makeMessageHandler(client, cfg, ledger);
  const onApprovalStatus = makeApprovalStatusHandler(client, cfg, ledger);

  await ensureApprovalStatusSubscription(client, cfg);

  const eventDispatcher = new lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      await onMessage(data);
    },
    'im.chat.access_event.bot_p2p_chat_entered_v1': async (data) => {
      await onChatEntered(data);
    },
    'approval.instance.status_changed_v4': async (data) => {
      await onApprovalStatus(data);
    },
  });

  wsClient.start({ eventDispatcher });
  logger.info('已通过长连接接入飞书，等待接收发票图片…（Ctrl+C 退出）');
}

main().catch((e) => {
  logger.error('启动失败：', e);
  process.exit(1);
});
