import * as fs from 'fs';
import * as path from 'path';

export type LoanWriteOffStatus = 'pending' | 'written_off' | 'released';
export interface LoanWriteOffEntry {
  loanInstanceCode: string;
  writeOffInstanceCode: string;
  applicantOpenId: string;
  chatId: string;
  status: LoanWriteOffStatus;
  submittedAt: string;
  updatedAt: string;
  writtenOffAt?: string;
  releaseReason?: string;
  writeOffAmount: number;
  loanAmount: number;
}
interface LedgerFile { version: 2; entries: LoanWriteOffEntry[] }
export interface InstanceTransition { matched: boolean; changed: boolean; entries: LoanWriteOffEntry[] }

/** 按原付款申请实例累计审批中/已通过的核销金额，支持一笔借款分批核销。 */
export class LoanWriteOffLedger {
  private readonly filePath: string;
  private data: LedgerFile;
  constructor(filePath: string) { this.filePath = path.resolve(filePath); this.data = this.load(); }
  private load(): LedgerFile {
    if (!fs.existsSync(this.filePath)) return { version: 2, entries: [] };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<LedgerFile>;
      if (!Array.isArray(parsed.entries)) throw new Error('缺少 entries 数组');
      return { version: 2, entries: parsed.entries as LoanWriteOffEntry[] };
    } catch (error) {
      throw new Error(`借款核销台账读取失败 ${this.filePath}：${(error as Error).message}`);
    }
  }
  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, this.filePath);
  }
  amounts(loanInstanceCode: string): { writtenOff: number; pending: number } {
    const entries = this.data.entries.filter((e) => e.loanInstanceCode === loanInstanceCode);
    return {
      writtenOff: entries.filter((e) => e.status === 'written_off').reduce((s, e) => s + (Number(e.writeOffAmount) || 0), 0),
      pending: entries.filter((e) => e.status === 'pending').reduce((s, e) => s + (Number(e.writeOffAmount) || 0), 0),
    };
  }
  remaining(loanInstanceCode: string, loanAmount: number): number {
    const used = this.amounts(loanInstanceCode);
    return Math.max(0, loanAmount - used.writtenOff - used.pending);
  }
  recordSubmitted(loanInstanceCode: string, writeOffInstanceCode: string, applicantOpenId: string, chatId: string, writeOffAmount: number, loanAmount: number): LoanWriteOffEntry {
    if (!(writeOffAmount > 0)) throw new Error('本次核销金额必须大于 0');
    const remaining = this.remaining(loanInstanceCode, loanAmount);
    if (writeOffAmount > remaining + 0.005) throw new Error(`本次核销金额 ¥${writeOffAmount.toFixed(2)} 超过借款剩余可核销金额 ¥${remaining.toFixed(2)}`);
    const now = new Date().toISOString();
    const entry: LoanWriteOffEntry = { loanInstanceCode, writeOffInstanceCode, applicantOpenId, chatId, status: 'pending', submittedAt: now, updatedAt: now, writeOffAmount, loanAmount };
    this.data.entries.push(entry); this.save(); return { ...entry };
  }
  markWrittenOff(code: string, at?: string): InstanceTransition { return this.transition(code, 'written_off', at); }
  release(code: string, reason: string, at?: string): InstanceTransition { return this.transition(code, 'released', at, reason); }
  private transition(code: string, status: LoanWriteOffStatus, at?: string, reason?: string): InstanceTransition {
    const entries = this.data.entries.filter((e) => e.writeOffInstanceCode === code);
    if (!entries.length) return { matched: false, changed: false, entries: [] };
    const time = at || new Date().toISOString(); let changed = false;
    for (const entry of entries) {
      if (entry.status === status) continue;
      entry.status = status; entry.updatedAt = time;
      if (status === 'written_off') entry.writtenOffAt = time; else delete entry.writtenOffAt;
      if (reason) entry.releaseReason = reason; else delete entry.releaseReason;
      changed = true;
    }
    if (changed) this.save();
    return { matched: true, changed, entries: entries.map((e) => ({ ...e })) };
  }
}
