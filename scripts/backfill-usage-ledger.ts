/**
 * 回填发票检重台账（一次性工具）。
 * 遍历「借款核销 / 费用报销」历史审批实例，下载其「图片(image)」「附件(attachmentV2)」控件里的发票，
 * 重新 OCR 提取号码算指纹，写入 INVOICE_USAGE_LEDGER_PATH（status=submitted）用于以后去重。
 *
 * 说明：
 * - 历史 PDF 当年是被栅格化进「图片」控件的，所以下载图片 URL 即覆盖历史图片与历史 PDF；
 *   新版 PDF 则在 attachmentV2，脚本两类控件都抓取其 URL。
 * - 只能覆盖「当初上传了图片/附件」的审批；更早无附件的审批无法回溯（会列出）。
 * - 默认 dry-run（只统计不写）；加 --write 才写台账（写前自动备份）。
 *
 * 用法：
 *   npx tsx scripts/backfill-usage-ledger.ts [--write] [--approval both|expense|loan]
 *        [--status PENDING,APPROVED] [--start 2024-01-01] [--limit N]
 */
import * as fs from 'fs';
import * as path from 'path';
import * as lark from '@larksuiteoapi/node-sdk';
import { loadConfig, AppConfig } from '../src/config';
import { createClient } from '../src/lark';
import { recognizeInvoice, recognizeInvoiceFromText } from '../src/invoice/recognize';
import { isPdf, extractPdfText, hasUsableText, pdfFirstPageToImage } from '../src/invoice/pdf';
import { invoiceFingerprint, describeInvoice } from '../src/invoice/dedup';
import { fetchWithTimeout } from '../src/util/http';
import { RecognizedInvoice } from '../src/types';

type Mode = 'loan_writeoff' | 'expense';

interface Entry {
  fingerprint: string;
  description: string;
  status: 'submitted';
  reservationId: string;
  mode: Mode;
  applicantOpenId: string;
  createdAt: string;
  approvalInstanceCode?: string;
  submittedAt?: string;
}

function argVal(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function isoTime(value?: string): string {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return new Date(n < 1e10 ? n * 1000 : n).toISOString();
  return new Date().toISOString();
}

/** 从审批表单里抽取「图片/附件」控件的所有可下载 URL。 */
function extractFileUrls(form: string): string[] {
  let widgets: unknown[] = [];
  try {
    widgets = JSON.parse(form || '[]') as unknown[];
  } catch {
    return [];
  }
  const urls: string[] = [];
  for (const raw of widgets) {
    const w = raw as { type?: string; value?: unknown };
    if (w?.type !== 'image' && w?.type !== 'attachmentV2') continue;
    const s = typeof w.value === 'string' ? w.value : JSON.stringify(w.value ?? '');
    const matched = s.match(/https?:\/\/[^\s"'\\]+/g);
    if (matched) urls.push(...matched);
  }
  return Array.from(new Set(urls));
}

async function download(url: string, cfg: AppConfig): Promise<Buffer> {
  const r = await fetchWithTimeout(url, {}, cfg.requestTimeoutMs);
  if (!r.ok) throw new Error(`下载 HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

async function recognizeBuffer(cfg: AppConfig, buf: Buffer): Promise<RecognizedInvoice> {
  if (isPdf(buf)) {
    const text = await extractPdfText(buf);
    if (hasUsableText(text)) return recognizeInvoiceFromText(cfg, text);
    const img = await pdfFirstPageToImage(buf);
    return recognizeInvoice(cfg, img);
  }
  return recognizeInvoice(cfg, buf);
}

async function listInstances(
  client: lark.Client,
  approvalCode: string,
  startMs: number,
  endMs: number,
  limit: number
): Promise<string[]> {
  const out: string[] = [];
  let pageToken: string | undefined;
  do {
    const resp = (await client.approval.v4.instance.list({
      params: {
        approval_code: approvalCode,
        start_time: String(startMs),
        end_time: String(endMs),
        page_size: 100,
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    })) as { code?: number; msg?: string; data?: { instance_code_list?: string[]; has_more?: boolean; page_token?: string } };
    if (typeof resp.code === 'number' && resp.code !== 0) {
      throw new Error(`instance.list code=${resp.code} msg=${resp.msg}`);
    }
    for (const c of resp.data?.instance_code_list || []) out.push(c);
    pageToken = resp.data?.has_more ? resp.data.page_token : undefined;
    if (limit > 0 && out.length >= limit) return out.slice(0, limit);
  } while (pageToken);
  return out;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const client = createClient(cfg);
  const write = hasFlag('--write');
  const listOnly = hasFlag('--list-only');
  const which = (argVal('--approval') || 'both').toLowerCase();
  const statuses = new Set(
    (argVal('--status') || 'PENDING,APPROVED')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
  );
  const startMs = argVal('--start') ? Date.parse(argVal('--start') as string) : Date.parse('2024-01-01');
  const endMs = Date.now();
  const limit = Number(argVal('--limit') || '0') || 0;

  const targets: { mode: Mode; code: string }[] = [];
  if (which === 'both' || which === 'expense') targets.push({ mode: 'expense', code: cfg.expenseApprovalCode });
  if (which === 'both' || which === 'loan') targets.push({ mode: 'loan_writeoff', code: cfg.approvalCode });

  const ledgerPath = path.resolve(cfg.invoiceUsageLedgerPath);
  let ledger: { version: 1; entries: Entry[] } = { version: 1, entries: [] };
  if (fs.existsSync(ledgerPath)) {
    const parsed = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) as { entries?: Entry[] };
    if (!Array.isArray(parsed.entries)) throw new Error('台账格式错误：缺 entries 数组');
    ledger = { version: 1, entries: parsed.entries };
  }
  const existing = new Set(ledger.entries.map((e) => e.fingerprint));
  const doneInstances = new Set(
    ledger.entries.map((e) => e.approvalInstanceCode).filter((c): c is string => !!c)
  );
  let addedCount = 0;
  let backedUp = false;
  const flush = (): void => {
    if (!write) return;
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    if (!backedUp && fs.existsSync(ledgerPath)) {
      fs.copyFileSync(ledgerPath, `${ledgerPath}.bak.${Date.now()}`);
      backedUp = true;
    }
    const tmp = `${ledgerPath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, ledgerPath);
  };

  const report = {
    instances: 0,
    statusSkipped: {} as Record<string, number>,
    noFile: [] as string[],
    recogFail: 0,
    dupSkip: 0,
    inScope: 0,
    totalUrls: 0,
    nonInvoice: 0,
    resumeSkipped: 0,
  };

  console.log(
    `台账：${ledgerPath}（现有 ${ledger.entries.length} 条）\n范围：start=${new Date(startMs).toISOString().slice(0, 10)} end=now  状态=${[...statuses].join(',')}  approval=${which}  limit=${limit || '∞'}  ${write ? 'WRITE' : 'DRY-RUN'}`
  );

  for (const t of targets) {
    console.log(`\n### ${t.mode}  code=${t.code}`);
    const codes = await listInstances(client, t.code, startMs, endMs, limit);
    console.log(`  实例数：${codes.length}`);
    for (const code of codes) {
      report.instances++;
      if (doneInstances.has(code)) {
        report.resumeSkipped++;
        continue;
      }
      const detail = (await client.approval.v4.instance.get({ path: { instance_id: code } })) as {
        data?: { status?: string; form?: string; open_id?: string; user_id?: string; start_time?: string; end_time?: string };
      };
      const d = detail.data || {};
      const status = String(d.status || '').toUpperCase();
      if (!statuses.has(status)) {
        report.statusSkipped[status] = (report.statusSkipped[status] || 0) + 1;
        continue;
      }
      const urls = extractFileUrls(d.form || '');
      if (urls.length === 0) {
        report.noFile.push(code);
        continue;
      }
      report.inScope++;
      report.totalUrls += urls.length;
      if (listOnly) continue; // 只统计规模，不下载/不OCR
      const openId = d.open_id || d.user_id || '';
      const createdAt = isoTime(d.start_time);
      const submittedAt = isoTime(d.end_time || d.start_time);
      const beforeAdd = addedCount;
      for (const url of urls) {
        try {
          const buf = await download(url, cfg);
          const inv = await recognizeBuffer(cfg, buf);
          if (inv.type === 'unknown') {
            report.nonInvoice++;
            console.log(`    [跳过·非发票/未知] ${code}（如支付截图等，不入台账）`);
            continue;
          }
          const fp = invoiceFingerprint(inv);
          if (existing.has(fp)) {
            report.dupSkip++;
            continue;
          }
          existing.add(fp);
          ledger.entries.push({
            fingerprint: fp,
            description: describeInvoice(inv),
            status: 'submitted',
            reservationId: `backfill:${code}`,
            mode: t.mode,
            applicantOpenId: openId,
            createdAt,
            approvalInstanceCode: code,
            submittedAt,
          });
          addedCount++;
          console.log(`    [新增] ${describeInvoice(inv)}  fp=${fp.slice(0, 48)}`);
        } catch (e) {
          report.recogFail++;
          console.log(`    [失败] ${code}: ${(e as Error).message}`);
        }
      }
      if (write && addedCount > beforeAdd) flush(); // 增量落盘，支持断点续跑
    }
  }

  console.log(`\n==== 汇总 ====`);
  console.log(`扫描实例：${report.instances}`);
  console.log(`按状态跳过：${JSON.stringify(report.statusSkipped)}（不在 ${[...statuses].join(',')} 内，如 CANCELED/REJECTED）`);
  console.log(`无图片/附件（无法回溯）：${report.noFile.length}`);
  console.log(`在范围内(有图/附件)实例：${report.inScope}，其中文件/发票数约：${report.totalUrls}`);

  if (listOnly) {
    const mins = Math.ceil((report.totalUrls * 38) / 60);
    console.log(`\n[list-only] 仅统计规模，未下载/未识别。`);
    console.log(`预计需 OCR 约 ${report.totalUrls} 个文件；按 ~38s/个 粗估约 ${mins} 分钟（文本型PDF更快）。`);
    return;
  }

  console.log(`断点续跑跳过(已在台账的实例)：${report.resumeSkipped}`);
  console.log(`非发票/未知票种（已跳过，如支付截图）：${report.nonInvoice}`);
  console.log(`下载/识别失败：${report.recogFail}`);
  console.log(`重复跳过（已在台账）：${report.dupSkip}`);
  console.log(`本次新增指纹：${addedCount}（台账现共 ${ledger.entries.length} 条）`);

  if (!write) {
    console.log(`\n[dry-run] 未写入。确认无误后加 --write 落台账（增量落盘，可断点续跑）。`);
    return;
  }
  flush();
  console.log(`\n[已写入] 本次新增 ${addedCount} 条 -> ${ledgerPath}（原文件已备份，增量落盘、可断点续跑）`);
}

main().catch((e: unknown) => {
  const err = e as { response?: { data?: unknown }; message?: string };
  console.error('[错误]', err?.response?.data || err?.message || e);
  process.exit(1);
});
