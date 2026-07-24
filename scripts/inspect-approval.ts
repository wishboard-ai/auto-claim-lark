/**
 * 查看审批定义的表单控件，便于配置 config/field-mapping.json。
 * 用法： npm run inspect:approval -- <approval_code>
 * 若省略参数，则读取 .env 中的 APPROVAL_CODE。
 */
import { loadCredentials } from '../src/config';
import { createClient } from '../src/lark';

function printWidget(w: any, indent = ''): void {
  const id = w.id ?? w.widget_id ?? w.custom_id ?? '(无id)';
  const name = w.name ?? w.label ?? '';
  const type = w.type ?? '';
  console.log(`${indent}${id}  →  ${name}  [${type}]`);
  const children = w.children ?? w.controls ?? w.option ?? [];
  if (Array.isArray(children)) {
    for (const c of children) {
      if (c && typeof c === 'object' && (c.id || c.name)) printWidget(c, indent + '    ');
    }
  }
}

async function main(): Promise<void> {
  const approvalCode = process.argv[2] || process.env.APPROVAL_CODE;
  if (!approvalCode) {
    console.error('用法： npm run inspect:approval -- <approval_code>');
    process.exit(1);
  }

  const client = createClient(loadCredentials());
  const resp = await client.approval.v4.approval.get({
    path: { approval_code: approvalCode },
    params: { locale: 'zh-CN' },
  });

  const data = resp.data;
  if (!data) {
    console.error('未获取到审批定义：', resp.msg);
    process.exit(1);
  }

  console.log(`\n审批名称：${data.approval_name}    状态：${data.status}`);
  console.log(`approval_code：${approvalCode}\n`);

  let widgets: any[] = [];
  try {
    widgets = JSON.parse(data.form || '[]');
  } catch {
    console.error('解析 form 失败，原始内容：\n', data.form);
    process.exit(1);
  }

  console.log('表单控件（widgetId → 名称 [类型]）：');
  console.log('-'.repeat(64));
  for (const w of widgets) printWidget(w);
  console.log('-'.repeat(64));
  console.log('\n将上面的 widgetId 填入 config/field-mapping.json 对应字段的 widgetId。\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
