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


test('任务完成时撤租约失败会保留 alarm，重试成功后才完全空闲',async t=>{
  const {XinTaskSupervisor}=await import(pathToFileURL(path.join(__dirname,'../src/xin.js')).href);
  const values=new Map();let alarm=null,attempts=0;
  const state={storage:{get:async k=>values.get(k),put:async(k,v)=>values.set(k,v),setAlarm:async v=>alarm=v,deleteAlarm:async()=>alarm=null}};
  const real=global.fetch;global.fetch=async()=>new Response('{}',{status:++attempts===1?503:200});t.after(()=>global.fetch=real);
  const obj=new XinTaskSupervisor(state,{INSTABOX_API_KEY:'fake-only'});
  await obj.fetch(new Request('https://xin.internal/state',{method:'POST',body:JSON.stringify({bg:0,version:1,machine:'m_test'})}));
  assert.equal(values.get('tasks').leaseCleanup,true);assert.ok(alarm>Date.now());
  await obj.alarm();assert.equal(attempts,2);assert.equal(values.get('tasks').leaseCleanup,false);assert.equal(alarm,null);
});

test('平台冷却期间不唤醒，alarm 等待冷却截止后再恢复',async t=>{
  const {XinTaskSupervisor}=await import(pathToFileURL(path.join(__dirname,'../src/xin.js')).href);
  const until=Date.now()+180000,values=new Map([['tasks',{bg:1,version:2,machine:'m_test'}]]);let alarm=0,hits=0;
  const state={storage:{get:async k=>values.get(k),put:async(k,v)=>values.set(k,v),setAlarm:async v=>alarm=v,deleteAlarm:async()=>{}}};
  const real=global.fetch;global.fetch=async()=>{hits++;return new Response(JSON.stringify({state:'suspended',cooldownUntil:new Date(until).toISOString()}));};t.after(()=>global.fetch=real);
  await new XinTaskSupervisor(state,{INSTABOX_API_KEY:'fake-only'}).alarm();
  assert.equal(hits,1);assert.ok(alarm>=until+5000);
});
