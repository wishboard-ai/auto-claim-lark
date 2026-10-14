const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { test, afterEach } = require('node:test');
const recognition = require('../dist/src/invoice/recognize.js');
const originalRecognizeFile = recognition.recognizeFile;
const session = require('../dist/src/handlers/session.js');
const { makeMessageHandler } = require('../dist/src/handlers/messageHandler.js');

afterEach(() => {
  recognition.recognizeFile = originalRecognizeFile;
  session.clearPending('test-user');
});

function harness() {
  const sent = [];
  const downloads = [];
  const client = { im: { v1: {
    message: { create: async (payload) => { sent.push(payload.data); return { code: 0 }; } },
    messageResource: { get: async (payload) => {
      downloads.push(payload);
      return { getReadableStream: () => Readable.from([Buffer.from('%PDF-' + payload.path.file_key)]) };
    } },
  } } };
  const cfg = { submitMode: 'confirm', expenseApprovalCode: 'expense-test', writeOff: { enabled: false }, llm: { apiKey: '' } };
  return { sent, downloads, client, ...makeMessageHandler(client, cfg) };
}

function event(type, content, id = 'message-1') {
  return { sender: { sender_id: { open_id: 'test-user' } }, message: {
    chat_id: 'test-chat', message_id: id, message_type: type, content: JSON.stringify(content),
  } };
}

async function drain() {
  // All IO in this harness is already resolved; let the existing user queue finish.
  await new Promise((resolve) => setImmediate(resolve));
}

test('进入或再次切回机器人聊天不主动发消息，也不清空待办', async () => {
  const h = harness();
  session.startSession('test-user', 'expense');
  await h.onChatEntered({ chat_id: 'test-chat' });
  await h.onChatEntered({ chat_id: 'another-chat' });
  assert.equal(h.sent.length, 0);
  assert.equal(session.getPending('test-user').mode, 'expense');
});

test('生产日志中的 post.files 三个 PDF 按顺序全部识别且保留原始附件', async () => {
  const h = harness();
  session.startSession('test-user', 'expense');
  recognition.recognizeFile = async (_cfg, buf) => ({
    type: 'vat', typeLabel: '增值税发票', amount: '10.00', date: '2026-10-14',
    invoiceNo: buf.toString().slice(5), raw: {},
  });
  await h.onMessage(event('post', { title: '', content: [[]], content_v2: [[]], files: [
    { file_key: 'a', file_name: 'one.pdf', is_folder: false },
    { file_key: 'b', file_name: 'two.pdf', is_folder: false },
    { file_key: 'c', file_name: 'three.pdf', is_folder: false },
  ] }));
  await drain();
  assert.deepEqual(h.downloads.map((v) => v.path), ['a', 'b', 'c'].map((file_key) => ({ message_id: 'message-1', file_key })));
  const pending = session.getPending('test-user');
  assert.equal(pending.items.length, 3);
  assert.deepEqual(pending.items.map((v) => v.fileName), ['one.pdf', 'two.pdf', 'three.pdf']);
  const lastCard = h.sent.filter((v) => v.msg_type === 'interactive').at(-1).content;
  assert.match(lastCard, /共 3 张/);
  assert.match(lastCard, /取消/);
  assert.match(lastCard, /附件/);
});

test('附件模式中的 post.files 全部作为材料，不触发 OCR', async () => {
  const h = harness();
  session.startSession('test-user', 'expense');
  session.setCollecting('test-user', true);
  recognition.recognizeFile = async () => { throw new Error('附件不得调用 OCR'); };
  await h.onMessage(event('post', { content: [[]], files: [
    { file_key: 'a', file_name: 'one.pdf' }, { file_key: 'b', file_name: 'two.pdf' },
  ] }));
  await drain();
  const pending = session.getPending('test-user');
  assert.equal(pending.items.length, 0);
  assert.equal(pending.attachments.length, 2);
  assert.match(h.sent.at(-1).content, /取消/);
  assert.doesNotMatch(h.sent.at(-1).content, /事由提交/);
});

test('主动选择类型仍有响应，取消后提示可开始下一笔', async () => {
  const h = harness();
  await h.onMessage(event('text', { text: '费用报销' }));
  await drain();
  assert.equal(session.getPending('test-user').mode, 'expense');
  assert.match(h.sent.at(-1).content, /取消/);
  await h.onMessage(event('text', { text: '取消' }, 'message-2'));
  await drain();
  assert.equal(session.getPending('test-user'), undefined);
  assert.match(h.sent.at(-1).content, /费用报销/);
});

test('消息 JSON 损坏仍完成事件接收，在同一用户队列报告错误', async () => {
  const h = harness();
  const bad = event('post', {});
  bad.message.content = '{bad JSON';
  await assert.doesNotReject(h.onMessage(bad));
  await drain();
  assert.match(h.sent.at(-1).content, /处理失败/);
  await h.onMessage(event('text', { text: '费用报销' }, 'after-bad-json'));
  await drain();
  assert.equal(session.getPending('test-user').mode, 'expense');
});

test('确认部分报销后成功卡使用与实际审批表单相同的金额', async () => {
  const h = harness();
  let submitted;
  h.client.approval = { v4: { instance: { create: async (payload) => {
    submitted = payload.data;
    return { code: 0, data: { instance_code: 'submitted-test' } };
  } } } };
  session.startSession('test-user', 'expense');
  session.addItem('test-user', { invoice: { type: 'vat', typeLabel: '增值税发票', amount: '100.00', raw: {} } });
  session.setDraft('test-user', { reason: '测试部分报销', title: '费用报销-测试' });
  session.setClaimAmount('test-user', 60);
  await h.onMessage(event('text', { text: '确认' }));
  await drain();
  assert.equal(submitted.approval_code, 'expense-test');
  const form = JSON.parse(submitted.form);
  const mapping = require('../config/field-mapping.json');
  assert.equal(form.find((field) => field.id === mapping.sumField.widgetId).value, '60.00');
  const card = h.sent.filter((message) => message.msg_type === 'interactive').at(-1);
  assert.match(card.content, /实际报销金额.*¥60\.00/);
  assert.match(card.content, /发票合计 ¥100\.00/);
  assert.equal(session.getPending('test-user'), undefined);
});
