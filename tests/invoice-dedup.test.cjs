const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');
const {
  InvoiceDuplicateError,
  InvoiceUsageLedger,
  invoiceFingerprint,
} = require('../dist/src/invoice/dedup.js');

const tempDirs = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function ledgerPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invoice-dedup-'));
  tempDirs.push(dir);
  return path.join(dir, 'ledger.json');
}

function invoice(overrides = {}) {
  return {
    type: 'vat',
    typeLabel: '增值税发票',
    invoiceCode: '044001900111',
    invoiceNo: '12345678',
    amount: '100.00',
    date: '2026-08-24',
    sellerName: '测试商家',
    raw: {},
    ...overrides,
  };
}

test('相同发票号码在格式或 invoiceCode 识别结果不同时仍生成同一指纹', () => {
  const first = invoiceFingerprint(invoice());
  const formatted = invoiceFingerprint(invoice({ invoiceCode: undefined, invoiceNo: ' 12-345-678 ' }));
  assert.equal(first, formatted);
});

test('无发票号码票据使用规范化字段生成稳定指纹', () => {
  const first = invoiceFingerprint(invoice({ invoiceCode: undefined, invoiceNo: undefined, sellerName: '上海 出租车', amount: '35元' }));
  const second = invoiceFingerprint(invoice({ invoiceCode: undefined, invoiceNo: undefined, sellerName: '上海出租车', amount: '35.00' }));
  assert.equal(first, second);
});

test('同一批次中重复发票会在创建审批前被拒绝', () => {
  const store = new InvoiceUsageLedger(ledgerPath());
  assert.throws(
    () => store.reserve([invoice(), invoice({ invoiceCode: undefined })], 'expense', 'open-1'),
    (error) => error instanceof InvoiceDuplicateError && error.duplicate.duplicateInBatch === true
  );
});

test('费用报销使用过的发票不能再用于借款核销，且重启后仍生效', () => {
  const file = ledgerPath();
  const store = new InvoiceUsageLedger(file);
  const reservation = store.reserve([invoice()], 'expense', 'open-1');
  store.markSubmitted(reservation, 'expense-instance-1');

  const restarted = new InvoiceUsageLedger(file);
  const used = restarted.find(invoice());
  assert.equal(used.status, 'submitted');
  assert.equal(used.mode, 'expense');
  assert.equal(used.approvalInstanceCode, 'expense-instance-1');
  assert.throws(
    () => restarted.reserve([invoice()], 'loan_writeoff', 'open-2'),
    (error) => error instanceof InvoiceDuplicateError && error.duplicate.existing.mode === 'expense'
  );
});

test('审批创建失败时释放预占后可以重新提交', () => {
  const store = new InvoiceUsageLedger(ledgerPath());
  const reservation = store.reserve([invoice()], 'loan_writeoff', 'open-1');
  assert.equal(store.find(invoice()).status, 'reserved');
  store.release(reservation);
  assert.equal(store.find(invoice()), undefined);
  assert.doesNotThrow(() => store.reserve([invoice()], 'expense', 'open-1'));
});
