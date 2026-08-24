/**
 * 带超时的 fetch：超过 timeoutMs 未响应则中止请求并抛出可读错误。
 * 目的：避免识别/文案/上传等网络调用长时间挂起，进而阻塞「每用户串行队列」。
 * 注意：不要用于 Ollama 模型拉取(/api/pull)等本就长时间的流式请求。
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 120000
): Promise<Response> {
  // 调用方未自带 signal 时，用超时 signal 兜底
  const signal = init.signal ?? AbortSignal.timeout(timeoutMs);
  try {
    return await fetch(url, { ...init, signal });
  } catch (e) {
    const name = (e as { name?: string })?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new Error(`请求超时（超过 ${Math.round(timeoutMs / 1000)}s 未响应）`);
    }
    throw e;
  }
}
