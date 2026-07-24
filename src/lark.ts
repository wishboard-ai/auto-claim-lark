import * as lark from '@larksuiteoapi/node-sdk';
import { Credentials } from './config';

/** 用于调用飞书 OpenAPI 的客户端 */
export function createClient(cfg: Credentials): lark.Client {
  return new lark.Client({
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    appType: lark.AppType.SelfBuild,
    domain: cfg.domain,
  });
}

function toLoggerLevel(level: string): lark.LoggerLevel {
  switch (level.toLowerCase()) {
    case 'debug':
      return lark.LoggerLevel.debug;
    case 'warn':
      return lark.LoggerLevel.warn;
    case 'error':
      return lark.LoggerLevel.error;
    default:
      return lark.LoggerLevel.info;
  }
}

/** 长连接客户端：通过 WebSocket 接收事件，无需公网地址 */
export function createWSClient(cfg: Credentials): lark.WSClient {
  return new lark.WSClient({
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    domain: cfg.domain,
    loggerLevel: toLoggerLevel(cfg.logLevel),
  });
}
