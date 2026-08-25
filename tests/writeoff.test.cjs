const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');
const { LoanWriteOffLedger } = require('../dist/src/writeoff/ledger.js');
const { parseLoanDetail, isLoanApprovalAdmin, listOutstandingLoans } = require('../dist/src/writeoff/loans.js');
const { makeApprovalStatusHandler } = require('../dist/src/writeoff/approvalHandler.js');
const { buildApprovalForm, getCategoryOptionNames } = require('../dist/src/approval/fieldMapping.js');
const { createApprovalInstance } = require('../dist/src/approval/submit.js');
const { startSession, addItem, selectLoan, setDraft, getPending, clearPending } = require('../dist/src/handlers/session.js');
const { modeSelectionCard } = require('../dist/src/reply/cards.js');

const tempDirs = [];
afterEach(() => { for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function ledger() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loan-writeoff-')); tempDirs.push(dir); return new LoanWriteOffLedger(path.join(dir, 'ledger.json')); }

function paymentForm(amount = '100.00') {
  return JSON.stringify([
    { id: 'widget17742552760470001', value: '客户项目采购' },
    { id: 'widget17742539539820001', value: [[{ id: 'widget17742540352210001', value: amount }]] },
  ]);
}

test('用户首先选择办理类型，借款核销会话可完整保存发票、借款和确认草稿', () => {
  const openId = 'self-service-open-id';
  const card = JSON.parse(modeSelectionCard());
  assert.match(JSON.stringify(card), /借款核销/);
  assert.match(JSON.stringify(card), /费用报销/);

  startSession(openId, 'loan_writeoff');
  addItem(openId, { invoice: { type: 'vat', typeLabel: '增值税发票', amount: '40.00', date: '2026-08-01', raw: {} } });
  const loan = { instanceCode: 'loan-1', serialNumber: '20260824001', title: '付款申请', approvedAt: '2026-08-24T03:00:00.000Z', approvedDate: '2026-08-24', amount: '100.00' };
  selectLoan(openId, loan);
  setDraft(openId, { reason: '客户拜访交通费', title: '借款核销-交通费' });

  const pending = getPending(openId);
  assert.equal(pending.mode, 'loan_writeoff');
  assert.equal(pending.items.length, 1);
  assert.equal(pending.loan.instanceCode, 'loan-1');
  assert.equal(pending.draft.reason, '客户拜访交通费');
  clearPending(openId);
});

test('付款申请的实际借款时间取审批 end_time，并汇总费用明细金额', () => {
  const form = JSON.stringify([
    { id: 'widget17742552760470001', value: '客户项目采购' },
    { id: 'widget17742539539820001', value: [
      [{ id: 'widget17742540352210001', value: '100.50' }],
      [{ id: 'widget17742540352210001', value: '20' }],
    ] },
  ]);
  const loan = parseLoanDetail({ instance_code: 'loan-1', serial_number: '20260824001', approval_name: '付款申请', end_time: '1787542200000', form });
  assert.equal(loan.approvedAt, new Date(1787542200000).toISOString());
  assert.equal(loan.amount, '120.50');
  assert.equal(loan.reason, '客户项目采购');
});

test('机器人按当前用户查询借款，并只返回仍有可核销余额的付款申请', async () => {
  const store = ledger();
  store.recordSubmitted('loan-1', 'writeoff-1', 'self-service-open-id', 'chat-1', 40, 100);
  store.markWrittenOff('writeoff-1');
  const queryPayloads = [];
  const client = {
    approval: { v4: { instance: {
      query: async (payload) => {
        queryPayloads.push(payload);
        return payload.params.page_token
          ? { code: 0, data: { instance_list: [], has_more: false } }
          : { code: 0, data: { instance_list: [{ instance: { code: 'loan-1' } }], has_more: true, page_token: 'next-page' } };
      },
      get: async () => ({ code: 0, data: { instance_code: 'loan-1', serial_number: '20260824001', approval_name: '付款申请', status: 'APPROVED', end_time: '1787542200000', form: paymentForm() } }),
    } } },
  };
  const cfg = { writeOff: { loanApprovalCode: 'payment-code', lookbackDays: 365 } };
  const loans = await listOutstandingLoans(client, cfg, 'self-service-open-id', store);
  assert.ok(queryPayloads.length > 1);
  assert.ok(queryPayloads.some((payload) => payload.params.page_token === 'next-page'));
  assert.ok(queryPayloads.every((payload) => payload.data.user_id === 'self-service-open-id'));
  assert.ok(queryPayloads.every((payload) => payload.data.approval_code === 'payment-code'));
  assert.ok(queryPayloads.every((payload) => payload.data.instance_status === 'APPROVED'));
  assert.ok(queryPayloads.every((payload) => {
    const span = Number(payload.data.instance_start_time_to) - Number(payload.data.instance_start_time_from);
    return span >= 0 && span <= 29 * 86_400_000;
  }));
  assert.equal(loans.length, 1);
  assert.equal(loans[0].remainingAmount, '60.00');
});

test('付款申请管理员核销时可查询所有申请人的未核销付款申请', async () => {
  const store = ledger();
  const queryPayloads = [];
  const client = {
    approval: { v4: {
      approval: {
        get: async () => ({ code: 0, data: { approval_admin_ids: ['admin-open-id'] } }),
      },
      instance: {
        query: async (payload) => {
          queryPayloads.push(payload);
          return { code: 0, data: { instance_list: [{ instance: { code: 'loan-other-user' } }], has_more: false } };
        },
        get: async () => ({ code: 0, data: { instance_code: 'loan-other-user', serial_number: '20260824002', approval_name: '付款申请', open_id: 'applicant-open-id', status: 'APPROVED', end_time: '1787542200000', form: paymentForm('200.00') } }),
      },
    } },
  };
  const cfg = { writeOff: { loanApprovalCode: 'payment-code', lookbackDays: 30 } };

  assert.equal(await isLoanApprovalAdmin(client, cfg, 'admin-open-id'), true);
  assert.equal(await isLoanApprovalAdmin(client, cfg, 'ordinary-open-id'), false);
  const loans = await listOutstandingLoans(client, cfg, 'admin-open-id', store, true);

  assert.ok(queryPayloads.length > 0);
  assert.ok(queryPayloads.every((payload) => !('user_id' in payload.data)));
  assert.equal(loans.length, 1);
  assert.equal(loans[0].applicantOpenId, 'applicant-open-id');
  assert.equal(loans[0].remainingAmount, '200.00');
});

test('确认后以当前用户身份发起正确的借款核销审批定义', async () => {
  let createPayload;
  const client = { approval: { v4: { instance: { create: async (payload) => {
    createPayload = payload;
    return { code: 0, data: { instance_code: 'writeoff-1', instance_link: { pc_link: 'https://example.test/approval' } } };
  } } } } };
  const cfg = { approvalCode: 'loan-writeoff-code' };
  const form = [{ id: 'amount-widget', type: 'amount', value: '40.00' }];
  const result = await createApprovalInstance(client, cfg, 'self-service-open-id', form, '借款核销-交通费', 'loan-writeoff-code');
  assert.equal(createPayload.data.approval_code, 'loan-writeoff-code');
  assert.equal(createPayload.data.open_id, 'self-service-open-id');
  assert.deepEqual(JSON.parse(createPayload.data.form), form);
  assert.equal(result.instanceCode, 'writeoff-1');
  assert.equal(result.instanceLink, 'https://example.test/approval');
});

test('同一付款申请可分批核销，并按审批中/已通过金额计算剩余额度', () => {
  const store = ledger();
  store.recordSubmitted('loan-1', 'writeoff-1', 'open-1', 'chat-1', 40, 100);
  assert.deepEqual(store.amounts('loan-1'), { writtenOff: 0, pending: 40 });
  assert.equal(store.remaining('loan-1', 100), 60);

  store.markWrittenOff('writeoff-1');
  assert.deepEqual(store.amounts('loan-1'), { writtenOff: 40, pending: 0 });
  store.recordSubmitted('loan-1', 'writeoff-2', 'open-1', 'chat-1', 35, 100);
  assert.equal(store.remaining('loan-1', 100), 25);

  store.release('writeoff-2', 'REJECTED');
  assert.equal(store.remaining('loan-1', 100), 60);
  assert.throws(
    () => store.recordSubmitted('loan-1', 'writeoff-too-large', 'open-1', 'chat-1', 60.01, 100),
    /超过借款剩余可核销金额/
  );

  store.recordSubmitted('loan-1', 'writeoff-3', 'open-1', 'chat-1', 60, 100);
  store.markWrittenOff('writeoff-3');
  assert.equal(store.remaining('loan-1', 100), 0);
});

test('核销审批通过事件只确认本次金额、展示余额并保持幂等', async () => {
  const store = ledger();
  store.recordSubmitted('loan-1', 'writeoff-1', 'open-1', 'chat-1', 40, 100);
  const sent = [];
  const client = { im: { v1: { message: { create: async (payload) => sent.push(payload) } } } };
  const cfg = { approvalCode: 'writeoff-code', writeOff: { enabled: true }, invoiceScan: { enabled: false } };
  const handler = makeApprovalStatusHandler(client, cfg, store);
  await handler({ approval_code: 'writeoff-code', instance_code: 'writeoff-1', status: 'APPROVED' });
  assert.deepEqual(store.amounts('loan-1'), { writtenOff: 40, pending: 0 });
  assert.equal(store.remaining('loan-1', 100), 60);
  assert.equal(sent.length, 1);
  assert.match(sent[0].data.content, /40\.00/);
  assert.match(sent[0].data.content, /60\.00/);
  await handler({ approval_code: 'writeoff-code', instance_code: 'writeoff-1', status: 'APPROVED' });
  assert.equal(sent.length, 1);
});

test('费用报销使用发票日期，借款核销使用付款申请 end_time 对应日期', () => {
  const invoice = {
    type: 'vat',
    typeLabel: '增值税发票',
    amount: '40.00',
    date: '2026-08-01',
    sellerName: '测试商家',
    raw: {},
  };
  const loan = {
    instanceCode: 'loan-1',
    serialNumber: '20260824001',
    title: '付款申请',
    approvedAt: '2026-08-24T03:00:00.000Z',
    approvedDate: '2026-08-24',
    amount: '100.00',
  };
  const dateValue = (form) => {
    const list = form.find((field) => field.id === 'widget16510509950440001');
    return list.value[0].find((field) => field.id === 'widget16510510138590001').value;
  };
  assert.equal(dateValue(buildApprovalForm([invoice]).form), '2026-08-01T00:00:00+08:00');
  assert.equal(dateValue(buildApprovalForm([invoice], {}, [], [], loan).form), '2026-08-24T00:00:00+08:00');
  assert.equal(buildApprovalForm([invoice]).form.some((field) => field.id === 'widget16510509818090001'), true);
  assert.equal(buildApprovalForm([invoice], {}, [], [], loan).form.some((field) => field.id === 'widget16510509818090001'), false);
  assert.equal(getCategoryOptionNames('loan_writeoff').includes('房租物业费'), true);
  assert.equal(getCategoryOptionNames('loan_writeoff').includes('项目相关采购'), false);
  assert.equal(getCategoryOptionNames('expense').includes('项目相关采购'), true);
});
