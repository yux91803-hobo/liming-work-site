// Test-only inference server replacement. Never used by production code.
const fs = require('node:fs');
// Existing gateway fixtures explicitly exercise the supported DeepSeek provider.
// Default Opus and actual quota switching are covered by xin-front-opus.test.cjs.
process.env.XIN_FRONT_PROVIDER='deepseek';
const real = global.fetch;
global.fetch = async function(url, init) {
  if (!String(url).endsWith('/v1/responses')) return real(url, init);
  const body = JSON.parse(init.body);
  if (process.env.XIN_FRONT_TEST_LOG) fs.appendFileSync(process.env.XIN_FRONT_TEST_LOG, JSON.stringify(body)+'\n');
  // 网关刚醒：这个文件在的时候到达的请求一直卡着（正式机实测第一个请求卡 124–126 秒），直到被取消
  if (process.env.XIN_FRONT_TEST_COLD && fs.existsSync(process.env.XIN_FRONT_TEST_COLD))
    await new Promise((_, no) => init.signal?.addEventListener('abort', () => no(new Error('aborted')), { once: true }));
  const delay = Number(process.env.XIN_TEST_DELAY_MS || process.env.XIN_FRONT_TEST_DELAY || 0);
  if (delay) await new Promise(r=>setTimeout(r,delay));
  const content = [...body.input].reverse().find(x=>x.role==='user')?.content || '';
  const latest = typeof content === 'string' ? content : content.filter(x=>x.type==='input_text').map(x=>x.text).join('\n');
  const output = latest.includes('TEST_DISPATCH')
    ? [{type:'function_call',name:'xin',call_id:'dispatch',arguments:JSON.stringify({argv:['xin','task','new','--kind','code','--title','编译 LED','--','编译 blink 工程']})}]
    : [{type:'message',content:[{type:'output_text',text:process.env.XIN_FRONT_TEST_TEXT || '好的'}]}];
  return new Response(JSON.stringify({status:'completed',output,usage:{input_tokens:10,output_tokens:3,total_tokens:13}}));
};
