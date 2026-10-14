export type MessageMedia =
  | { type: 'file'; fileKey: string; fileName?: string }
  | { type: 'image'; imageKey: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Deterministic message-data parsing; it does not interpret commands or choose
 * agent actions. The post.files envelope is observed in the deployed bot.log.
 * Ordinary file/image and post.content img nodes follow the receiving schema:
 * https://open.feishu.cn/document/server-docs/im-v1/message-content-description/message_content
 */
export function extractMessageMedia(messageType: string, content: string): MessageMedia[] {
  if (messageType !== 'file' && messageType !== 'image' && messageType !== 'post') return [];
  const body: unknown = JSON.parse(content);
  if (!isRecord(body)) return [];

  const media: MessageMedia[] = [];
  const fileKeys = new Set<string>();
  const imageKeys = new Set<string>();

  function appendFile(value: unknown): void {
    if (!isRecord(value) || value.is_folder === true) return;
    const fileKey = value.file_key;
    if (typeof fileKey !== 'string' || !fileKey.trim() || fileKeys.has(fileKey)) return;
    fileKeys.add(fileKey);
    const file: MessageMedia = { type: 'file', fileKey };
    if (typeof value.file_name === 'string' && value.file_name) file.fileName = value.file_name;
    media.push(file);
  }

  function appendImage(value: unknown): void {
    if (!isRecord(value)) return;
    const imageKey = value.image_key;
    if (typeof imageKey !== 'string' || !imageKey.trim() || imageKeys.has(imageKey)) return;
    imageKeys.add(imageKey);
    media.push({ type: 'image', imageKey });
  }

  if (messageType === 'file') {
    appendFile(body);
  } else if (messageType === 'image') {
    appendImage(body);
  } else {
    if (Array.isArray(body.files)) {
      for (const file of body.files) appendFile(file);
    }
    if (Array.isArray(body.content)) {
      for (const row of body.content) {
        if (!Array.isArray(row)) continue;
        for (const node of row) {
          if (isRecord(node) && node.tag === 'img') appendImage(node);
        }
      }
    }
  }
  return media;
}
