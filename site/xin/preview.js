(function(){
  'use strict';
  var id=new URLSearchParams(location.search).get('id')||'',status=document.getElementById('status'),frame=document.getElementById('frame'),reload=document.getElementById('reload'),download=document.getElementById('download'),generation=0;
  function note(text){status.textContent=text;status.hidden=false;}
  // 返回（站长 2026-11-19：手机上点了作品链接再返回，回到了工具箱首页的小窗，原来在全屏工作台）：
  // 手机主屏幕上的网页应用没有标签页，作品链接就在原窗口打开——有上一页就后退，原来那页照原样（全屏工作台的 #xin-work 还在）；
  // 电脑上新标签页里单独开的（只有这一页）就关掉它，回到原来那页；关不掉再照链接去全屏工作台。
  // 参考 Next.js router.back() 配兜底的常见做法；只剩一页的标签页可以被脚本关掉（HTML 规范 script-closable）。
  var back=document.getElementById('back');
  if(back)back.addEventListener('click',function(e){
    if(e.button||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;   // 想在新标签里打开：照链接
    e.preventDefault();
    if(history.length>1){history.back();return;}
    window.close();
    setTimeout(function(){location.href=back.href;},300);
  });
  async function load(){
    var mine=++generation;frame.hidden=true;download.hidden=true;
    if(!/^[a-f0-9]{32}$/.test(id)){note('这个预览地址不完整。请回到小芯聊天，打开作品里的预览链接。');return;}
    reload.disabled=true;var url='/api/xin/preview/'+id+'/index.html';
    try{
      for(var attempt=0;attempt<30;attempt++){
        note(attempt?'小芯的电脑正在准备作品，稍等一会儿…':'正在打开作品…');
        var r=await fetch(url,{credentials:'same-origin'});if(mine!==generation)return;
        if(r.ok){var policy=r.headers.get('Content-Security-Policy')||'';if(!policy.includes("connect-src 'none'")||!policy.includes('sandbox allow-scripts'))throw Error('预览配置尚未准备好，请重新加载。');var html=await r.text();if(mine!==generation)return;var doc=new DOMParser().parseFromString(html,'text/html'),title=doc.title||'小芯的作品';document.getElementById('title').textContent=title;document.title=title+' · 小芯';frame.srcdoc='<!doctype html><meta http-equiv="Content-Security-Policy" content="'+policy.replace(/^sandbox[^;]*;\s*/,'').replace(/"/g,'&quot;')+'">'+html;frame.hidden=false;status.hidden=true;download.href=url+'?download=1';download.hidden=false;return;}
        var d=await r.json();if(mine!==generation)return;
        if(r.status===401){status.textContent='请先';var link=document.createElement('a');link.href='/#xin';link.target='_blank';link.rel='noopener';link.textContent='打开小芯聊天登录';status.appendChild(link);status.appendChild(document.createTextNode('，然后回来点“重新加载”。'));return;}
        if(d.state==='waking'||d.state==='busy'||d.state==='cooldown'){var seconds=Math.max(2,Math.min(60,Number(d.retryAfter)||3));note(d.state==='cooldown'?'小芯的电脑正在冷却，恢复后会继续打开作品。':'小芯的电脑正在准备作品，稍等一会儿…');await new Promise(ok=>setTimeout(ok,seconds*1000));if(mine!==generation)return;continue;}
        throw Error(d.msg||'作品暂时未能打开，请稍后重试。');
      }
      note('作品还在准备中。稍后可以点“重新加载”，也可以回到聊天询问进度。');
    }catch(e){if(mine===generation)note(e.message||'网络暂时没接上，请重试。');}finally{if(mine===generation)reload.disabled=false;}
  }
  reload.addEventListener('click',load);load();
})();
