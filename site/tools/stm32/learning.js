/* Only explicit study actions are reported. No import of local history, no model-generated answers. */
(function(){
 'use strict';
 var STM=window.STM=window.STM||{},queue=[],timer=0,auth=null,pending=false;
 function owner(){try{var c=(window.parent.LimingXinChat||window.LimingXinChat);return c&&c.state;}catch(e){return null;}}
 function enabled(){var s=owner();try{return (!s||s.authed)&&(!s||(s.sessAgent||s.agent)==='codex')&&localStorage.getItem('lm.xin.learning')!=='0';}catch(e){return false;}}
 function post(op,args){return fetch('/api/xin/call',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Xin':'1'},body:JSON.stringify({op:op,args:args})}).then(function(r){if(!r.ok)throw Error('unavailable');return r.json();}).then(function(d){if(!d.ok||d.data&&d.data.error)throw Error('unavailable');return d.data;});}
 function flush(){
  timer=0;if(pending||!queue.length)return;if(!enabled()){queue=[];return;}
  var s=owner(),batch=queue.splice(0,5);pending=true;
  var login=s?Promise.resolve(s.authed):auth===null?fetch('/api/xin/me',{credentials:'same-origin'}).then(function(r){return r.json();}).then(function(d){auth=!!d.authed;return auth;}):Promise.resolve(auth);
  login.then(function(ok){if(!ok)return;return post('memory_preferences',{}).then(function(prefs){if(prefs.learning===false){try{localStorage.setItem('lm.xin.learning','0');}catch(e){}queue=[];return;}return post('learning_report',{agent:'codex',sid:s&&s.sid||'',events:batch});});}).catch(function(){}).then(function(){pending=false;if(queue.length)timer=setTimeout(flush,15000);});
 }
 function record(e){
  if(!enabled())return;
  if(!/^(gpio|exti|usart|i2c|tim|dma|adc|spi)$/.test(e.topic||''))return;
  e.id=crypto.randomUUID();e.at=Date.now();queue.push(e);if(queue.length>30)queue.shift();if(!timer)timer=setTimeout(flush,15000);
 }
 var viewTimer=0;
 STM.learning={record:record,assisted:function(topic,exercise,mark){var key='lm.study.help.'+new Date(Date.now()+8*3600e3).toISOString().slice(0,10)+'.'+topic+'.'+exercise;try{if(mark)localStorage.setItem(key,'1');return localStorage.getItem(key)==='1';}catch(e){return !!mark;}},view:function(route){clearTimeout(viewTimer);if(!route||!route.t)return;var r=Object.assign({},route);
  viewTimer=setTimeout(function(){if(!document.hidden)record({topic:r.t,exercise:r.s||r.fn||r.sec||r.v||'page',step:r.s||'',kind:'view',answer:'',correct:null,independent:false});},20000);
 }};
 document.addEventListener('visibilitychange',function(){if(document.hidden)flush();});
})();
