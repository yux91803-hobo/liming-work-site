// Gemini image turns use the same non-executing native transport as the front.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {NativeACP,nativeChildOptions} from './vm-native-acp.mjs';

const actions=new Set(['shell','final','ask','remember']);
function parseAction(text){
 const s=String(text||'').trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/,'$1'),a=JSON.parse(s);
 if(!a||!actions.has(a.action)||typeof a.command!=='string'||typeof a.text!=='string'||Object.keys(a).some(k=>!['action','command','text'].includes(k))||Buffer.byteLength(a.command)>256*1024)throw Error('原生模型未返回有效的工作动作');
 return a;
}
export function nativeWorkerModel(session,expected){
 const models=session.models?.availableModels||[],opts=session.configOptions||[],high=opts.flatMap(o=>/effort|think|reason/i.test(String(o.id)+' '+String(o.name))?(o.options||[]).flatMap(v=>v.options||[v]).filter(v=>/^high$/i.test(String(v.value))||/^high$/i.test(String(v.name))).map(v=>({configId:o.id,value:v.value})):[])[0];
 const exact=models.find(m=>m.modelId===expected),flash=models.filter(m=>/gemini.*3[. -]8(?!\d).*flash/i.test(m.name||'')),target=exact||flash.find(m=>/\bhigh\b/i.test(m.name||''))||(high?flash[0]:null);
 if(expected!=='gemini-3.8-flash-high'||!target)throw Error('原生图片接口没有提供可核对的 Gemini 3.8 Flash High');
 return {model:expected,providerModel:target.modelId,high};
}
export function nativeWorkerImages(files=[]){
 return files.map(file=>{let fd;try{
  fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);const st=fs.fstatSync(fd);if(!st.isFile()||st.size>20*1024*1024)throw Error('图片文件无效或过大');
  const bytes=fs.readFileSync(fd),mime=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':bytes[0]===255&&bytes[1]===216?'image/jpeg':/^GIF8[79]a/.test(bytes.subarray(0,6).toString())?'image/gif':bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP'?'image/webp':null;
  if(!mime)throw Error('图片内容没有通过检查，未发送给模型');return {type:'image',mimeType:mime,data:bytes.toString('base64')};
 }finally{if(fd!==undefined)fs.closeSync(fd);}});
}
export async function openNativeWorker(o){
 const {binary,profile,signal}=o,cwd=profile.work,help=spawnSync(binary,['acp','--help'],{cwd,env:nativeChildOptions(cwd,profile.home).env,encoding:'utf8',timeout:10000,maxBuffer:2*1024*1024}),flags=String(help.stdout||'')+String(help.stderr||'');
 if(help.status!==0||!flags.includes('--app-data-dir'))throw Error('原生图片接口尚未准备好');
 const args=['acp','--app-data-dir','antigravity-cli','--agent','xin-confined-worker','--log-file','/dev/null'];
 if(flags.includes('--gemini-dir'))args.push('--gemini-dir','.gemini');
 if(flags.includes('--settings'))args.push('--settings',JSON.stringify(o.settings));
 // Stay in the existing worker session so crash recovery also reaps native descendants.
 const client=new NativeACP(binary,args,cwd,signal,null,profile.home,{detached:false});let id;
 try{
  const init=await client.request('initialize',{protocolVersion:1,clientInfo:{name:'xin-worker',version:'1'},clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false}},signal);
  if(init.agentCapabilities?.promptCapabilities?.image!==true)throw Error('原生模型接口没有图片能力，未发送图片提示');
  if(o.conversation&&init.agentCapabilities?.loadSession!==true)throw Error('原生图片接口无法恢复这项工作，进度已保留');
  const s=await client.request(o.conversation?'session/load':'session/new',{...(o.conversation?{sessionId:o.conversation}:{}),cwd,mcpServers:[]},signal);id=s.sessionId||o.conversation;if(!id)throw Error('原生模型没有创建有效会话');
  const chosen=nativeWorkerModel(s,o.model);if(s.models?.currentModelId!==chosen.providerModel)await client.request('session/set_model',{sessionId:id,modelId:chosen.providerModel},signal);
  if(chosen.high)await client.request('session/set_config_option',{sessionId:id,...chosen.high},signal);
  o.record?.(id,chosen);o.actual?.(chosen);
 }catch(e){client.close();throw e;}
 const ask=async blocks=>{client.text='';client.bytes=0;await client.request('session/prompt',{sessionId:id,prompt:blocks},signal,240000);return parseAction(client.text);};
 return {id,close(){client.close();},async propose(text,images=[],budget){
  if(images.some(i=>i.type!=='image'||!/^image\/(?:png|jpeg|gif|webp)$/.test(i.mimeType||'')||typeof i.data!=='string'||!/^[A-Za-z0-9+/=]+$/.test(i.data)))throw Error('图片没有成功交给原生模型');
  try{return await ask([{type:'text',text},...images]);}catch(e){
   if(signal?.aborted||e.code||!/JSON|工作动作/.test(e.message))throw e;
   if(!budget?.())throw Error('工作已达到推理预算，保留当前进度');budget.recordUsage?.(null);
   return ask([{type:'text',text:'只修正上一条工作动作的格式，不执行工具。必须作为助手文字输出严格 JSON：{"action":"shell|final|ask|remember","command":"完整命令或空字符串","text":"中文回复"}。不要代码围栏，不扩写任务，不重复已经执行的动作。'}]);
  }
 }};
}
