// The directory identifies a producer; the controller owns both effects and receipts.
import { scopedBridgeWorkspace } from './vm-task-bridge.mjs';
import path from 'node:path';
import * as runtime from './vm-runtime.mjs';
import { BASE, journal, readJ, processGroupMembers, cut } from './vm-base.mjs';
import { retryDelays, RETRY_TEXT } from './vm-retry.mjs';
import { hasFinalization, attemptError, finalizationEvidence } from './vm-run-attempt.mjs';
import { withCallContext } from './vm-kernel-context.mjs';
import { inputDigest } from './vm-state.mjs';
import { appSteerReceipt } from './vm-steer.mjs';

export function taskBridgeSession(session, meta) {
  if (meta?.bridgeProtocol === undefined || meta.bridgeProtocol === 0) return session;
  const workspace = scopedBridgeWorkspace(session?.workspace, meta);
  runtime.installTaskBridge(workspace);
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

const RESUME_TEXT = '（刚才电脑暂停或重启，这一轮中途断了。先检查现在的状态——看看文件、编译结果、还在不在跑的进程——已经做过的有副作用的事别再做一遍，然后接着把任务做完。）';

function taskFileResult(t, meta, finalization) {
  try {
    if (t.web && (!meta.webCheck?.trusted || !meta.webCheck.ok)) {
      const error = '网页尚未通过实际浏览器检查：' + (meta.webCheck?.error || '缺少检查记录') + '。请修好自包含 HTML 和 xin-web.json 后结束，控制器会重新检查。';
      return (t.webRetries || 0) < 2 ? { retry:'web', error } : { error };
    }
    const plan = runtime.publicationPlan(t, BASE);
    if (finalization && runtime.publicationInventory(plan) !== finalization.inventory)
      return { error:'项目副本在收尾期间发生变化，已暂停写回。' };
    const verification = runtime.validateTask(t, BASE, meta, plan);
    if (verification.error) return { ...(t.validationRetries ? {} : { retry:'validation' }), error:verification.error };
    const id = finalization?.id;
    const web = meta.webCheck, page = meta.pageCheck;
    const screenshot = path.join(t.workspace.tmp, 'xin-web-preview.png');
    // For a web deliverable the preview must validate before any new project write.
    let preview = id && t.web && !plan.deleted.length && !plan.conflicts.length ? runtime.publishWebPreview(t, BASE, { ...web, screenshot }, id) : undefined;
    const publication = runtime.publishWorkspace(t, BASE, null, finalization);
    if (publication.pending) preview = undefined;
    else if (t.web && !preview) preview = runtime.publishWebPreview(t, BASE, id ? {...web,screenshot} : web, id);
    else if (!t.web && page?.trusted && page.ok) {
      try { preview = runtime.publishPagePreview(t, BASE, id ? { ...page, screenshot } : page, id); }
      catch { /* The ordinary task result does not depend on a preview. */ }
    }
    return { verification, publication, preview };
  } catch (e) { return { error:finalization ? String(e.message).slice(0, 1000) : e.message }; }
}

export function createTaskFinisher({ sessF, metaF, isTask, lastRun, tailEvents, taskPush, isFinished,
  sessionUsage, cleanupFinishedTask, dailyDone, saveTask, enqueueNotice, scheduleNow }) {
  return function taskFinish(a, finalization) {
    const t = readJ(sessF(a.sid));
    // A late exit from a cancelled/replaced turn must never complete the new turn.
    if (!isTask(t) || lastRun(t) !== a.run || t.finishedRun === a.run || (t.status !== 'running' && t.status !== 'waiting' && t.status !== 'stopping')) return {};
    const evs = tailEvents(a.run, 65536);
    const runMeta = finalization?.meta || readJ(metaF(a.run), {});
    // Successful publication must never outlive a still-running producer.
    if(t.web&&runMeta.childPid&&processGroupMembers(runMeta.childPid,runMeta.childIdentity).length)return {error:'cleanup_pending'};
    if(t.web)t.processesCleaned=true;
    const actual=a.model||runMeta.model||t.actualModel||t.model;
    if(actual){t.model=t.actualModel=actual;t.actualModels=[...new Set((t.actualModels||[]).concat(actual))];}
    // 这一轮结束了，挂在它上面的问题不能再按 approval 回复（taskTell 会说「这一轮已经结束」）：超时、断了、停了的直接丢掉；
    // 正常结束的（到点锁忙、问题没记成 pendingQuestion）状态还是 waiting，下面照样停在「等你确认」，回复走普通的接着做
    delete t.approval;
    // 补充（docs/superpowers/specs/2026-11-17-xin-steer-design.md §2）：这一轮没送进去的带到下一轮，正常做完时它们让任务接着做；
    // 这一轮没正常做完（超时、断线、重启、停下、出错）的话，送进去了的也带上（held）：没法确定模型已经照着做了，下一轮开头再交一次
    const okEnd = !!a.ok && !a.stopped && !a.timeout && !a.died && !a.transient;
    const carry = (runMeta.steers || []).filter(x => x.state === 'pending' || x.state === 'next' || (!okEnd && x.state === 'accepted'));
    if (carry.length) t.inbox = (t.inbox || []).concat(carry.map(x => ({ id: x.id, text: x.text, at: x.at, ...(x.state === 'accepted' ? { held: true } : {}) })));
    const last = evs.filter(e => e.t === 'text').pop(), err = evs.filter(e => e.t === 'err').pop();
    let notify = null;
    if (t.status === 'stopping') { t.status = 'stopped'; t.endedAt = Date.now(); }                  // 进程真正退出后才释放目录
    else if ((t.status === 'waiting' || t.pendingQuestion) && !a.died && !a.timeout && !a.stopped && !a.uncertain) {
      t.status='waiting';t.question=t.pendingQuestion||t.question;delete t.pendingQuestion;
      Object.assign(t,{endedAt:Date.now(),frontSeen:false});notify=taskPush(t,(t.browserStep?'我这边需要你登录：':'我这边需要你确认：')+t.title,t.question);
    }
    else if (!a.stopped && !a.timeout && !a.died && !a.uncertain && t.inbox && t.inbox.some(x => !x.held)) {       // 干活时用户补充了、模型还没拿到的话：接着做
      t.next = '用户在你干活时补充了：\n' + t.inbox.map(x => '- ' + x.text).join('\n') + '\n按补充的要求接着做（已经做对的不用重做）。';
      t.nextShow = t.inbox.map(x => x.text).join('\n');
      Object.assign(t, { inbox: [], status: 'queued', queuedAt: Date.now() });
    } else if (a.died) {                                                                              // 电脑重启、进程被杀
      if ((t.resumes || 0) < 1) Object.assign(t, { resumes: (t.resumes || 0) + 1, next: RESUME_TEXT, nextShow: '（中途断了，接着做）', status: 'queued', queuedAt: Date.now() });
      else {
        // 不是要站长拿主意的事，不停在「等你确认」：算没做成，站长回一句照样接着做
        const why = '这个任务中途断了两次（电脑暂停或重启），没做完。要接着做，回复一句就行。';
        Object.assign(t, { status: 'failed', question: '', result: { ok: false, text: why, err: '中途断了两次', at: Date.now() }, endedAt: Date.now(), frontSeen: false });
        notify = taskPush(t, '我没做成：' + t.title, why);
      }
    } else if (a.transient && !a.stopped && !a.timeout && (t.transientRetries || 0) < retryDelays().length) {   // 断线、网关暂时不可用：等一会儿用同一个会话接着做
      if (finalization?.probe) return { files:false, retry:'transient' };
      const n = (t.transientRetries || 0) + 1;
      Object.assign(t, { transientRetries: n, retryAt: Date.now() + retryDelays()[n - 1], next: RETRY_TEXT, nextShow: '（连接出错，稍后接着做）', status: 'queued', queuedAt: Date.now() });
    } else {
      let ok = !!a.ok && !a.stopped && !a.timeout;
      let publication = null;
      if (finalization?.probe) return { files:ok && !!t.workspace };
      if (ok && t.workspace) {
        const files = finalization ? finalization.files : taskFileResult(t, runMeta);
        if (!files) return { error:'finalization_files' };
        if (files.retry) {
          const web = files.retry === 'web', count = web ? 'webRetries' : 'validationRetries';
          t[count] = (t[count] || 0) + 1; t.status = 'queued'; t.next = files.error;
          if (web) t.stage = 'working';
          t.nextShow = web ? '（修正网页交互检查）' : '（补齐编译或检查证据）';
          t.finishedRun = a.run; saveTask(t); if (!finalization) scheduleNow(); return {};
        }
        if (files.error) { ok = false; t.publicationError = files.error; }
        if (files.verification?.applicable) t.verification = files.verification;
        if (files.preview) t.preview = files.preview;
        publication = files.publication;
      }
      t.status = a.stopped ? 'stopped' : ok ? 'done' : 'failed';
      if (t.status === 'done') { t.transientRetries = 0; t.retryAt = 0; }
      const answer = a.uncertain || ((last && last.text) || (a.timeout ? '超过 ' + t.minutes + ' 分钟还没做完，停下了。' : ok ? '做完了。' : '没做成。'));
      t.result = { ok, text: cut(t.workspace ? answer.split(t.workspace.work).join(t.dir) : answer, 8000),
        err: ok ? '' : String(a.uncertain || t.publicationError || (a.timeout ? '超时（' + t.minutes + ' 分钟）' : (err && err.text) || '')).slice(0, 600), at: Date.now() };
      if(t.web){t.result.internalText=t.result.text;t.result.internalError=t.result.err;t.result.err='';t.result.text=ok&&t.preview?.run===a.run?'我画好了，点下面的预览就能看。':a.stopped?'好，我停下了。':'这次还没完成，成品尚未通过检查。我保留了进度，可以继续处理。';}
      if (publication?.pending) {
        t.status = 'waiting'; t.publication = publication;
        t.question = '结果还未写回项目：' + (publication.deleted.length ? '将删除 ' + publication.deleted.length + ' 个原文件；' : '') +
          (publication.conflicts.length ? publication.conflicts.length + ' 个文件在任务期间被改过；' : '') + '批准这次写回吗？';
        t.result.ok = false;
      } else if (publication?.ok) t.publicationReceipt = publication;
      Object.assign(t, { endedAt: Date.now(), frontSeen: false });
      if(t.web&&ok&&t.preview?.ready)t.stage='ready';
      if (!a.stopped) notify = taskPush(t, (ok ? '我弄好了：' : '我没做成：') + t.title, t.result.text);
    }
    if (finalization?.probe) return { files:false };
    t.finishedRun = a.run;
    // 做完时记下用量：副本按保留期删掉以后，过程页照样显示这个任务用了多少
    if (isFinished(t)) { const fresh = finalization ? finalization.usage : sessionUsage({ ...t, usage: null }); if (fresh) t.usage = fresh; }
    if (finalization) {
      if (isFinished(t) && t.workspace && !a.uncertain) t.cleanupPending = a.run;
    } else cleanupFinishedTask(t);
    if (t.dailyDate && isFinished(t)) dailyDone(a.run, { sid: t.sid, dailyDate: t.dailyDate }, t.status === 'done');
    saveTask(t);
    const notice = notify&&t.delivery?.state!=='pending' ? enqueueNotice(t, notify) : null;
    if (!finalization) scheduleNow();
    return notice ? { notice, notify } : {};
  };
}

function checkRecord(check) {
  const {ok, error, digest, entry, viewports} = check;
  return { ok:!!ok, error:error && String(error).slice(0, 1200), digest, entry, viewports };
}

export function checkTaskResult(t, { active, emit, report, checking }) {
  if (!t?.workspace || t.pendingQuestion || t.approval || !active()) return;
  if (t.web) {
    checking();
    emit({t:'tool',id:'xin-web-check',name:'检查网页',detail:'实际打开电脑和手机预览，点击交互并检查页面错误'});
    let check; try { check=runtime.checkWebWorkspace(t); } catch (e) { check={ok:false,error:e.message}; }
    report({webCheck:{...check,trusted:true}});
    emit({t:'tool_end',id:'xin-web-check',name:'检查网页',ok:!!check.ok,out:check.error||'电脑和手机交互检查通过'});
  } else if (runtime.findPage(t)) {
    emit({t:'tool',id:'xin-page-check',name:'生成预览',detail:'在浏览器里打开这次做的页面'});
    let page; try { page=runtime.checkPageWorkspace(t); } catch (e) { page={ok:false,error:e.message}; }
    if (page) report({pageCheck:{...page,trusted:true}});
    emit({t:'tool_end',id:'xin-page-check',name:'生成预览',ok:!!page?.ok,out:page?.ok?'可以预览':page?.error||'没有可预览的页面'});
  }
  if (active() && runtime.stm32Task(t)) {
    emit({t:'tool',id:'xin-build',name:'编译核验',detail:'控制器在隔离副本执行受控构建，并检查本次新生成的固件产物'});
    let build; try { build=runtime.compileWorkspace(t); } catch (e) { build={ok:false,output:e.message}; }
    report({compileTrusted:true,compileOk:!!build?.ok,compileDigest:build?.digest});
    emit({t:'tool_end',id:'xin-build',name:'编译核验',detail:'受控构建 / '+(build?.artifacts||[]).join('、'),ok:!!build?.ok,out:build?.output||''});
  }
}

export function recordRunnerResult(store, meta, {ackedSteers, ...data}, getSession, reports) {
  journal.checkWriter();
  const prepared = store.write(meta, 'prepared', data, {flushEvents:true});
  // Keep the existing prepared and ready envelopes readable during a rollback.
  // An older owner can finish the result and carry unconfirmed input forward.
  if (ackedSteers?.length) store.write(meta, 'steer', {prepared:prepared.digest, claims:ackedSteers});
  reports.preparing();
  const ready = {prepared:prepared.digest};
  const t = getSession();
  if (meta.task && t && data.ok) {
    checkTaskResult(t, {...reports, report: ({webCheck, pageCheck, ...compile}) => {
      if (webCheck) ready.webCheck = checkRecord(webCheck);
      if (pageCheck) ready.pageCheck = checkRecord(pageCheck);
      Object.assign(ready, compile);
    }});
    if (t.workspace && reports.active()) {
      try { ready.workspace = runtime.publicationInventory(runtime.publicationPlan(t, BASE)); }
      catch { /* A missing/changed workspace is handled by the owner before publication. */ }
    }
  }
  journal.checkWriter();
  return store.write(meta, 'ready', ready);
}

const INCOMPLETE = {
  prepared:'模型已经结束，收尾检查中断了。已保留现场，请检查结果后决定是否继续。',
  partial:'收尾记录上次没有写完。已保留现场，请核对执行结果后再继续。',
  invalid:'收尾记录无法验证。已保留现场，请核对执行结果后再继续。'
};

function finalizeFiles(store, meta, ready, task, at) {
  const intent = store.read(meta, 'intent'), effects = store.read(meta, 'effects');
  if (intent.state === 'invalid' || effects.state === 'invalid' ||
      intent.state === 'valid' && (intent.data.ready !== ready.digest || intent.data.inventory !== ready.data.workspace) ||
      effects.state === 'valid' && effects.data.intent !== intent.digest)
    return { error:INCOMPLETE.invalid };
  if (effects.state === 'valid') return effects.data;
  if (!ready.data.workspace) return { error:'无法核对本轮项目副本，结果保留供检查。' };
  const plan = intent.state === 'valid' ? intent : store.write(meta, 'intent', {ready:ready.digest, inventory:ready.data.workspace});
  const id = inputDigest([meta.run, meta.attempt]).slice(0, 32);
  const result = taskFileResult(task, meta, {id, at, inventory:plan.data.inventory});
  return store.write(meta, 'effects', {...result, intent:plan.digest}).data;
}

export function createRunFinalizer({ store, loadRun, loadSession, taskFinish, emit, complete, rememberSession,
  patchRun, frontReply, frontNotice, dailyDone, statsFile, steerAck }) {
  return function finalizeRun(meta, { digest, evidence = finalizationEvidence(store, meta), abandon = false } = {}) {
    if (!hasFinalization(meta)) return { error:'finalization_protocol' };
    const {run, attempt, sid} = meta, context = { locked:true, key:meta.task?'tasks':sid, run, attempt };
    return withCallContext(context, () => {
      const current = loadRun(run), id = 'finish:' + run + ':' + attempt;
      const stale = attemptError(current, context);
      if (stale) return stale;
      const receipt = journal.commandReceipt(id);
      if (receipt) return !digest || receipt.digest === digest ? receipt.result : {error:'finalization_conflict'};
      if (current.ended) return { error:'finalization_ended' };
      if (!evidence?.ready && (!abandon || !evidence?.reason)) return { error:'finalization_not_ready' };
      if (digest && digest !== evidence.ready?.digest) return { error:'finalization_conflict' };
      const {ready, prepared, reason} = evidence;
      const data = prepared?.data;
      const interrupted = current.stopped && meta.task && store.read(current,'intent').state === 'valid';
      const uncertain = interrupted ? '写回期间收到停止，已保留项目和备份供核对。' : INCOMPLETE[reason];
      const reports = ready?.data || {};
      const {webCheck, pageCheck, compileTrusted, compileOk, compileDigest} = reports;
      const changes = {modelDone:true, ...(data?.changes.frontUsage ? {frontUsage:data.changes.frontUsage} : {}),
        ...(webCheck ? {webCheck:{...webCheck,trusted:true}} : {}),
        ...(pageCheck ? {pageCheck:{...pageCheck,trusted:true}} : {}), ...(compileTrusted ? {compileTrusted,compileOk,compileDigest} : {})};
      const pending = (current.steers || []).filter(x => ['pending','next'].includes(x.state));
      const steerReceipt = !uncertain && pending.length ? store.read(current, 'steer') : null;
      const acked = steerReceipt?.state === 'valid' && steerReceipt.data.prepared === prepared?.digest ? new Set(steerReceipt.data.claims) : null;
      const acceptedIds = new Set(acked ? pending.filter(x => typeof x.id === 'string' && acked.has(appSteerReceipt(x.id))).map(x => x.id) : []);
      const steers = acked?.size ? current.steers.map(x => ['pending','next'].includes(x.state) && (acceptedIds.has(x.id) || acked.has(x.claim?.id) && x.claim.attempt === attempt)
        ? { ...x, state: 'accepted', acceptedAt: x.acceptedAt || data.at } : x) : current.steers;
      const runMeta = {...current, ...changes, ...(steers ? {steers} : {})};
      const task = loadSession(sid);
      const result = {sid, run, ok:!uncertain && !!data?.ok && !current.stopped, stopped:!!current.stopped,
        timeout:!!data?.timeout, transient:!uncertain && !!data?.transient, model:data?.model, uncertain};
      let files, retry;
      journal.checkWriter();
      if (meta.task) {
        if (current.childPid && processGroupMembers(current.childPid,current.childIdentity).length) return { error:'cleanup_pending' };
        const probe = taskFinish(result, {meta:runMeta, probe:true});
        if (probe.error) return probe;
        retry = probe.retry;
        if (probe.files) files = finalizeFiles(store, runMeta, ready, task, data.at);
      }
      const command = {id, digest:ready?.digest || inputDigest([id, reason])};
      return journal.atomic(() => {
        if (data) rememberSession(sid, data.changes);
        for (const id of acceptedIds) steerAck?.({ run, id, state: 'accepted' });
        if (acked?.size) for (const claim of acked) steerAck?.({ run, claim, state: 'accepted' });
        patchRun(run, changes);
        if (uncertain) emit(run, {t:'err',text:uncertain});
        if (data?.reply && !uncertain) frontReply({run,text:data.reply});
        const done = { t:'done', code:data?.code ?? -1, ms:data?.ms ?? Math.max(0, Date.now()-current.started),
          ok:result.ok && !files?.error && !files?.publication?.pending, stopped:result.stopped, usage:data?.usage ?? null,
          cost:data?.cost, effort:current.effort||'', ...(retry ? {retry} : {}), ...(data?.model && current.agent!=='claude' ? {model:data.model,
            why:current.why, from:data.from, providerModel:data.providerModel} : {}), ...(current.plan ? {plan:true} : {}) };   // 天启的计划轮次：网页据此放计划卡片
        if (data?.recordStats) journal.append(statsFile(), {at:data.at, run, agent:current.agent, model:data.model||'',
          kind:current.routeKind||current.kind||'chat', why:current.why||'', ms:done.ms, from:data.from, fromErr:current.fromErr,
          usage:data.delta, ok:done.ok, stopped:done.stopped});
        const completed = complete({run, done, durable:true, uncertain});
        if (completed.error) return completed;
        if (meta.task) {
          const finished = taskFinish(result, {meta:{...loadRun(run), ...changes}, files, usage:done.usage});
          if (finished.error) return finished;
        } else if (current.kind === 'daily') dailyDone(run, current, done.ok);
        else if (!done.stopped && !['handoff','note'].includes(current.kind)) frontNotice(current, done, data?.reply || uncertain);
        return {ok:true, sid, run, attempt, digest:command.digest, done:completed.done};
      }, command);
    });
  };
}
