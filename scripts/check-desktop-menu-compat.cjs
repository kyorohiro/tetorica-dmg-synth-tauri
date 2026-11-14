// Silent headless compatibility check: exact frontend + desktop init script.
// Native IPC is mocked; this never launches Tauri or changes OS audio/pinning.
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {createHash}=require('node:crypto'),{tmpdir}=require('node:os'),{chromium,webkit}=require('playwright');
const app=path.resolve(__dirname,'..'),options={dist:path.join(app,'dist'),engines:'chromium,webkit',out:path.join(tmpdir(),'dmg-desktop-menu-compat.json'),screenshots:path.join(tmpdir(),'dmg-desktop-menu-compat')};
for(const arg of process.argv.slice(2)){const match=/^--(dist|engines|out|screenshots)=(.+)$/.exec(arg);assert(match,'Unknown argument '+arg);options[match[1]]=match[2];}
options.dist=path.resolve(options.dist);const names=options.engines.split(',');assert(names.every(name=>['chromium','webkit'].includes(name)));
const origin='https://tauri.localhost',hash=value=>createHash('sha256').update(value).digest('hex');
const mime={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.wasm':'application/wasm','.json':'application/json','.webp':'image/webp','.svg':'image/svg+xml','.ico':'image/x-icon'};
const assets=new Map(),missing=[],blocked=[],results=[];
function audit(){
 const Native=window.AudioContext??window.webkitAudioContext,connect=AudioNode.prototype.connect,add=EventTarget.prototype.addEventListener;
 const state=window.__dmgDesktopMenuAudit={calls:[],bindings:[],contexts:0,gates:[],original:null};let pinned=false;
 window.AudioContext=class extends Native{constructor(...args){super(...args);state.contexts++;}};if(window.webkitAudioContext)window.webkitAudioContext=window.AudioContext;
 AudioNode.prototype.connect=function(target,...args){if(target!==this.context.destination)return connect.call(this,target,...args);const gate=this.context.createGain();gate.gain.value=0;connect.call(this,gate,...args);connect.call(gate,target);state.gates.push(gate);return target;};
 const capture=()=>{const menu=document.getElementById('synthMenu');if(menu&&!state.original)state.original={menu,parent:menu.parentElement.className,nodes:[...menu.querySelectorAll('[id]')].map(node=>({id:node.id,node}))};};
 EventTarget.prototype.addEventListener=function(type,listener,opts){
  if(['synthMenu','synthMenuButton','synthMenuPanel'].includes(this.id))state.bindings.push({id:this.id,type});
  if((this===window&&type==='tetorica-synth-ready')||(this===document&&type==='DOMContentLoaded')){
   const original=listener;listener=function(event){capture();return typeof original==='function'?original.call(this,event):original.handleEvent(event);};
  }
  return add.call(this,type,listener,opts);
 };
 window.__TAURI_INTERNALS__={invoke:async(command,args={})=>{state.calls.push({command,args:args instanceof ArrayBuffer?{bytes:args.byteLength}:args});
  if(command==='window_pin_state')return pinned;if(command==='set_window_pin')return pinned=args.pinned;
  if(command==='audio_devices')return[{id:'mock-output',name:'Silent mock output',isDefault:true}];
  if(command==='save_export_binary')return'/mock/saved.json';if(command==='reload_window')return true;
  throw Error('Native output or unexpected IPC is forbidden: '+command);
 }};
}
const legacy=`<!doctype html><html><head><meta charset="utf-8"><title>Older DMG frontend</title></head><body>
<div class="title-row"><div class="product-identity">Older DMG</div></div><p id="audioStatus"></p>
<button id="loadPreset">Load preset</button><input id="presetFileInput" type="file"><button id="savePreset">Save preset</button><button id="loadVgm">Load VGM</button>
<script>window.legacyActions={imports:0,exports:0,vgm:0};window.legacyNodes={load:loadPreset,save:savePreset,input:presetFileInput};loadPreset.onclick=()=>presetFileInput.click();presetFileInput.onchange=()=>legacyActions.imports++;savePreset.onclick=()=>legacyActions.exports++;loadVgm.onclick=()=>legacyActions.vgm++;</script></body></html>`;
async function unique(page){for(const id of ['synthMenu','synthMenuButton','synthMenuPanel','synthPinButton','synthMenuAudio'])assert.equal(await page.locator('#'+id).count(),1,id+' unique');}
async function open(page){if(!await page.locator('#synthMenu').evaluate(node=>node.open))await page.locator('#synthMenuButton').click();await page.waitForFunction(()=>document.getElementById('synthMenu').open);}
async function check(browser,name,desktop,audio){
 const page=await browser.newPage({viewport:{width:1180,height:1000},acceptDownloads:true});page.setDefaultTimeout(20000);
 const errors=[],consoleErrors=[],checks=[];let phase='load';
 page.on('pageerror',error=>errors.push(error.stack??error.message));page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});
 await page.addInitScript({content:`(${audit.toString()})();\n${desktop}`});
 await page.route('**/*',async route=>{const url=new URL(route.request().url());if(['data:','blob:'].includes(url.protocol))return route.continue();
  if(url.hostname!=='tauri.localhost'){blocked.push(url.href);return route.abort();}
  if(url.pathname==='/favicon.ico')return route.fulfill({status:204,body:''});
  if(url.pathname==='/legacy.html')return route.fulfill({contentType:'text/html',body:legacy});
  try{const filename=path.resolve(options.dist,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));assert(filename.startsWith(options.dist+path.sep));
   const source=await fs.readFile(filename);const body=url.pathname==='/synth-dmg/synth.js'?Buffer.concat([source,Buffer.from('\n;\n'+audio)]):source;
   const metadata={bytes:source.length,sha256:hash(source),servedSha256:hash(body)};if(assets.has(url.pathname))assert.deepEqual(assets.get(url.pathname),metadata,'Assets changed during check');assets.set(url.pathname,metadata);
   return route.fulfill({status:200,body,contentType:mime[path.extname(filename)]??'application/octet-stream'});
  }catch(error){missing.push({path:url.pathname,error:error.message});return route.fulfill({status:404,body:error.message});}
 });
 try{
  await page.goto(origin+'/index.html');await page.waitForFunction(()=>document.getElementById('dmgFileNewButton')&&!document.getElementById('dmgFileNewButton').disabled);
  await page.waitForFunction(()=>document.getElementById('synthPinButton')?.hidden===false);await unique(page);
  phase='complete menu reuse';const preserved=await page.evaluate(()=>{const a=__dmgDesktopMenuAudit,o=a.original;return{same:o?.menu===document.getElementById('synthMenu'),parent:o?.parent,preserved:o?.nodes.every(({id,node})=>document.getElementById(id)===node),host:document.getElementById('synthMenu').parentElement.id,bindings:a.bindings};});
  assert.equal(preserved.same,true);assert.equal(preserved.parent,'transport-actions');assert.equal(preserved.preserved,true);assert.equal(preserved.host,'synthDesktopTools');
  for(const[id,type]of [['synthMenu','toggle'],['synthMenuButton','pointerdown'],['synthMenuPanel','click']])assert.equal(preserved.bindings.filter(binding=>binding.id===id&&binding.type===type).length,1,id+' handlers stay single');
  for(const id of ['loadVgm','vgmFileInput','loadPreset','presetFileInput','savePreset','dmgProjectImportButton','dmgProjectExportButton','dmgFileImportButton','dmgFileExportButton']){
   assert.equal(await page.locator('#'+id).count(),1,id+' retained');assert(await page.locator('#'+id).evaluate(node=>Boolean(node.closest('#synthMenuPanel'))),id+' stays in original panel');}
  assert.equal(await page.locator('#synthMenuVgm').count(),0);assert.equal(await page.locator('#synthMenuPanel [data-reset-offline-cache]').count(),1);await page.locator('#desktop-audio-output').waitFor({state:'attached'});checks.push('one original menu, original inputs and Files actions, one output/reload/Pin');
  phase='pin and shared menu events';await page.evaluate(()=>{dispatchEvent(new Event('tetorica-synth-ready'));dispatchEvent(new Event('tetorica-synth-ready'));});await page.locator('#synthPinButton').click();await page.waitForFunction(()=>document.getElementById('synthPinButton').getAttribute('aria-pressed')==='true');
  assert.equal(await page.evaluate(()=>__dmgDesktopMenuAudit.calls.filter(call=>call.command==='set_window_pin').length),1);await unique(page);
  await open(page);await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.getElementById('synthMenu').open);assert.equal(await page.locator('#synthMenuButton').evaluate(node=>node===document.activeElement),true);
  await open(page);await page.mouse.click(2,2);await page.waitForFunction(()=>!document.getElementById('synthMenu').open);
  const chooser=page.waitForEvent('filechooser');await open(page);await page.locator('#loadVgm').click();await(await chooser).setFiles([]);assert.equal(await page.locator('#synthMenu').evaluate(node=>node.open),false);checks.push('Pin bound once; shared Escape/outside/file action close once');
  phase='layout';await fs.mkdir(options.screenshots,{recursive:true});for(const width of [1180,640]){await page.setViewportSize({width,height:1000});await page.locator('#synthMenuButton').scrollIntoViewIfNeeded();assert(await page.locator('#synthMenuButton').isVisible());assert(await page.locator('#synthPinButton').isVisible());await page.screenshot({path:path.join(options.screenshots,name+'-'+width+'.png')});}
  const graph=await page.evaluate(()=>({contexts:__dmgDesktopMenuAudit.contexts,gates:__dmgDesktopMenuAudit.gates.length,muted:__dmgDesktopMenuAudit.gates.every(gate=>gate.gain.value===0),calls:__dmgDesktopMenuAudit.calls}));assert.equal(graph.contexts,0);assert.equal(graph.gates,0);assert(graph.muted);assert(graph.calls.every(call=>['window_pin_state','set_window_pin','audio_devices'].includes(call.command)));
  phase='older frontend fallback';await page.goto(origin+'/legacy.html');await page.waitForFunction(()=>document.getElementById('synthPinButton')?.hidden===false);await unique(page);
  assert(await page.evaluate(()=>legacyNodes.load===loadPreset&&legacyNodes.save===savePreset&&legacyNodes.input===presetFileInput));assert.equal(await page.locator('#synthMenuVgm').count(),1);
  const legacyChooser=page.waitForEvent('filechooser');await open(page);await page.locator('#loadPreset').click();await(await legacyChooser).setFiles({name:'old.json',mimeType:'application/json',buffer:Buffer.from('{}')});assert.equal(await page.evaluate(()=>legacyActions.imports),1);
  await open(page);await page.locator('#savePreset').click();assert.equal(await page.evaluate(()=>legacyActions.exports),1);await open(page);await page.locator('#synthMenuVgm').click();assert.equal(await page.evaluate(()=>legacyActions.vgm),1);assert.equal(await page.locator('#synthMenu').evaluate(node=>node.open),false);checks.push('legacy fallback still moves original JSON nodes and supplies one VGM proxy');
  assert.equal(await page.evaluate(()=>__dmgDesktopMenuAudit.contexts),0);assert.deepEqual(errors,[]);assert.deepEqual(consoleErrors,[]);
  return{browser:name,passed:true,checks,preserved,graph,errors,consoleErrors};
 }catch(error){await fs.mkdir(options.screenshots,{recursive:true});await page.screenshot({path:path.join(options.screenshots,name+'-failure.png')}).catch(()=>{});error.receipt={browser:name,passed:false,phase,error:error.stack,checks,errors,consoleErrors,body:await page.locator('body').innerText().catch(()=>''),calls:await page.evaluate(()=>window.__dmgDesktopMenuAudit?.calls).catch(()=>[])};throw error;}
 finally{await page.close();}
}
(async()=>{const desktop=await fs.readFile(path.join(app,'desktop/desktop-interface.js'),'utf8'),audio=await fs.readFile(path.join(app,'desktop/audio-interface.js'),'utf8');let failure;
 try{for(const name of names){const browser=await({chromium,webkit})[name].launch({headless:true,...(name==='chromium'?{args:['--mute-audio']}:{})});try{results.push(await check(browser,name,desktop,audio));}catch(error){results.push(error.receipt??{browser:name,passed:false,error:error.stack});throw error;}finally{await browser.close();}}assert.deepEqual(missing,[]);}
 catch(error){failure=error;}
 const receipt={passed:!failure,dist:options.dist,origin,nativeIpcMocked:true,physicalOutputMuted:true,listeningPerformed:false,sources:{desktopInterface:hash(desktop),audioInterface:hash(audio),checker:hash(await fs.readFile(__filename))},results,missing,blocked,assets:Object.fromEntries([...assets].sort(([a],[b])=>a.localeCompare(b))),...(failure?{error:failure.stack}:{})};
 await fs.mkdir(path.dirname(path.resolve(options.out)),{recursive:true});await fs.writeFile(options.out,JSON.stringify(receipt,null,2)+'\n');if(failure)throw failure;console.log('PASS '+options.out);
})().catch(error=>{console.error(error);process.exitCode=1;});
