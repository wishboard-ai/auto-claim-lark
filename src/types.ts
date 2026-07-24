/** 支持的票据类型 */
export type InvoiceType = 'vat' | 'train' | 'taxi' | 'unknown';

/** 归一化后的发票信息（识别结果的统一表示） */
export interface RecognizedInvoice {
  /** 票据类型 */
  type: InvoiceType;
  /** 票据类型中文名，用于展示 */
  typeLabel: string;
  /** 金额（元），VAT 取价税合计，火车/出租取总额 */
  amount?: string;
  /** 日期，归一化为 YYYY-MM-DD */
  date?: string;
  /** 销售方 / 商家 / 承运方 */
  sellerName?: string;
  /** 购买方 */
  buyerName?: string;
  /** 发票号码 / 票号 */
  invoiceNo?: string;
  /** 税额（元） */
  taxAmount?: string;
  /** 摘要说明（如 出发→到达、车次、里程等） */
  summary?: string;
  /** 原始识别字段（type -> value），便于调试和扩展映射 */
  raw: Record<string, string>;
}

/** 审批表单单个控件的填充值 */
export interface FormField {
  id: string;
  type: string;
  value: unknown;
}
