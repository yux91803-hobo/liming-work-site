const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { tmpDir } = require('./helpers/tmp.cjs');
process.env.XIN_HOME = tmpDir('xin-rea-unit-');
const load = () => import(pathToFileURL(path.join(__dirname, '../site/xin/vm-persona.mjs')).href);

test('REA 只转换字符串路径的 allOf 广告约束，字段和其它 schema 保持，原定义不变', async () => {
  const { reaInputSchema } = await load();
  const schema = { type: 'object', properties: {
    expected_server_path: { type: 'string', minLength: 1, allOf: [{ pattern: '^[^\\x00]*$' }, { pattern: '^[^\\uD800-\\uDFFF]*$' }, { pattern: '^\\/' }] },
    allOf: { type: 'string' }, nested: { type: 'array', items: { type: 'object', properties: { pattern: { type: 'string', allOf: [{ pattern: '^/' }] } } } },
    union: { anyOf: [{ type: 'string', allOf: [{ pattern: '^/' }] }, { type: 'null' }] },
    intersection: { allOf: [{ type: 'object', properties: { keep: { type: 'string' } } }] }
  }, required: ['expected_server_path'], additionalProperties: false };
  const original = structuredClone(schema), result = reaInputSchema(schema);
  assert.deepEqual(schema, original);
  assert.deepEqual(result.properties.expected_server_path, { type: 'string', minLength: 1 });
  assert.deepEqual(result.properties.allOf, { type: 'string' });
  assert.equal(result.properties.nested.items.properties.pattern.allOf, undefined);
  assert.deepEqual(result.properties.union.anyOf, [{ type: 'string' }, { type: 'null' }]);
  assert.deepEqual(result.properties.intersection, schema.properties.intersection);
  assert.deepEqual(result.required, ['expected_server_path']);
  assert.equal(result.additionalProperties, false);
});

test('REA MCP 桥完整保留工具、分页和通知，只改 tools/list；实际调用由原服务校验，关闭时回收子进程', async t => {
  const { REA_MCP_BRIDGE } = await load(), root = tmpDir('xin-rea-bridge-'), server = path.join(root, 'rea');
  fs.writeFileSync(server, '#!' + process.execPath + '\n' + `
const {createInterface}=require('node:readline');
console.log(JSON.stringify({jsonrpc:'2.0',method:'notifications/message',params:{data:{allOf:'unchanged'},pid:process.pid}}));
const reply=(id,result)=>console.log(JSON.stringify({jsonrpc:'2.0',id,result}));
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')reply(m.id,{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}});
 if(m.method==='tools/list')reply(m.id,{tools:[{name:'binary_session',inputSchema:{type:'object',properties:{path:{type:'string',allOf:[{pattern:'^/'}]}},required:['path'],additionalProperties:false}},{name:'other',inputSchema:{type:'object',properties:{}}}],nextCursor:'page-2'});
 if(m.method==='tools/call'){
  const valid=String(m.params.arguments.path).startsWith('/');
  reply(m.id,{content:[{type:'text',text:JSON.stringify(m.params)}],isError:!valid});
 }
});
`, { mode: 0o755 });
  const child = spawn(process.execPath, ['-e', REA_MCP_BRIDGE, server], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  const pending = new Map(), notices = []; let seq = 0;
  createInterface({ input: child.stdout }).on('line', line => {
    const m = JSON.parse(line), done = pending.get(m.id);
    if (done) { pending.delete(m.id); done(m); } else notices.push(m);
  });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq, timer = setTimeout(() => reject(Error('MCP fixture timed out')), 5000);
    pending.set(id, m => { clearTimeout(timer); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  assert.equal((await request('initialize')).result.serverInfo.name, 'fixture');
  const list = await request('tools/list');
  assert.deepEqual(list.result.tools.map(t => t.name), ['binary_session', 'other']);
  assert.equal(list.result.nextCursor, 'page-2');
  assert.equal(list.result.tools[0].inputSchema.properties.path.allOf, undefined);
  assert.deepEqual(notices[0].params.data, { allOf: 'unchanged' });
  for (const path of ['/allowed', 'invalid']) {
    const params = { name: 'binary_session', arguments: { path, allOf: 'user argument' } };
    const result = (await request('tools/call', params)).result;
    assert.deepEqual(JSON.parse(result.content[0].text), params);
    assert.equal(result.isError, path === 'invalid');
  }
  const exit = new Promise(resolve => child.once('exit', resolve));
  child.stdin.end();
  assert.equal(await exit, 0);
  assert.throws(() => process.kill(notices[0].params.pid, 0), { code: 'ESRCH' });
});

test('REA 子进程忽略 EOF 或 TERM 时，兼容桥仍在期限内关闭并回收它', { timeout: 15000 }, async t => {
  const { REA_MCP_BRIDGE } = await load(), root = tmpDir('xin-rea-stuck-'), server = path.join(root, 'rea');
  fs.writeFileSync(server, '#!' + process.execPath + '\n' + `
console.log(JSON.stringify({jsonrpc:'2.0',method:'notifications/message',params:{pid:process.pid}}));
process.stdin.resume();process.on('SIGTERM',()=>{});setInterval(()=>{},1000);
`, { mode: 0o755 });
  for (const mode of ['eof', 'term']) {
    const child = spawn(process.execPath, ['-e', REA_MCP_BRIDGE, server], { stdio: ['pipe', 'pipe', 'pipe'] });
    let pid;
    t.after(() => { child.kill('SIGKILL'); if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} } });
    const lines = createInterface({ input: child.stdout });
    pid = await new Promise(resolve => lines.once('line', line => resolve(JSON.parse(line).params.pid)));
    const exit = new Promise(resolve => child.once('exit', resolve));
    if (mode === 'eof') child.stdin.end(); else child.kill('SIGTERM');
    assert.equal(await exit, 1);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    pid = undefined;
  }
});
