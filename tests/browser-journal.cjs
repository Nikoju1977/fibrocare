'use strict';
/* FibroCare Chromium integration: synthetic records and real Web Crypto/PDF. Harness adapted from NikoAssist and OpenVita, Studio Niko Design. */
// SPDX-License-Identifier: GPL-3.0-or-later
const assert=require('node:assert/strict');
const {spawn,execFileSync}=require('node:child_process');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const port=19488,base='http://127.0.0.1:'+port;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function poll(fn,label,timeout=20000){
 const start=Date.now();let error;
 while(Date.now()-start<timeout){
  try{const result=await fn();if(result)return result;}catch(e){error=e;}
  await sleep(120);
 }
 throw new Error('Timeout '+label+(error?': '+error.message:''));
}
function chromeBinary(){
 if(process.env.CHROME_BIN)return process.env.CHROME_BIN;
 for(const candidate of ['google-chrome','google-chrome-stable','chromium','chromium-browser']){
  try{return execFileSync('which',[candidate],{encoding:'utf8'}).trim();}catch{}
 }
 throw Error('Chromium non disponible sur ce runner.');
}
async function main(){
 let server,chrome,ws;const pending=new Map(),browserErrors=[],httpPosts=[];
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'fibrocare-browser-'));
 let seq=0,diagnostics='';
 try{
  server=spawn('python3',['-m','http.server',String(port),'--bind','127.0.0.1','--directory','.'],{
   cwd:root,stdio:['ignore','ignore','pipe']
  });
  server.stderr.on('data',chunk=>diagnostics+=String(chunk).slice(-1000));
  await poll(async()=>{const r=await fetch(base+'/');return r.status===200},'local web server');
  chrome=spawn(chromeBinary(),['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',
   '--no-first-run','--no-default-browser-check','--disable-background-networking',
   '--remote-debugging-port=0','--remote-allow-origins=*',
   '--user-data-dir='+path.join(tmp,'chrome'),'about:blank'],{stdio:['ignore','ignore','pipe']});
  chrome.stderr.on('data',chunk=>diagnostics+=String(chunk).slice(-1000));
  const debuggerPort=await poll(async()=>{
   const raw=await fs.readFile(path.join(tmp,'chrome','DevToolsActivePort'),'utf8');
   return Number(raw.split('\n')[0]);
  },'Chrome DevTools');
  const tabs=await(await fetch('http://127.0.0.1:'+debuggerPort+'/json/list')).json();
  const tab=tabs.find(x=>x.type==='page');
  assert.ok(tab?.webSocketDebuggerUrl,'Chrome debugger page missing');
  ws=new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{
   ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});
  });
  ws.addEventListener('message',event=>{
   const msg=JSON.parse(event.data);
   if(msg.method==='Runtime.exceptionThrown')browserErrors.push(msg.params?.exceptionDetails?.exception?.description||'Browser exception');
   if(msg.method==='Network.requestWillBeSent'&&msg.params?.request?.method==='POST')httpPosts.push(msg.params.request.url);
   if(!msg.id||!pending.has(msg.id))return;
   const p=pending.get(msg.id);pending.delete(msg.id);
   msg.error?p.reject(Error(JSON.stringify(msg.error))):p.resolve(msg.result);
  });
  function call(method,params={}){
   const id=++seq;
   return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(id);reject(Error('DevTools timeout '+method));},12000);
    pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});
    ws.send(JSON.stringify({id,method,params}));
   });
  }
  async function evaluate(expression){
   const out=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
   if(out.exceptionDetails)throw Error('Browser JS: '+(out.exceptionDetails.exception?.description||out.exceptionDetails.text));
   return out.result?.value;
  }
  const wait=(expression,label)=>poll(()=>evaluate(expression),label,15000);
  await call('Page.enable');await call('Runtime.enable');await call('Network.enable');
  await call('Page.navigate',{url:base+'/'});
  const pass='fibrocare-synthetic-test-only', wrong='wrong-fibrocare-test-only';
  const keys=['symptoms','meds','appts','docs','posts'];
  const expr=(fn,...args)=>'('+fn.toString()+')('+args.map(x=>JSON.stringify(x)).join(',')+')';
  const perform=(fn,...args)=>evaluate(expr(fn,...args));
  const ready=()=>wait('document.readyState==="complete"&&document.querySelectorAll(".pain-btn").length===11','FibroCare initialized');
  const idle=()=>wait('!backupBusy','backup operation finished');
  const snapshot=()=>perform(keys=>Object.fromEntries(keys.map(k=>[k,localStorage.getItem(k)])),keys);
  const toast=()=>evaluate('document.querySelector("#toast").innerText');
  async function password(value,confirmation=value){
    await wait('!!document.querySelector("dialog[open] input[type=password]")','password dialog');
    await perform((p,q)=>{const d=document.querySelector('dialog[open]'),fields=d.querySelectorAll('input[type=password]');fields[0].value=p;if(fields[1])fields[1].value=q;d.querySelector('form').requestSubmit()},value,confirmation);
    await idle();
  }
  async function restore(text,p,accept=true){
    await perform((text,accept)=>{window.confirm=()=>accept;const d=new DataTransfer();d.items.add(new File([text],'synthetic.json',{type:'application/json'}));const el=document.querySelector('#import-input');el.files=d.files;el.dispatchEvent(new Event('change',{bubbles:true}));},text,accept);
    await password(p);
  }
  await ready();
  assert.equal(await evaluate('isSecureContext&&!!crypto.subtle'),true);
  await perform(()=>{acceptGDPR();localStorage.setItem('qa-unrelated-key','keep');switchTab('symptoms');document.querySelector('#symptom-date').value='2026-11-25';document.querySelectorAll('.pain-btn')[4].click();document.querySelector('#energy-level').value='0';document.querySelector('#energy-level').dispatchEvent(new Event('input'));document.querySelector('#symptom-notes').value='SYNTHETIC_FIBRO_QA_ONLY';document.querySelector('#symptom-form').requestSubmit()});
  const original=await snapshot();assert.equal(JSON.parse(original.symptoms).length,1);assert.equal(JSON.parse(original.symptoms)[0].energy,'0');
  assert.match(await evaluate('document.querySelector("#symptom-list").textContent'),/SYNTHETIC_FIBRO_QA_ONLY/);
  await perform(()=>{const orig=URL.createObjectURL.bind(URL);URL.createObjectURL=b=>{window.__qaBlob=b;return orig(b)};document.querySelector('button[onclick="exportData()"]').click()});
  await wait('!!document.querySelector("dialog[open] input[type=password]")','export dialog');
  await perform(()=>{const d=document.querySelector('dialog[open]'),fields=d.querySelectorAll('input[type=password]');fields[0].value='fibrocare-synthetic-test-only';fields[1].value='mismatch-test-only';d.querySelector('form').requestSubmit()});
  assert.equal(await evaluate('!!document.querySelector("dialog[open]")'),true,'Mismatched password rejected');
  await password(pass);
  const backup=await evaluate('window.__qaBlob.text()'), envelope=JSON.parse(backup);
  assert.equal(envelope.format,'fibrocare-encrypted-v1');
  assert.equal(Buffer.from(envelope.salt,'base64').length,16);
  assert.equal(Buffer.from(envelope.iv,'base64').length,12);
  assert.ok(!backup.includes('SYNTHETIC_FIBRO_QA_ONLY')&&!backup.includes(pass));
  await perform(()=>{window.confirm=()=>true;document.querySelector('button[onclick="clearData()"]').click()});
  const cleared=await snapshot();assert.ok(keys.every(k=>cleared[k]===null),'Journal only cleared');
  assert.equal(await evaluate('localStorage.getItem("qa-unrelated-key")'),'keep');
  await restore(backup,wrong);assert.deepEqual(await snapshot(),cleared);assert.match(await toast(),/incorrecte|altérée/);
  const corrupt=JSON.parse(backup),bytes=Buffer.from(corrupt.ciphertext,'base64');bytes[0]^=1;corrupt.ciphertext=bytes.toString('base64');
  await restore(JSON.stringify(corrupt),pass);assert.deepEqual(await snapshot(),cleared);assert.match(await toast(),/altérée/);
  await restore(backup,pass,false);assert.deepEqual(await snapshot(),cleared,'Cancelled restore leaves data unchanged');
  await restore(backup,pass);assert.deepEqual(JSON.parse((await snapshot()).symptoms),JSON.parse(original.symptoms));
  await call('Page.navigate',{url:base+'/?reload=1'});await ready();
  assert.match(await evaluate('document.querySelector("#symptom-list").textContent'),/SYNTHETIC_FIBRO_QA_ONLY/);
  // PDF test uses the actual pinned CDN jsPDF library, not a stub.
  await wait('typeof window.jspdf?.jsPDF==="function"','real jsPDF library');
  await perform(()=>{window.confirm=()=>true;const rows=db.get('symptoms');for(let i=0;i<28;i++)rows.push({date:'2026-11-24',pain:'4',energy:'0',text:'Synthetic paragraph '+('long note for page wrapping '.repeat(15)),id:10000+i});db.set('symptoms',rows);});
  const downloads=path.join(tmp,'downloads');await fs.mkdir(downloads);
  await call('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});
  await perform(()=>document.querySelector('button[onclick="generatePDF()"]').click());
  const pdf=await poll(async()=>{try{const bytes=await fs.readFile(path.join(downloads,'rapport-fibro.pdf'));return bytes.subarray(-40).toString().includes('%%EOF')?bytes:null}catch{return null}},'actual PDF download',15000);
  const pdfText=pdf.toString('latin1');
  assert.ok(pdfText.startsWith('%PDF-'));assert.ok((pdfText.match(/\/Type\s*\/Page\b/g)||[]).length>1,'PDF must paginate');
  assert.ok(pdfText.includes('Energie 0/10'),'Zero energy is retained in uncompressed PDF');
  await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:3,mobile:true});
  await perform(()=>switchTab('symptoms'));
  assert.equal(await evaluate('(()=>{const b=document.querySelector("#symptom-form").getBoundingClientRect();return b.left>=0&&b.right<=innerWidth+1})()'),true);
  assert.deepEqual(browserErrors,[],'Uncaught JS errors');
  assert.deepEqual(httpPosts,[],'Journal and PDF must not POST data');
  console.log('FIBROCARE CHROMIUM PASS: journal, encrypted backup, password mismatch, wrong password, tamper, cancel, scoped clear, reload, real multipage PDF, mobile viewport, no POST');
 }catch(error){
  throw Error(error.message+(diagnostics?'\nBrowser diagnostics: '+diagnostics.slice(-1000):''));
 }finally{
  try{ws?.close();}catch{}
  try{chrome?.kill('SIGKILL');}catch{}
  try{server?.kill('SIGTERM');}catch{}
  await sleep(300);
  await fs.rm(tmp,{recursive:true,force:true,maxRetries:6,retryDelay:200}).catch(()=>{});
 }
}
main().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
