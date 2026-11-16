// The directory identifies a producer; the controller owns both effects and receipts.
import { scopedBridgeWorkspace } from './vm-task-bridge.mjs';

export function taskBridgeSession(session, meta) {
  return meta?.bridgeProtocol !== undefined && meta.bridgeProtocol !== 0
    ? { ...session, workspace: scopedBridgeWorkspace(session?.workspace, meta) } : session;
}

export function createTaskBridgeHandler({ loadRun, loadTask, isTask, lastRun, remember, ask }) {
  return a => {
    if (!a || !['remember','ask'].includes(a.op) || typeof a.text !== 'string' || !a.text.trim() || a.text.length > 1000)
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
    const r = ask({ sid: m.sid, question: a.text });
    return { sid: m.sid, text: r.error ? r.msg : '已记下问题，请结束本轮，等待用户回复。' };
  };
}

export function drainTaskReports(workspace, meta, { drain, submit, remember, ask }) {
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
    return '不支持这个操作';
  });
}
