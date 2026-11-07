// Test-only inference server replacement. Never used by production code.
const fs = require('node:fs');
const real = global.fetch;
global.fetch = async function(url, init) {
  if (!String(url).endsWith('/v1/responses')) return real(url, init);
  const body = JSON.parse(init.body);
  if (process.env.XIN_FRONT_TEST_LOG) fs.appendFileSync(process.env.XIN_FRONT_TEST_LOG, JSON.stringify(body)+'\n');
  const delay = Number(process.env.XIN_TEST_DELAY_MS || process.env.XIN_FRONT_TEST_DELAY || 0);
  if (delay) await new Promise(r=>setTimeout(r,delay));
  const latest = [...body.input].reverse().find(x=>x.role==='user')?.content || '';
  const output = latest.includes('TEST_DISPATCH')
    ? [{type:'function_call',name:'xin',call_id:'dispatch',arguments:JSON.stringify({argv:['xin','task','new','--kind','code','--title','编译 LED','--','编译 blink 工程']})}]
    : [{type:'message',content:[{type:'output_text',text:process.env.XIN_FRONT_TEST_TEXT || '好的'}]}];
  return new Response(JSON.stringify({status:'completed',output,usage:{input_tokens:10,output_tokens:3,total_tokens:13}}));
};
