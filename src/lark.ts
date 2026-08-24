import * as lark from '@larksuiteoapi/node-sdk';
import { Credentials } from './config';

// SDK 1.72.x 内部用 `params.loggerLevel || info`，而 fatal 的枚举值恰好是 0，
// 因此仅设置 fatal 仍会回退为 info，并可能在网络错误中打印含 App Secret 的请求体。
const silentSdkLogger: lark.Logger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
};

/** 用于调用飞书 OpenAPI 的客户端 */
export function createClient(cfg: Credentials): lark.Client {
  return new lark.Client({
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    appType: lark.AppType.SelfBuild,
    domain: cfg.domain,
    // SDK 的 Axios 错误对象可能包含鉴权请求体；使用静默 logger，业务层只记录脱敏后的 code/msg。
    logger: silentSdkLogger,
    loggerLevel: lark.LoggerLevel.error,
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
    logger: silentSdkLogger,
    loggerLevel: toLoggerLevel(cfg.logLevel),
  });
}
