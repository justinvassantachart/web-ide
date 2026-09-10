import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import path from 'node:path';
export async function runNativeLifecycle({url, executablePath}) {
const profile=await mkdtemp(path.join(tmpdir(),'shared-native-browser-'));
const browserProcess=spawn(executablePath,['--remote-debugging-port=0','--remote-debugging-address=127.0.0.1',`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','about:blank'],{stdio:'ignore'});
let ws;const events=[],waiters=new Map();let sequence=0;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
try{
 let lines;for(let i=0;i<100;i++){try{lines=(await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).trim().split('\n');break}catch{await pause(50)}}
 if(!lines)throw new Error('No DevTools port');ws=new WebSocket(`ws://127.0.0.1:${lines[0]}${lines[1]}`);await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true})});
 ws.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.id){const pending=waiters.get(m.id);waiters.delete(m.id);if(!pending)return;clearTimeout(pending.timer);if(m.error)pending.reject(new Error(m.error.message));else pending.resolve(m.result)}else {events.push(m);}});
 const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{waiters.delete(id);reject(new Error(`CDP ${method} timed out`))},10000);waiters.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}))});
 const {targetInfos}=await send('Target.getTargets');const target=targetInfos.find(t=>t.type==='page');const {sessionId}=await send('Target.attachToTarget',{targetId:target.targetId,flatten:true});const cmd=(method,params={})=>send(method,params,sessionId);
 const evaluate=async(expression,awaitPromise=false)=>{const result=await cmd('Runtime.evaluate',{expression,returnByValue:true,awaitPromise});if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
 await cmd('Page.enable');await cmd('Runtime.enable');await cmd('Runtime.addBinding',{name:'recordLifecycle'});await cmd('Page.navigate',{url});
 for(let i=0;i<300;i++){if(await evaluate('Boolean(window.viewer?.counts.editorCreates)'))break;await pause(50)}
 await evaluate(`(()=>{window.lifecycle=[];for(const event of ['visibilitychange','freeze','resume'])document.addEventListener(event,()=>{const value={event,state:document.visibilityState};window.lifecycle.push(value);recordLifecycle(JSON.stringify(value))});const e=window.viewer.editor();e.setSelection({startLineNumber:505,startColumn:90,endLineNumber:509,endColumn:135});e.setScrollPosition({scrollTop:11007,scrollLeft:700},1);})()`);
 const before=await evaluate('window.viewer.measure()');const initial=await evaluate('document.visibilityState');
 const other=await send('Target.createTarget',{url:'about:blank',newWindow:false,background:false});await send('Target.activateTarget',{targetId:other.targetId});
 let hidden;for(let i=0;i<40;i++){hidden=await evaluate('document.visibilityState');if(hidden==='hidden')break;await pause(50)}
 // Apply while genuinely hidden. The public API remains the only source input.
 await evaluate(`window.viewer.apply({...window.viewer.handle().workspace.snapshot(),'/workspace/a.py':'# insert\\n'+window.viewer.handle().workspace.snapshot()['/workspace/a.py']})`,true);
 await cmd('Page.setWebLifecycleState',{state:'frozen'});
 for(let i=0;i<40&&!events.some(e=>e.method==='Runtime.bindingCalled'&&JSON.parse(e.params.payload).event==='freeze');i++)await pause(50);
 const frozen=events.some(e=>e.method==='Runtime.bindingCalled'&&JSON.parse(e.params.payload).event==='freeze');
 await cmd('Page.setWebLifecycleState',{state:'active'});await send('Target.activateTarget',{targetId:target.targetId});
 let final;for(let i=0;i<40;i++){final=await evaluate('document.visibilityState');if(final==='visible')break;await pause(50)}
 await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',true);
 await evaluate(`window.viewer.apply({...window.viewer.handle().workspace.snapshot(),'/workspace/a.py': '# missed\\n'.repeat(19)+window.viewer.handle().workspace.snapshot()['/workspace/a.py']})`,true);
 await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',true);
 const after=await evaluate('window.viewer.measure()');const lifecycle=await evaluate('window.lifecycle');const result={initial,hidden,frozen,final,before,after,lifecycle};await send('Browser.close');return result;

}finally{for(const pending of waiters.values())clearTimeout(pending.timer);ws?.close();browserProcess.kill('SIGTERM');if(browserProcess.exitCode===null)await new Promise(resolve=>{const timer=setTimeout(()=>browserProcess.kill('SIGKILL'),3000);browserProcess.once('exit',()=>{clearTimeout(timer);resolve()})});await rm(profile,{recursive:true,force:true});}

}
