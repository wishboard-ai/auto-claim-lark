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
  console.log(`${indent}${id}  →  ${name}  [${type}]${w.required ? '  *必填' : ''}`);
  // 单选/多选/下拉的选项
  if (Array.isArray(w.option)) {
    for (const o of w.option) {
      if (o && typeof o === 'object' && 'value' in o) {
        console.log(`${indent}      选项: ${o.value}  =  ${o.text ?? ''}`);
      }
    }
  }
  // 明细控件组等的子控件
  const children = w.children ?? w.controls ?? [];
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

  let resp;
  try {
    resp = await client.approval.v4.approval.get({
      path: { approval_code: approvalCode },
      params: { locale: 'zh-CN' },
    });
  } catch (e: any) {
    const data = e?.response?.data;
    if (data?.code === 1390002) {
      console.error(`\n[错误] 审批定义未找到（approval code not found）`);
      console.error(`  你填的 approval_code = ${approvalCode}`);
      console.error('  常见原因：');
      console.error('   1) approval_code 填错了（这不是审批的正确 code）；');
      console.error('   2) 该审批未授权给本应用，或不在本企业内。');
      console.error('  获取正确 approval_code：');
      console.error('   飞书「审批」->「审批管理后台」-> 打开「费用报销」审批的编辑/详情页，');
      console.error('   浏览器地址栏 URL 中 definitionCode= 后面的那串值即为 approval_code。\n');
    } else {
      console.error(`\n[错误] 请求失败 http=${e?.response?.status} code=${data?.code} msg=${data?.msg}\n`);
    }
    process.exit(1);
  }

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
  const data = e?.response?.data;
  if (data?.code) {
    console.error(`[错误] code=${data.code} msg=${data.msg}`);
  } else {
    console.error('[错误]', e?.message || e);
  }
  process.exit(1);
});
