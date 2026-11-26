// cloud_run 的原生工具卡（DSH Go 的 presentationMeta）：只读，不能有按钮和确认；≤ 8 KiB，出错返回 {}，不让工具调用失败。
// toolCard() 照 ccch1mneyyy/dsh-go docs/plugins/quickstart.md 的 12 行写法（MIT）。
export function toolCard(build, maxBytes = 8 * 1024) {
  return (args, value) => {
    try {
      const text = JSON.stringify(build(args, value));
      if (text === undefined || Buffer.byteLength(text, 'utf8') > maxBytes) return {};
      return { 'dsh-go/view': JSON.parse(text) };
    } catch {
      return {};
    }
  };
}

export function receiptView(value) {
  if (!value || !value.ok) {
    return { type: 'stack', title: '没派出去', children: [{ type: 'callout', tone: 'warn', text: String(value && value.reason || '没派出去') }] };
  }
  const rows = [['任务', value.taskId], ['机器', value.machine]];
  if (value.project) rows.push(['项目', value.project]);
  const children = [
    { type: 'keyValue', items: rows },
    { type: 'text', tone: 'muted', text: String(value.reason || '') },
  ];
  if (value.warning) children.push({ type: 'callout', tone: 'warn', text: String(value.warning) });
  return { type: 'stack', title: `已交给 ${value.machine} · 任务 ${value.taskId}`, children };
}
