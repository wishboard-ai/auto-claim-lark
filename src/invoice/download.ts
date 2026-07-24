import { Readable } from 'stream';
import * as lark from '@larksuiteoapi/node-sdk';

/**
 * 下载消息中的图片资源为 Buffer。
 * 图片消息的 image_key 即作为 file_key，type 传 'image'。
 */
export async function downloadImage(
  client: lark.Client,
  messageId: string,
  imageKey: string
): Promise<Buffer> {
  const resp = await client.im.v1.messageResource.get({
    path: { message_id: messageId, file_key: imageKey },
    params: { type: 'image' },
  });
  return streamToBuffer(resp.getReadableStream());
}

function streamToBuffer(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer | string) =>
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
    );
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}
