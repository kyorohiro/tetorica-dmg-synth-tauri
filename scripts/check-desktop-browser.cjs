// Exercise the packaged frontend and actual WASM/AudioWorklets with a mocked
// desktop IPC host. Speakers stay muted; this does not test a CPAL device.
const {chromium, webkit} = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const {gzipSync} = require('node:zlib');
const http = require('node:http');

const root = path.resolve(__dirname, '..');
const options = {out:path.join(root,'docs/desktop_browser_20261104.json'), screenshots:null};
for(let index=2;index<process.argv.length;index++) {
  const name=process.argv[index].replace(/^--/,'');
  assert(Object.hasOwn(options,name),`Unknown option: ${name}`);
  assert(process.argv[index+1],`Missing value: ${name}`);
  options[name]=path.resolve(process.argv[++index]);
}
const mime = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.wasm':'application/wasm',
  '.json':'application/json','.webp':'image/webp','.png':'image/png','.svg':'image/svg+xml'};
function vgm() {
  const w=(register,value)=>[0xb3,register,value], commands=[...w(22,0x80),...w(20,0x77),...w(21,0xff),
    ...w(6,0x40),...w(7,0x90),...w(8,0x44),...w(9,0x84),0x61,0xe8,0x03,0x66];
  const data=Buffer.alloc(256+commands.length);data.write('Vgm ');data.writeUInt32LE(data.length-4,4);
  data.writeUInt32LE(0x171,8);data.writeUInt32LE(0xcc,0x34);data.writeUInt32LE(4194304,0x80);data.set(commands,256);
  return data;
}

async function run(name, engine, backend) {
  const browser=await engine.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1280,height:1000},acceptDownloads:true});
  page.setDefaultTimeout(15000);
  const errors=[], missing=[], consoleErrors=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});
  const desktop=await fs.readFile(path.join(root,'desktop/desktop-interface.js'),'utf8');
  const audio=await fs.readFile(path.join(root,'desktop/audio-interface.js'),'utf8');
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(['blob:','data:'].includes(url.protocol)) return route.continue();
    if(url.hostname!=='tauri.localhost') {missing.push(url.href);return route.abort();}
    try {
      const file=url.pathname==='/desktop-audio-worklet.js' ? path.join(root,'desktop/audio-worklet.js')
        :path.resolve(root,'dist','.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));
      assert(file.startsWith(path.join(root,'dist')+path.sep)||file===path.join(root,'desktop/audio-worklet.js'));
      let body=await fs.readFile(file);
      if(url.pathname==='/synth-dmg/synth.js') body=Buffer.concat([body,Buffer.from('\n;\n'+audio)]);
      return route.fulfill({status:200,body,contentType:mime[path.extname(file)]||'application/octet-stream',
        headers:{'access-control-allow-origin':'*'}});
    } catch(error) {missing.push(`${url.pathname}: ${error.message}`);return route.fulfill({status:404,body:'Missing asset'});}
  });
  await page.addInitScript(({backend})=>{
    const audit=window.desktopAudit={calls:[],saves:[],contexts:[],worklets:[],speakerEdges:new Map(),
      pinned:false,nextRead:0,packets:0,returned:0,nativePeak:0,nativeFinite:true,nativeSession:0,failWrites:false,holdStart:false,cancelSave:false};
    const Context=window.AudioContext??window.webkitAudioContext, Node=window.AudioWorkletNode;
    const connect=AudioNode.prototype.connect,disconnect=AudioNode.prototype.disconnect;
    window.AudioContext=class extends Context {constructor(...args){
      super(...args);audit.contexts.push(this);
      // Playwright page routes do not see AudioWorklet module fetches. Serve
      // those exact bytes through a real CORS-enabled loopback test server.
      const add=this.audioWorklet.addModule.bind(this.audioWorklet);
      this.audioWorklet.addModule=(url,...options)=>{
        const value=new URL(url,location.href);
        return add(value.hostname==='tauri.localhost'?new URL(value.pathname+value.search,backend).href:url,...options);
      };
    }};
    if(window.webkitAudioContext) window.webkitAudioContext=window.AudioContext;
    window.AudioWorkletNode=class extends Node {constructor(...args){super(...args);audit.worklets.push({node:this,name:args[1]});}};
    AudioNode.prototype.connect=function(destination,...args){
      if(destination!==this.context.destination) return connect.call(this,destination,...args);
      const analyser=this.context.createAnalyser();analyser.fftSize=4096;
      const mute=this.context.createGain();mute.gain.value=0;
      connect.call(this,analyser);connect.call(analyser,mute);connect.call(mute,destination);
      audit.speakerEdges.set(this,{analyser,mute});return destination;
    };
    AudioNode.prototype.disconnect=function(destination,...args){
      const edge=audit.speakerEdges.get(this);
      if(edge&&(arguments.length===0||destination===this.context.destination)) {
        disconnect.call(this,edge.analyser);disconnect.call(edge.analyser);disconnect.call(edge.mute);audit.speakerEdges.delete(this);
        if(arguments.length) return;
      }
      return arguments.length?disconnect.call(this,destination,...args):disconnect.call(this);
    };
    audit.read=()=>new Promise((resolve,reject)=>{
      const node=audit.worklets.find(entry=>entry.name==='tetorica-gameboy-synth')?.node;
      if(!node) return reject(Error('No synth worklet'));
      const id=--audit.nextRead,timer=setTimeout(()=>{node.port.removeEventListener('message',receive);reject(Error('Read timed out'));},5000);
      function receive({data}) {if(data.id!==id)return;clearTimeout(timer);node.port.removeEventListener('message',receive);data.error?reject(Error(data.error)):resolve(data.value);}
      node.port.addEventListener('message',receive);node.port.start();node.port.postMessage({id,method:'read',args:[]});
    });
    audit.webPeak=async()=>{
      const {output}=await window.tetoricaSynthAudio.ensureReady(),edge=audit.speakerEdges.get(output);
      if(!edge)return 0;const samples=new Float32Array(edge.analyser.fftSize);edge.analyser.getFloatTimeDomainData(samples);
      return samples.reduce((peak,value)=>Math.max(peak,Math.abs(value)),0);
    };
    window.__TAURI_INTERNALS__={invoke:async(command,args={},options)=>{
      audit.calls.push({command,session:args?.session,bytes:args instanceof ArrayBuffer?args.byteLength:null});
      if(command==='window_pin_state')return audit.pinned;
      if(command==='set_window_pin')return audit.pinned=args.pinned;
      if(command==='save_export_binary') {
        const length=new DataView(args).getUint32(0,true),header=JSON.parse(new TextDecoder().decode(new Uint8Array(args,4,length)));
        const text=new TextDecoder().decode(new Uint8Array(args,4+length));audit.saves.push({header,text});return audit.cancelSave?null:'/tmp/'+header.filename;
      }
      if(command==='audio_devices')return [{id:'offline-test',name:'Offline test device',isDefault:true}];
      if(command==='audio_start') {
        if(audit.holdStart)await new Promise(resolve=>{audit.releaseStart=()=>{audit.holdStart=false;resolve();};});
        return {session:`offline-${++audit.nativeSession}`,frames:512,credits:8,sampleRate:args.sampleRate};
      }
      if(command==='audio_stop')return null;
      if(command==='audio_write') {
        if(audit.failWrites)throw Error('Injected offline device failure');
        const samples=new Float32Array(args);audit.packets+=args.byteLength/(512*8);
        for(const value of samples){audit.nativeFinite&&=Number.isFinite(value);audit.nativePeak=Math.max(audit.nativePeak,Math.abs(value));}
        return {rustMicros:100,serviceMicros:200};
      }
      if(command==='audio_poll') {
        await new Promise(resolve=>setTimeout(resolve,20));const credits=Math.min(8,audit.packets-audit.returned);audit.returned+=credits;
        return {credits,queuedFrames:1024,underruns:0};
      }
      if(command==='reload_window')return null;
      throw Error(`Unexpected native command: ${command}`);
    }};
  },{backend});
  await page.addInitScript({content:desktop});
  const state=()=>page.evaluate(()=>window.desktopAudit.read());
  const wait=async predicate=>{
    let value;for(let index=0;index<100;index++){value=await state();if(predicate(value))return value;await page.waitForTimeout(25);}
    throw Error('State did not settle: '+JSON.stringify(value));
  };
  const menu=async()=>{if(!await page.locator('#synthMenu').evaluate(node=>node.open))await page.click('#synthMenuButton');};
  const audition=async()=>{
    await page.keyboard.down('a');await wait(value=>value.voices.length===1);
    await page.waitForFunction(async()=>await window.desktopAudit.webPeak()>.001);
    await page.keyboard.up('a');await wait(value=>value.voices.length===0);
  };
  try {
    console.log(`CHECK ${name}: desktop toolbar / pin / lazy native output controls`);
    await page.goto(backend+'/index.html');
    await page.waitForFunction(()=>window.tetoricaSynthAudio&&document.querySelector('#synthPinButton')?.hidden===false&&document.querySelector('#desktop-audio-native'));
    assert.equal(await page.locator('#synthPinButton').getAttribute('aria-pressed'),'false');
    assert.equal(await page.evaluate(()=>window.desktopAudit.contexts.length),0);
    await page.click('#synthPinButton');await page.waitForFunction(()=>document.querySelector('#synthPinButton').getAttribute('aria-pressed')==='true');
    await page.click('#synthPinButton');await page.waitForFunction(()=>document.querySelector('#synthPinButton').getAttribute('aria-pressed')==='false');
    await page.click('#startAudio');await page.waitForFunction(()=>document.querySelector('#audioStatus').textContent.startsWith('Audio ready'));
    await audition();

    console.log(`CHECK ${name}: held Pulse and Pitch reset / performance blocked during output switch`);
    await page.keyboard.down('a');await wait(value=>value.voices.length===1);
    await page.locator('#pitchBend').evaluate(node=>{node.value='1';node.dispatchEvent(new Event('input',{bubbles:true}));});
    await wait(value=>value.pitch===1);
    await menu();await page.locator('#desktop-audio-output > summary').click();
    await page.evaluate(()=>{window.desktopAudit.holdStart=true;});await page.click('#desktop-audio-native');
    await page.waitForFunction(()=>typeof window.desktopAudit.releaseStart==='function');
    const switchedPulse=await wait(value=>value.voices.length===0&&value.pitch===0);
    assert.equal(switchedPulse.preset.source,'pulse');
    await page.keyboard.down('s');assert.equal((await state()).voices.length,0);await page.keyboard.up('s');
    await page.evaluate(()=>window.desktopAudit.releaseStart());
    await page.waitForFunction(()=>document.querySelector('#desktop-audio-status').textContent.startsWith('Native →'));
    await page.keyboard.up('a');await page.click('#desktop-audio-web');
    await page.waitForFunction(()=>document.querySelector('#desktop-audio-status').textContent==='Web Audio output');await audition();

    console.log(`CHECK ${name}: native binary preset save / native save cancellation / reload cancellation`);
    await menu();await page.click('#savePreset');
    await page.waitForFunction(()=>window.desktopAudit.saves.length===1);
    const saved=await page.evaluate(()=>window.desktopAudit.saves[0]);
    assert.equal(saved.header.filename,'dmg-voice.json');const preset=JSON.parse(saved.text);
    assert.equal(preset.format,'tetorica-gameboy-voice');assert.equal(preset.source,'pulse');
    await page.evaluate(()=>{window.desktopAudit.cancelSave=true;});await menu();await page.click('#savePreset');
    await page.waitForFunction(()=>document.querySelector('#audioStatus').textContent==='Save cancelled.');
    assert.equal(await page.evaluate(()=>window.desktopAudit.saves.length),2);
    await page.evaluate(()=>{window.desktopAudit.cancelSave=false;});
    await menu();await page.click('[data-reset-offline-cache]');await page.getByRole('button',{name:'Cancel',exact:true}).click();
    assert.equal(await page.evaluate(()=>window.desktopAudit.calls.filter(call=>call.command==='reload_window').length),0);

    console.log(`CHECK ${name}: menu VGM chooser / actual Wave preset file / keyboard focus`);
    await menu();const chooser=page.waitForEvent('filechooser');await page.click('#synthMenuVgm');
    await(await chooser).setFiles({name:'self-authored.vgz',mimeType:'application/gzip',buffer:gzipSync(vgm())});
    await page.waitForFunction(()=>document.querySelectorAll('[data-vgm-voice]').length===1&&document.querySelector('#vgmLibrary').dataset.loading==='false');
    await page.click('[data-vgm-voice]');let current=await wait(value=>value.preset.pulse.volume===9&&value.preset.pulse.duty===.25);
    await audition();
    const imported=structuredClone(preset);imported.name='Desktop Wave test';imported.source='wave';
    imported.wave.samples=Array.from({length:32},(_,index)=>index<16?15:0);imported.wave.level=.5;
    await menu();const waveChooser=page.waitForEvent('filechooser');await page.click('#loadPreset');
    await(await waveChooser).setFiles({name:'desktop-wave.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(imported))});
    current=await wait(value=>value.preset.name===imported.name&&value.preset.source==='wave');assert.deepEqual(current.preset,imported);await audition();

    console.log(`CHECK ${name}: actual native-capture Worklet PCM / route switch / device failure fallback`);
    await page.keyboard.down('a');await wait(value=>value.voices.length===1);await menu();
    if(!await page.locator('#desktop-audio-output').evaluate(node=>node.open))await page.locator('#desktop-audio-output > summary').click();
    await page.click('#desktop-audio-native');
    await page.waitForFunction(()=>document.querySelector('#desktop-audio-status').textContent.startsWith('Native →'));
    current=await wait(value=>value.voices.length===0);assert.deepEqual(current.preset,imported);await page.keyboard.up('a');
    assert.equal(await page.evaluate(async()=>window.desktopAudit.speakerEdges.has((await window.tetoricaSynthAudio.ensureReady()).output)),false);
    await page.keyboard.down('a');await wait(value=>value.voices.length===1);
    await page.waitForFunction(()=>window.desktopAudit.nativePeak>.001&&window.desktopAudit.packets>0);
    assert.equal(await page.evaluate(()=>window.desktopAudit.nativeFinite),true);
    await page.click('#desktop-audio-web');await page.waitForFunction(()=>document.querySelector('#desktop-audio-status').textContent==='Web Audio output');
    current=await wait(value=>value.voices.length===0);assert.deepEqual(current.preset,imported);await page.keyboard.up('a');
    assert.equal(await page.evaluate(async()=>window.desktopAudit.speakerEdges.has((await window.tetoricaSynthAudio.ensureReady()).output)),true);await audition();
    await page.click('#desktop-audio-native');await page.waitForFunction(()=>document.querySelector('#desktop-audio-status').textContent.startsWith('Native →'));
    await page.evaluate(()=>{window.desktopAudit.failWrites=true;});await page.keyboard.down('a');
    await page.waitForFunction(()=>document.querySelector('#desktop-audio-status').textContent.includes('Injected offline device failure'));
    current=await wait(value=>value.voices.length===0);assert.deepEqual(current.preset,imported);await page.keyboard.up('a');
    await audition();
    assert.equal(await page.evaluate(()=>window.desktopAudit.contexts.length),1);
    if(options.screenshots)await page.screenshot({path:path.join(options.screenshots,`desktop-${name}.png`),fullPage:true});
    await page.setViewportSize({width:540,height:900});await page.waitForTimeout(100);
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth);assert(overflow<=1,`Narrow desktop overflow: ${overflow}`);
    if(options.screenshots)await page.screenshot({path:path.join(options.screenshots,`desktop-${name}-narrow.png`),fullPage:true});
    assert.deepEqual(errors,[]);assert.deepEqual(missing,[]);
    const measurements=await page.evaluate(()=>({nativePackets:window.desktopAudit.packets,nativePeak:window.desktopAudit.nativePeak,nativeFinite:window.desktopAudit.nativeFinite}));
    console.log(`PASS ${name}: mocked desktop host with actual WASM and capture Worklet`);
    return {engine:name,desktopToolbar:true,pin:true,nativePresetBinarySave:true,reloadCancel:true,vgzMenuChooser:true,
      presetFileImport:true,keyboardAfterMenus:true,nativeCapturePcm:true,switchPreservesPreset:true,nativeFailureFallback:true,
      switchStopsPulseAndPitch:true,switchBlocksPerformance:true,nativeSaveCancel:true,
      oneAudioContext:true,mobileOverflow:overflow,...measurements,pageErrors:errors,missingAssets:missing,
      nativeHost:'mocked Tauri IPC; no CPAL device',physicalOutput:'muted'};
  } catch(error) {
    console.error(JSON.stringify({engine:name,audioStatus:await page.locator('#audioStatus').textContent().catch(()=>null),errors,missing,consoleErrors}));
    if(options.screenshots)await page.screenshot({path:path.join(options.screenshots,`desktop-${name}-failure.png`),fullPage:true}).catch(()=>{});
    throw error;
  } finally {await browser.close();}
}
(async()=>{
  if(options.screenshots)await fs.mkdir(options.screenshots,{recursive:true});
  const server=http.createServer(async(request,response)=>{
    try {
      const name=decodeURIComponent(new URL(request.url,'http://localhost').pathname);
      const file=name==='/desktop-audio-worklet.js'?path.join(root,'desktop/audio-worklet.js'):path.resolve(root,'dist','.'+name);
      assert(file.startsWith(path.join(root,'dist')+path.sep)||file===path.join(root,'desktop/audio-worklet.js'));
      const bytes=await fs.readFile(file);response.writeHead(200,{'content-type':mime[path.extname(file)]||'application/octet-stream','access-control-allow-origin':'*'});response.end(bytes);
    } catch(error){response.writeHead(404,{'access-control-allow-origin':'*'});response.end('Missing test asset');}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  try {
    const backend=`http://tauri.localhost:${server.address().port}`;
    const rows=[];for(const [name,engine] of [['chromium',chromium],['webkit',webkit]])rows.push(await run(name,engine,backend));
    await fs.mkdir(path.dirname(options.out),{recursive:true});await fs.writeFile(options.out,JSON.stringify({passed:true,rows},null,2)+'\n');
    console.log(`Desktop browser check passed: ${options.out}`);
  } finally {await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
