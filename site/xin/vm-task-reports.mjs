// The directory identifies a producer; the controller owns both effects and receipts.
import { scopedBridgeWorkspace } from './vm-task-bridge.mjs';
import { installTaskBridge } from './vm-runtime.mjs';

export function taskBridgeSession(session, meta) {
  if (meta?.bridgeProtocol === undefined || meta.bridgeProtocol === 0) return session;
  const workspace = scopedBridgeWorkspace(session?.workspace, meta);
  installTaskBridge(workspace);
  return { ...session, workspace };
}

export function createTaskBridgeHandler({ loadRun, loadTask, isTask, lastRun, remember, ask, note }) {
  return a => {
    if (!a || !['remember','ask','note'].includes(a.op) || typeof a.text !== 'string' || !a.text.trim() || a.text.length > 1000)
      return {error:'bad_bridge_request',msg:'不认识的任务请求'};
    const m = loadRun(a.run), t = m && loadTask(m.sid);
    if (!m?.task || m.bridgeProtocol !== 1 || !isTask(t) || !t.workspace || a.sid !== m.sid || lastRun(t) !== a.run)
      return { error: 'bridge_ended', msg: '这次运行已结束，请求未应用' };
    if (m.ended || m.stopped || m.died || t.finishedRun === a.run || !['running', 'waiting'].includes(t.status))
      return { error: 'bridge_ended', msg: '这次运行已结束，请求未应用' };
    if (a.op === 'remember') {
      const r = remember({ content: a.text, source: 'worker', evidence: { sid: m.sid, run: m.run } });
      return { sid: m.sid, text: r.error ? r.msg : '已记成待确认的项目记录：' + r.item.content };
    }
    // 主动回原聊天说一句（docs/superpowers/specs/2026-11-17-xin-steer-design.md §4）：请求编号就是去重编号
    if (a.op === 'note') { const r = note({ sid: m.sid, run: a.run, id: 'b' + a.id, text: a.text }); return { sid: m.sid, text: r.msg || r.error }; }
    const r = ask({ sid: m.sid, question: a.text });
    return { sid: m.sid, text: r.error ? r.msg : '已记下问题，请结束本轮，等待用户回复。' };
  };
}

export function drainTaskReports(workspace, meta, { drain, submit, remember, ask, note }) {
  drain(workspace, (a, request) => {
    if (!a || typeof a !== 'object' || Array.isArray(a)) return '不认识的任务请求';
    if (meta.bridgeProtocol === 1) {
      const r = submit({ sid: meta.sid, run: meta.run, id: request.id, op: a.op, text: a.text });
      if (!r.error) return r.text;
      if (['stale_attempt', 'bridge_ended', 'bad_bridge_request', 'message_conflict'].includes(r.error)) return r.msg;
      throw Object.assign(new Error('状态进程暂时无法确认此请求'), { code: r.error });
    }
    if (a.op === 'remember') {
      const r = remember({ content: a.text, source: 'worker', evidence: { sid: meta.sid, run: meta.run } });
      return r.error ? r.msg : '已记成待确认的项目记录：' + r.item.content;
    }
    if (a.op === 'ask') { const r = ask({ sid: meta.sid, question: a.text }); return r.error ? r.msg : '已记下问题，请结束本轮，等待用户回复。'; }
    if (a.op === 'note' && note) { const r = note({ sid: meta.sid, run: meta.run, id: 'b' + request.id, text: a.text }); return r.msg || r.error || '已记下'; }
    return '不支持这个操作';
  });
}
