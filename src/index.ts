import * as lark from '@larksuiteoapi/node-sdk';
import { loadConfig } from './config';
import { createClient, createWSClient } from './lark';
import { makeMessageHandler } from './handlers/messageHandler';
import { logger } from './logger';

async function main(): Promise<void> {
  const cfg = loadConfig();
  logger.info(`启动发票报销机器人（appId=${cfg.appId}, submitMode=${cfg.submitMode}）`);

  const client = createClient(cfg);
  const wsClient = createWSClient(cfg);
  const onMessage = makeMessageHandler(client, cfg);

  const eventDispatcher = new lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      await onMessage(data);
    },
  });

  wsClient.start({ eventDispatcher });
  logger.info('已通过长连接接入飞书，等待接收发票图片…（Ctrl+C 退出）');
}

main().catch((e) => {
  logger.error('启动失败：', e);
  process.exit(1);
});
