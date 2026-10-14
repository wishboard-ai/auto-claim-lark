const assert = require('node:assert/strict');
const { test } = require('node:test');
const cards = require('../dist/src/reply/cards.js');

const invoice = { type: 'vat', typeLabel: '增值税发票', amount: '100.00', raw: {} };
const loan = { serialNumber: 'FK-001', approvedDate: '2026-10-14', amount: '100.00' };
const claim = (overrides = {}) => ({ items: [], attachments: [], createdAt: 0, mode: 'expense', ...overrides });
const cardText = (card) => JSON.parse(card).elements.map((element) => element.text?.content || '').join('\n');

test('发票加入卡片列出取消和辅助材料操作', () => {
  const text = cardText(cards.addedCard([invoice], 'expense'));
  assert.match(text, /取消/);
  assert.match(text, /附件/);
});

test('借款选择卡片除了序号还列出取消和继续上传操作', () => {
  const text = cardText(cards.loanSelectionCard([loan]));
  assert.match(text, /取消/);
  assert.match(text, /附件/);
  assert.match(text, /发票/);
});

test('预览卡片列出追加发票和辅助材料，保留类别名称', () => {
  const text = cardText(cards.previewCard([invoice], '测试报销', '差旅费', '客户拜访', ['差旅费'], undefined, 'expense'));
  assert.match(text, /继续.*发票/);
  assert.match(text, /附件/);
  assert.match(text, /差旅费/);
});

test('禁用借款时办理类型卡片仅提供费用报销和取消', () => {
  const text = cardText(cards.modeSelectionCard(false));
  assert.match(text, /费用报销/);
  assert.match(text, /取消/);
  assert.doesNotMatch(text, /借款核销/);
});

test('提交成功卡片提示开始下一笔', () => {
  const text = cardText(cards.successCard([invoice], undefined, '测试报销', undefined, 'expense'));
  assert.match(text, /下一笔/);
  assert.match(text, /费用报销/);
});

test('禁用借款时成功卡片下一笔操作不提供借款核销', () => {
  const text = cardText(cards.successCard([invoice], undefined, '测试报销', undefined, 'expense', false));
  assert.match(text, /下一笔/);
  assert.match(text, /费用报销/);
  assert.doesNotMatch(text, /借款核销/);
});

test('部分报销成功卡同时显示发票合计与实际报销金额', () => {
  const text = cardText(cards.successCard([invoice], undefined, '测试报销', '设备费', 'expense', true, 60));
  assert.match(text, /发票合计 ¥100\.00/);
  assert.match(text, /\*\*实际报销金额\*\*：¥60\.00（少于发票合计）/);
  assert.match(text, /设备费/);
});

test('全额报销成功卡的实际金额默认为发票合计', () => {
  const text = cardText(cards.successCard([invoice], undefined, '测试报销', undefined, 'expense'));
  assert.match(text, /\*\*实际报销金额\*\*：¥100\.00/);
  assert.doesNotMatch(text, /少于发票合计/);
});

test('核销成功卡不引入费用报销金额标签', () => {
  const text = cardText(cards.successCard([invoice], undefined, '测试核销', undefined, 'loan_writeoff', true, 60));
  assert.match(text, /发票合计 ¥100\.00/);
  assert.doesNotMatch(text, /实际报销金额/);
});

test('卡片接受完整操作提示并保留配置类别', () => {
  const hint = '测试完整提示：取消与附件';
  assert.match(cardText(cards.addedCard([invoice], 'expense', hint)), /测试完整提示/);
  assert.match(cardText(cards.loanSelectionCard([loan], false, hint)), /测试完整提示/);
  const text = cardText(cards.previewCard([invoice], '测试报销', undefined, '客户拜访', ['差旅费', '办公费'], undefined, 'expense', 0, undefined, hint));
  assert.match(text, /测试完整提示/);
  assert.match(text, /差旅费 \/ 办公费/);
});

test('操作展示模块存在并提供纯展示函数', () => {
  const { buildOperationHint } = require('../dist/src/reply/actions.js');
  assert.equal(typeof buildOperationHint, 'function');
});

test('无会话提示启用的办理类型与取消', () => {
  const { buildOperationHint } = require('../dist/src/reply/actions.js');
  assert.match(buildOperationHint(), /借款核销/);
  assert.match(buildOperationHint(), /费用报销/);
  assert.match(buildOperationHint(), /取消/);
  assert.doesNotMatch(buildOperationHint(undefined, { loanEnabled: false }), /借款核销/);
});

test('无发票时提示附件和重选类型，但不宣传事由或确认可提交', () => {
  const { buildOperationHint } = require('../dist/src/reply/actions.js');
  const text = buildOperationHint(claim());
  assert.match(text, /发票/);
  assert.match(text, /附件/);
  assert.match(text, /重新选择/);
  assert.match(text, /取消/);
  assert.doesNotMatch(text, /回复.*事由|回复.*确认/);
});

test('没有发票的附件模式要求切回发票后上传，不提示回复事由', () => {
  const { buildOperationHint } = require('../dist/src/reply/actions.js');
  const text = buildOperationHint(claim({ collectingAttachments: true }));
  assert.match(text, /继续上传辅助材料/);
  assert.match(text, /回复「发票」切回/);
  assert.match(text, /取消/);
  assert.doesNotMatch(text, /回复.*事由|回复.*确认/);
});

test('收集阶段列出发票、附件、事由、取消，不宣传预览专属命令', () => {
  const { buildOperationHint } = require('../dist/src/reply/actions.js');
  const text = buildOperationHint(claim({ items: [{ invoice }] }));
  assert.match(text, /继续上传发票/);
  assert.match(text, /附件/);
  assert.match(text, /报销事由/);
  assert.match(text, /取消/);
  assert.doesNotMatch(text, /金额 数字|回复「确认」|修改类别/);
});

test('借款选择阶段提示序号，不能提示文字修改事由或金额', () => {
  const { buildOperationHint } = require('../dist/src/reply/actions.js');
  const text = buildOperationHint(claim({ items: [{ invoice }], mode: 'loan_writeoff', loanCandidates: [loan, loan] }));
  assert.match(text, /1-2/);
  assert.match(text, /取消/);
  assert.match(text, /附件/);
  assert.doesNotMatch(text, /事由|金额 数字|回复「确认」/);
});

test('附件模式预览支持确认和修改，追加材料后要求重新生成预览', () => {
  const { buildOperationHint } = require('../dist/src/reply/actions.js');
  const pending = claim({ items: [{ invoice }], collectingAttachments: true, draft: { reason: '客户拜访' } });
  const before = JSON.stringify(pending);
  const text = buildOperationHint(pending);
  assert.match(text, /回复「确认」/);
  assert.match(text, /金额 数字/);
  assert.match(text, /类别/);
  assert.match(text, /新的报销事由/);
  assert.match(text, /继续上传辅助材料/);
  assert.match(text, /回复「发票」切回/);
  assert.match(text, /重新.*预览/);
  assert.match(text, /取消/);
  assert.equal(JSON.stringify(pending), before);
});

test('direct 费用报销明确上传发票即提交，不承诺事由确认流程', () => {
  const { buildOperationHint } = require('../dist/src/reply/actions.js');
  const text = buildOperationHint(claim(), { directExpense: true });
  assert.match(text, /识别成功后直接提交/);
  assert.doesNotMatch(text, /回复.*事由|回复.*确认/);
  const loanText = buildOperationHint(claim({ mode: 'loan_writeoff', items: [{ invoice }] }), { directExpense: true });
  assert.match(loanText, /核销事由/);
  assert.doesNotMatch(loanText, /识别成功后直接提交/);
});
