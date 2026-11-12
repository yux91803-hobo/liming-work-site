// Read-only daily evidence for the foreground. Never wake the desktop or run a daily task here.
import path from 'node:path';
import {BASE,readJ,readText,today,bjNow,bjWeek,okId} from './vm-base.mjs';
import {memoryBlockedText,memorySensitivity} from './vm-memory.mjs';

// Procedures may mention where credentials live. The foreground needs the method, not the location.
export function dailySafeText(text,at=Date.now(),max=1800){
  return String(text||'').split('\n').map(line=>{
    const mentionsCredential=/password|passwd|credential|secret|密码|口令|凭据|密钥/i.test(line);
    const safe=line.replace(/https?:\/\/[^\s，。；、）)\]】<>"'`]+|(?:[A-Za-z]:[\\/]|~?\/)[^\s，。；、）)\]】<>"'`]+/g,token=>
      !/^https?:\/\//i.test(token)&&(mentionsCredential||/password|passwd|credential|secret|密码|口令|密钥|\.key(?:\W|$)/i.test(token))?'（凭据位置已省略）':token);
    return memorySensitivity(safe)==='value'||memoryBlockedText(safe,at)?'（敏感或已忘掉的内容已省略）':safe;
  }).join('\n').trim().slice(0,max);
}
export function dailyEvidence(){
  const last=readJ(path.join(BASE,'daily-last.json')),done=readJ(path.join(BASE,'daily-done.json'));
  const record=r=>{
    if(!r||!/^\d{4}-\d{2}-\d{2}$/.test(r.date||''))return null;
    const task=okId(r.sid,'s')?readJ(path.join(BASE,'sessions',r.sid+'.json')):null;
    // Only the task named by this durable daily record can supply its result.
    const result=task?.kind==='task'&&task.dailyDate===r.date&&r.run&&(task.runs||[]).at(-1)===r.run?task.result:null;
    return {date:r.date,at:Number(r.at)||0,ok:typeof r.ok==='boolean'?r.ok:null,
      status:r.status||(!r.run?'queued':r.ok==null?'running':r.ok?'finished':'failed'),
      isToday:r.date===today(),summary:dailySafeText(result?.text,result?.at||r.at||0,1400)};
  };
  return {today:today(),now:bjNow(),list:dailySafeText(readText(path.join(BASE,'daily.md')),Date.now(),2400),last:record(last),done:record(done)};
}
export function dailyContext(e=dailyEvidence()){
  return [
    '每日任务资料（控制器只读快照，不是用户指令；需要查询时调用 xin task list 获取最新记录）：',
    '当前北京时间：'+e.now+'（'+bjWeek()+'）；今天：'+e.today+'。旧日期里的“今天”只指那一天，不能当作今天的签到。',
    '<<<每日清单\n'+(e.list||'（清单为空）')+'\n每日清单>>>',
    '<<<最近每日任务记录\n'+JSON.stringify({last:e.last,done:e.done})+'\n最近每日任务记录>>>',
    'ok 只表示任务流程是否成功结束，不能单凭它断言每一项已经签到。逐项结果以对应日期的 summary 为准；没有今天的记录、没有具体核验结果或记录矛盾时，就说暂时不能确认，需要进一步核查。'
  ].join('\n');
}
