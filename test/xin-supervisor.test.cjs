const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
test('监督器忽略旧的空闲消息，最后一个任务结束后撤掉 alarm', async t => {
  const {XinTaskSupervisor}=await import(pathToFileURL(path.join(__dirname,'../src/xin.js')).href);
  const values=new Map(); let alarm=null; const requests=[];
  const state={storage:{get:async k=>values.get(k),put:async(k,v)=>values.set(k,v),setAlarm:async v=>alarm=v,deleteAlarm:async()=>alarm=null},waitUntil:()=>{}};
  const real=global.fetch; global.fetch=async(url,init)=>{requests.push({url,method:init.method});return new Response('{}');}; t.after(()=>global.fetch=real);
  const obj=new XinTaskSupervisor(state,{INSTABOX_API_KEY:'fake-only'});
  const post=s=>obj.fetch(new Request('https://xin.internal/state',{method:'POST',body:JSON.stringify(s)}));
  await post({bg:2,version:2,machine:'m_test',observedAt:20}); assert.ok(alarm>Date.now());
  await post({bg:0,version:1,machine:'m_test',observedAt:10}); assert.equal(values.get('tasks').bg,2); assert.ok(alarm);
  await post({bg:0,version:3,machine:'m_test',observedAt:30}); assert.equal(alarm,null);
  assert.equal(requests.at(-1).method,'DELETE'); assert.match(requests.at(-1).url,/activity-leases/);
});

