const assert = require('node:assert/strict');
const { test } = require('node:test');
const { extractMessageMedia } = require('../dist/src/handlers/messageMedia.js');

// The deployed bot.log showed a single post with empty content/content_v2 rows
// and all three PDF uploads in its top-level files array. Keys and names here
// are test values; the envelope reproduces the observed message structure.
test('extracts all three PDFs from the observed multi-file post in order', () => {
  const content = {
    title: '',
    content: [[]],
    content_v2: [[]],
    files: [
      { file_key: 'file-1', file_name: '1-设备费.pdf', is_folder: false },
      { file_key: 'file-2', file_name: '2-设备费.pdf', is_folder: false },
      { file_key: 'file-3', file_name: '3-设备费.pdf', is_folder: false },
    ],
  };
  assert.deepEqual(extractMessageMedia('post', JSON.stringify(content)), [
    { type: 'file', fileKey: 'file-1', fileName: '1-设备费.pdf' },
    { type: 'file', fileKey: 'file-2', fileName: '2-设备费.pdf' },
    { type: 'file', fileKey: 'file-3', fileName: '3-设备费.pdf' },
  ]);
});

test('deduplicates post files by key and skips folders', () => {
  assert.deepEqual(extractMessageMedia('post', JSON.stringify({
    content: [[]],
    files: [
      { file_key: 'folder-1', file_name: '发票文件夹', is_folder: true },
      { file_key: 'file-1', file_name: 'first.pdf', is_folder: false },
      { file_key: 'file-1', file_name: 'duplicate.pdf', is_folder: false },
      { file_key: 'file-2', file_name: 'second.pdf', is_folder: false },
    ],
  })), [
    { type: 'file', fileKey: 'file-1', fileName: 'first.pdf' },
    { type: 'file', fileKey: 'file-2', fileName: 'second.pdf' },
  ]);
});

// Official receiving-content documentation uses content: [[...]] with tag=img:
// https://open.feishu.cn/document/server-docs/im-v1/message-content-description/message_content
test('extracts all rich-text images in row order and deduplicates image keys', () => {
  assert.deepEqual(extractMessageMedia('post', JSON.stringify({
    title: '发票',
    content: [
      [{ tag: 'text', text: '本次发票' }, { tag: 'img', image_key: 'image-1' }],
      [{ tag: 'img', image_key: 'image-2' }, { tag: 'img', image_key: 'image-1' }],
    ],
  })), [
    { type: 'image', imageKey: 'image-1' },
    { type: 'image', imageKey: 'image-2' },
  ]);
});

test('keeps ordinary image and file messages compatible', () => {
  assert.deepEqual(extractMessageMedia('image', '{"image_key":"image-1"}'), [
    { type: 'image', imageKey: 'image-1' },
  ]);
  assert.deepEqual(extractMessageMedia('file', '{"file_key":"file-1","file_name":"invoice.pdf"}'), [
    { type: 'file', fileKey: 'file-1', fileName: 'invoice.pdf' },
  ]);
});

test('preserves files-array and image-row order in a mixed post', () => {
  assert.deepEqual(extractMessageMedia('post', JSON.stringify({
    files: [{ file_key: 'shared-key', file_name: 'invoice.pdf', is_folder: false }],
    content: [[{ tag: 'img', image_key: 'shared-key' }]],
  })), [
    { type: 'file', fileKey: 'shared-key', fileName: 'invoice.pdf' },
    { type: 'image', imageKey: 'shared-key' },
  ]);
});

test('does not reinterpret rich-text words or video covers as invoice media', () => {
  assert.deepEqual(extractMessageMedia('post', JSON.stringify({
    title: '确认',
    content: [[
      { tag: 'text', text: '取消' },
      { tag: 'media', file_key: 'video-1', image_key: 'cover-1' },
    ]],
  })), []);
  assert.deepEqual(extractMessageMedia('text', '{"text":"取消"}'), []);
  assert.deepEqual(extractMessageMedia('folder', '{"file_key":"folder-1"}'), []);
});

test('ignores malformed nodes instead of creating downloads with invalid keys', () => {
  assert.deepEqual(extractMessageMedia('post', JSON.stringify({
    files: [null, { file_key: '' }, { file_key: 42 }],
    content: [null, [{ tag: 'img' }, { tag: 'img', image_key: '' }, null]],
  })), []);
  assert.deepEqual(extractMessageMedia('image', '{}'), []);
  assert.deepEqual(extractMessageMedia('file', '{}'), []);
});
