const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseChineseAmount } = require('../dist/src/invoice/chineseAmount.js');
const { buildFromParsed } = require('../dist/src/invoice/recognize.js');

test('解析中文大写金额', () => {
  assert.equal(parseChineseAmount('壹万贰仟叁佰肆拾伍元陆角柒分'), 12345.67);
  assert.equal(parseChineseAmount('贰佰元整'), 200);
  assert.equal(parseChineseAmount('贰佰圆正'), 200);
  assert.equal(parseChineseAmount('拾元整'), 10);
  assert.equal(parseChineseAmount('壹佰零壹元零伍分'), 101.05);
  assert.equal(parseChineseAmount('叁仟元'), 3000);
  assert.equal(parseChineseAmount('壹亿贰仟万元整'), 120000000);
  assert.equal(parseChineseAmount('价税合计（大写）壹佰元整'), 100);
  assert.equal(parseChineseAmount('叁拾元伍角'), 30.5);
});

test('大写金额解析失败时返回 undefined（宁缺勿错）', () => {
  assert.equal(parseChineseAmount('100.00'), undefined);
  assert.equal(parseChineseAmount('壹佰元abc'), undefined);
  assert.equal(parseChineseAmount(''), undefined);
  assert.equal(parseChineseAmount(undefined), undefined);
  assert.equal(parseChineseAmount('无'), undefined);
});

function vat(extra) {
  return { type: 'vat', invoiceNo: '12345678', date: '2026-09-01', sellerName: '测试商家', ...extra };
}

test('大写金额与不含税+税额一致时，纠正取错列的小写金额', () => {
  const inv = buildFromParsed(
    vat({ amount: '100.00', netAmount: '100.00', taxAmount: '6.00', amountInWords: '壹佰零陆元整' })
  );
  assert.equal(inv.amount, '106.00');
});

test('小写金额本身正确时，大写金额只做印证不改动', () => {
  const inv = buildFromParsed(
    vat({ amount: '106.00', netAmount: '100.00', taxAmount: '6.00', amountInWords: '壹佰零陆元整' })
  );
  assert.equal(inv.amount, '106.00');
});

test('大写金额可在缺少税额信息时补全/校正价税合计', () => {
  const inv = buildFromParsed(vat({ amount: '', amountInWords: '壹仟贰佰叁拾肆元伍角陆分' }));
  assert.equal(inv.amount, '1234.56');
});

test('大写疑似误识（与数字勾稽结果冲突）时保留数字金额', () => {
  const inv = buildFromParsed(
    vat({ amount: '106.00', netAmount: '100.00', taxAmount: '6.00', amountInWords: '玖佰元整' })
  );
  assert.equal(inv.amount, '106.00');
});

test('非增值税发票不做大写校正', () => {
  const inv = buildFromParsed({
    type: 'train',
    amount: '553.50',
    amountInWords: '壹佰元整',
    invoiceNo: 'E123456789',
  });
  assert.equal(inv.amount, '553.50');
});
