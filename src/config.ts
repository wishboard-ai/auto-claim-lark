import * as dotenv from 'dotenv';
import * as lark from '@larksuiteoapi/node-sdk';

// quiet: 关闭 dotenv v17 默认打印的加载提示横幅
dotenv.config({ quiet: true });

function req(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(
      `缺少必需的环境变量 ${name}。请复制 .env.example 为 .env 并填写相应值（详见 README）。`
    );
  }
  return v.trim();
}

function opt(name: string, def: string): string {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : def;
}

function resolveDomain(): string | lark.Domain {
  return opt('FEISHU_DOMAIN', 'feishu').toLowerCase() === 'lark'
    ? lark.Domain.Lark
    : lark.Domain.Feishu;
}

/**
 * 提交模式：
 * - confirm：识别后先在聊天中展示，用户回复「确认」才创建并提交审批（默认，含人工复核关卡）
 * - direct ：识别后直接创建并提交审批，无需人工确认
 */
export type SubmitMode = 'confirm' | 'direct';

/** 仅凭证（inspect 脚本等使用，无需审批相关配置） */
export interface Credentials {
  appId: string;
  appSecret: string;
  domain: string | lark.Domain;
  logLevel: string;
}

/** 可选的 LLM 配置（OpenAI 兼容接口）。未配置 apiKey 时禁用，回退到模板生成。 */
export interface LlmConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * 发票 OCR 识别配置。provider 决定后端：
 * - openai：OpenAI 兼容多模态大模型（云端 qwen-vl-max / 本地 Ollama qwen2.5vl）。默认复用 LLM_API_KEY/LLM_BASE_URL。
 * - paddle：本地 PaddleOCR 微服务（默认 http://localhost:8000），无需 API Key。
 */
export interface OcrConfig {
  provider: 'openai' | 'paddle';
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 机器人完整运行配置 */
export interface AppConfig extends Credentials {
  approvalCode: string;
  submitMode: SubmitMode;
  llm: LlmConfig;
  ocr: OcrConfig;
}

export function loadCredentials(): Credentials {
  return {
    appId: req('FEISHU_APP_ID'),
    appSecret: req('FEISHU_APP_SECRET'),
    domain: resolveDomain(),
    logLevel: opt('LOG_LEVEL', 'info'),
  };
}

export function loadConfig(): AppConfig {
  const creds = loadCredentials();
  const submitMode: SubmitMode =
    opt('SUBMIT_MODE', 'confirm').toLowerCase() === 'direct' ? 'direct' : 'confirm';
  const apiKey = opt('LLM_API_KEY', '');
  const llm: LlmConfig = {
    enabled: !!apiKey,
    baseUrl: opt('LLM_BASE_URL', 'https://api.openai.com/v1'),
    apiKey,
    model: opt('LLM_MODEL', 'gpt-4o-mini'),
  };
  // OCR 后端：openai（多模态大模型）| paddle（本地 PaddleOCR 服务）
  const provider: OcrConfig['provider'] =
    opt('OCR_PROVIDER', 'openai').toLowerCase() === 'paddle' ? 'paddle' : 'openai';
  const ocrApiKey = opt('OCR_API_KEY', apiKey);
  const ocrDefaultBase =
    provider === 'paddle'
      ? 'http://localhost:8000'
      : opt('LLM_BASE_URL', 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  const ocr: OcrConfig = {
    provider,
    // paddle 后端无需 API Key；openai 后端需要 key 才算启用
    enabled: provider === 'paddle' ? true : !!ocrApiKey,
    baseUrl: opt('OCR_BASE_URL', ocrDefaultBase),
    apiKey: ocrApiKey,
    model: opt('OCR_MODEL', 'qwen-vl-max'),
  };
  return {
    ...creds,
    approvalCode: req('APPROVAL_CODE'),
    submitMode,
    llm,
    ocr,
  };
}
