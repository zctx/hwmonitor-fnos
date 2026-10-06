'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { execFileSync } = require('child_process');
const { createLoader, fetchBytes, checkedUrl, validateEntry } = require('../overlay/driverload');
const { start } = require('../overlay/n5-startup');
const K='6.18.18.c1126-trim', M='minisforum_n5_it5571';
const DMI={product_name:'N5A',board_name:'F8NAB'};
const SRC='96E49785C432E4B85FAF416', REF='e47545166ac93e3c5769dcaef75ee6ec4dd5d95d';
const delay = ms => new Promise(r=>setTimeout(r,ms));
function fixture(t, opts={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hwmon-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const cache=path.join(root,'cache');
  const app=path.join(root,'app');
  fs.mkdirSync(path.join(app,'drivers','n5'),{recursive:true});
  const buf=Buffer.alloc(128);
  Buffer.from([0x7f,69,76,70,2,1]).copy(buf); buf.writeUInt16LE(1,16);buf.writeUInt16LE(62,18);
  const entry={kernel:K,asset:`${M}-${K}.ko`,size:buf.length,sha256:crypto.createHash('sha256').update(buf).digest('hex'),
    driver_version:'0.2.0',srcversion:SRC,driver_ref:REF};
  const policy={schema:2,channel:'kernel-modules-v2',module:M,driver_version:'0.2.0',srcversion:SRC,driver_ref:REF,bundled:{}};
  if(opts.bundled){policy.bundled[K]=entry;fs.writeFileSync(path.join(app,'drivers','n5',entry.asset),buf);}
  const state={loaded:false,healthy:true,version:'0.2.0',experimental:'Y',runs:[],downloads:[],logs:[],network:true,infoSrc:SRC};
  function sys(p) {
    if(!state.loaded) return undefined;
    if(p===`/sys/module/${M}/version`)return state.version;
    if(p===`/sys/module/${M}/srcversion`)return SRC;
    if(p===`/sys/module/${M}/parameters/experimental_write`)return state.experimental;
    if(p==='/sys/class/hwmon/hwmon99/name' && state.healthy)return M;
    if(p.startsWith('/sys/class/hwmon/hwmon99/') && state.healthy)return '1';
    return undefined;
  }
  const io={...fs,
    existsSync(p){if(String(p).startsWith('/sys/'))return p===`/sys/module/${M}`?state.loaded:sys(p)!==undefined;return fs.existsSync(p);},
    readFileSync(p,...args){if(typeof p==='string'&&p.startsWith('/sys/')){const v=sys(p);if(v===undefined)throw Object.assign(new Error('missing'),{code:'ENOENT'});return v;}return fs.readFileSync(p,...args);},
    readdirSync(p,...args){if(p==='/sys/class/hwmon')return state.loaded&&state.healthy?['hwmon99']:[];return fs.readdirSync(p,...args);},
    accessSync(p,...args){if(/^\/(usr\/)?s?bin\/(modinfo|insmod|rmmod)$/.test(p)){if(state.noModinfo&&p.endsWith('modinfo'))throw Error('missing');return;}return fs.accessSync(p,...args);},
    lstatSync(p){const s=fs.lstatSync(p);if(p!==root&&root.startsWith(p+path.sep)){s.uid=process.getuid();s.mode &= ~0o022;}return s;}
  };
  const download=async(url,limit,signal)=>{
    state.downloads.push(url);
    if(!state.network) throw Error('network unavailable');
    if(state.onDownload)await state.onDownload(url,signal);
    if(signal.aborted) throw Error('cancelled');
    if(url.endsWith('.json'))return Buffer.from(JSON.stringify({schema:2,modules:state.emptyIndex?{}:{[K]:state.entry||entry}}));
    return state.badBytes?Buffer.alloc(buf.length):buf;
  };
  const run=async(cmd,args)=>{
    state.runs.push([path.basename(cmd),...args]);
    if(cmd.endsWith('modinfo')){
      assert.ok(args[0].endsWith('.ko'),'temporary file must end with .ko');
      return {stdout:`name: ${M}\nversion: 0.2.0\nsrcversion: ${state.infoSrc}\nvermagic: ${K} SMP preempt mod_unload\nparm: experimental_write:Enable PWM writes (bool)\n`};
    }
    if(cmd.endsWith('insmod')){state.loaded=true;return {stdout:''};}
    if(cmd.endsWith('rmmod')){state.loaded=false;return {stdout:''};}
    throw Error('unexpected command');
  };
  const loader=createLoader({fs:io,appDir:app,cacheDir:cache,owner:process.getuid(),kernel:opts.kernel||K,arch:opts.arch||'x64',
    policy,remote:opts.remote===undefined?true:opts.remote,download,run});
  return {loader,state,root,cache,app,policy,entry,buf,load:()=>loader.autoload(DMI,x=>state.logs.push(x))};
}

test('bundled module is hashed and metadata-checked before insmod',async t=>{
 const f=fixture(t,{bundled:true});assert.equal((await f.load()).status,'loaded');
 assert.deepEqual(f.state.runs.map(x=>x[0]),['modinfo','insmod']);
 assert.equal(f.state.downloads.length,0);assert.equal(f.state.runs[1][2],'experimental_write=1');
});
test('bundled bytes tampered: refuse load',async t=>{
 const f=fixture(t,{bundled:true});fs.appendFileSync(path.join(f.app,'drivers','n5',f.entry.asset),'bad');
 assert.equal((await f.load()).status,'failed');assert.equal(f.state.runs.length,0);
});
test('remote first install uses .ko temporary file and checks health',async t=>{
 const f=fixture(t);assert.equal((await f.load()).source,'remote');
 assert.match(f.state.runs[0][1],/\.pending-.*\.ko$/);assert.ok(fs.existsSync(path.join(f.cache,K+'.json')));
 assert.equal(fs.statSync(f.cache).mode&0o777,0o700);
});
test('offline cache reuse revalidates content and modinfo',async t=>{
 const f=fixture(t);await f.load();f.state.loaded=false;f.state.network=false;f.state.runs=[];f.state.downloads=[];
 assert.equal((await f.load()).source,'cache');assert.deepEqual(f.state.runs.map(x=>x[0]),['modinfo','insmod']);assert.equal(f.state.downloads.length,0);
});
test('tampered cache is not loaded and can be replaced from trusted channel',async t=>{
 const f=fixture(t);await f.load();f.state.loaded=false;f.state.runs=[];
 fs.writeFileSync(path.join(f.cache,f.entry.asset),Buffer.alloc(f.buf.length));
 assert.equal((await f.load()).source,'remote');assert.ok(f.state.logs.some(x=>x.includes('缓存未通过')));
});
test('bad cache + no network: no insmod',async t=>{
 const f=fixture(t);await f.load();f.state.loaded=false;f.state.runs=[];f.state.network=false;
 fs.appendFileSync(path.join(f.cache,f.entry.asset),'bad');assert.equal((await f.load()).status,'failed');assert.equal(f.state.runs.length,0);
});
test('unreceipted legacy cache file never authorizes loading',async t=>{
 const f=fixture(t);fs.mkdirSync(f.cache);fs.writeFileSync(path.join(f.cache,f.entry.asset),f.buf);
 f.state.emptyIndex=true;assert.equal((await f.load()).status,'no-build');assert.equal(f.state.runs.length,0);
});
test('remote disabled does not use old cache or retry/download',async t=>{
 const f=fixture(t,{remote:false});fs.mkdirSync(f.cache);fs.writeFileSync(path.join(f.cache,f.entry.asset),f.buf);
 fs.writeFileSync(path.join(f.cache,K+'.json'),JSON.stringify(f.entry));
 const r=await f.load();assert.equal(r.status,'no-build');assert.equal(r.retryable,false);assert.equal(f.state.downloads.length,0);assert.equal(f.state.runs.length,0);
});
test('cached symlink is not read as a module',async t=>{
 const f=fixture(t);await f.load();f.state.loaded=false;f.state.network=false;f.state.runs=[];
 fs.unlinkSync(path.join(f.cache,f.entry.asset));fs.symlinkSync('/etc/passwd',path.join(f.cache,f.entry.asset));
 assert.equal((await f.load()).status,'failed');assert.equal(f.state.runs.length,0);
});
test('cache parent writable by others: fail before download',async t=>{
 const f=fixture(t);fs.chmodSync(f.root,0o777);assert.equal((await f.load()).status,'failed');assert.equal(f.state.downloads.length,0);
});
test('cache directory symlink: fail',async t=>{
 const f=fixture(t);const other=path.join(f.root,'other');fs.mkdirSync(other);fs.symlinkSync(other,f.cache);
 assert.equal((await f.load()).status,'failed');assert.equal(f.state.downloads.length,0);
});
test('malformed/cross-kernel index rejected',async t=>{
 const f=fixture(t);for(const change of [{asset:'other.ko'},{kernel:'6.18.18.c11260-trim'},{size:5000000},{sha256:'X'.repeat(64)},{driver_ref:'0'.repeat(40)}]){
  f.state.entry={...f.entry,...change};assert.equal((await f.load()).status,'failed');
 }assert.equal(f.state.runs.length,0);
});
test('download corrupted or wrong modinfo refuses insmod',async t=>{
 const f=fixture(t);f.state.badBytes=true;assert.equal((await f.load()).status,'failed');assert.equal(f.state.runs.length,0);
 f.state.badBytes=false;f.state.infoSrc='0'.repeat(24);assert.equal((await f.load()).status,'failed');assert.ok(f.state.runs.every(x=>x[0]==='modinfo'));
 assert.ok(fs.readdirSync(f.cache).every(x=>!x.startsWith('.pending-')));
});
test('missing modinfo fails closed',async t=>{
 const f=fixture(t);f.state.noModinfo=true;assert.equal((await f.load()).status,'failed');assert.equal(f.state.runs.length,0);
});
test('unknown DMI and unsupported architecture/kernel do not download',async t=>{
 const f=fixture(t);assert.equal((await f.loader.autoload({product_name:'OTHER',board_name:'F8NAB'})).status,'not-applicable');
 for(const opts of [{kernel:'6.19.1-test'},{arch:'arm64'}]){const q=fixture(t,opts);const r=await q.load();assert.equal(r.retryable,false);assert.equal(q.state.downloads.length,0);}
});
test('N5 PRO is read-only: never automatically enable experimental_write',async t=>{
 const f=fixture(t,{bundled:true});const r=await f.loader.autoload({product_name:'N5 PRO',board_name:'F8NAA'});
 assert.equal(r.writable,false);assert.equal(f.state.runs[1].length,2);
});
test('already loaded but no hwmon / wrong version / wrong write param is not success',async t=>{
 for(const flags of [{healthy:false},{version:'0.1.0'},{experimental:'N'}]){
  const f=fixture(t);Object.assign(f.state,{loaded:true},flags);const r=await f.load();assert.equal(r.status,'failed');assert.equal(r.retryable,false);assert.equal(f.state.runs.length,0);
 }
});
test('our new module with failed probe is unloaded; not marked ready',async t=>{
 const f=fixture(t,{bundled:true});f.state.healthy=false;assert.equal((await f.load()).status,'failed');
 assert.deepEqual(f.state.runs.map(x=>x[0]),['modinfo','insmod','rmmod']);assert.equal(f.state.loaded,false);
});
test('parallel autoload has a single in-flight operation and does not block timers',async t=>{
 const f=fixture(t);f.state.onDownload=()=>delay(30);let ticks=0;const timer=setInterval(()=>ticks++,2);
 const a=f.load(),b=f.load();assert.equal(a,b);await a;clearInterval(timer);
 assert.ok(ticks>=5);assert.equal(f.state.runs.filter(x=>x[0]==='insmod').length,1);
});
test('shutdown during download prevents late insmod',async t=>{
 const f=fixture(t);f.state.onDownload=()=>delay(20);const p=f.load();f.loader.cancel();
 assert.equal((await p).retryable,false);assert.equal(f.state.runs.length,0);
});
test('another program loads during download: do not replace/unload its module',async t=>{
 const f=fixture(t);f.state.onDownload=async()=>{f.state.loaded=true;};
 assert.equal((await f.load()).status,'already-loaded');assert.ok(f.state.runs.every(x=>x[0]==='modinfo'));
});

test('scheduler retries only after completion, reconciles on late load, then stops',async()=>{
 let count=0,reconciled=0,tasks=[],states=[];
 const control=start({loader:{autoload:async()=>++count===1?{status:'no-build',retryable:true}:{status:'loaded',retryable:false},
  availableBuilds:()=>[],cancel:()=>{}},dmi:()=>DMI,log:()=>{},onState:s=>states.push(s),reconcile:()=>reconciled++,schedule:f=>{tasks.push(f);return 1;},unschedule:()=>{}});
 await control.initial;assert.equal(tasks.length,1);assert.equal(reconciled,0);await tasks.shift()();assert.equal(reconciled,1);assert.equal(tasks.length,0);assert.equal(states.length,2);
});
test('scheduler stop cancels loader and ignores a late completion',async()=>{
 let resolve,cancelled=false,writes=0,notifications=0;
 const c=start({loader:{autoload:()=>new Promise(r=>resolve=r),availableBuilds:()=>[],cancel:()=>cancelled=true},dmi:()=>DMI,
 onState:()=>notifications++,reconcile:()=>writes++});c.stop();resolve({status:'loaded'});await c.initial;
 assert.equal(cancelled,true);assert.equal(writes,0);assert.equal(notifications,0);
});

function requestWith(make){return (url,options,callback)=>{
 const req=new EventEmitter();req.destroy=()=>{};
 queueMicrotask(()=>{const res=new PassThrough();res.headers={};res.statusCode=200;res.complete=true;make(res,url,callback);});return req;
};}
test('HTTPS only and restricted redirect hosts',()=>{
 for(const u of ['http://github.com/x','https://evil.example/x','https://github.com:444/x','https://user:pass@github.com/x'])assert.throws(()=>checkedUrl(u));
 assert.equal(checkedUrl('https://release-assets.githubusercontent.com/x').protocol,'https:');
});
test('bounded network download success',async()=>{
 const get=requestWith((res,u,cb)=>{res.headers={'content-length':'2'};cb(res);res.end('OK');});
 assert.equal((await fetchBytes('https://github.com/x',10,null,get)).toString(),'OK');
});
test('HTTP downgrade redirect rejected',async()=>{
 const get=requestWith((res,u,cb)=>{res.statusCode=302;res.headers.location='http://github.com/x';cb(res);});
 await assert.rejects(fetchBytes('https://github.com/x',10,null,get),/不允许/);
});
test('stream size, incomplete body and incorrect length rejected',async()=>{
 for(const kind of ['large','incomplete','length']){
  const get=requestWith((res,u,cb)=>{if(kind==='incomplete')res.complete=false;if(kind==='length')res.headers={'content-length':'5'};cb(res);res.end(kind==='large'?'X'.repeat(20):'OK');});
  await assert.rejects(fetchBytes('https://github.com/x',10,null,get));
 }
});
test('download timeout and cancellation settle, do not hang',async()=>{
 const get=()=>{const r=new EventEmitter();r.destroy=()=>{};return r;};
 await assert.rejects(fetchBytes('https://github.com/x',10,null,get,20),/超时/);
 const c=new AbortController();const p=fetchBytes('https://github.com/x',10,c.signal,get);c.abort();await assert.rejects(p,/取消/);
});
test('excessive redirects rejected',async()=>{
 const get=requestWith((res,u,cb)=>{res.statusCode=302;res.headers.location='https://github.com/next';cb(res);});
 await assert.rejects(fetchBytes('https://github.com/x',10,null,get),/重定向过多/);
});
test('real modinfo regression for temporary extension', {skip:!process.env.HWMON_TEST_KO}, t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hwmon-modinfo-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const good=path.join(dir,'pending.ko'), bad=path.join(dir,'pending.ko.tmp');
 fs.copyFileSync(process.env.HWMON_TEST_KO,good);fs.copyFileSync(good,bad);
 assert.equal(execFileSync('modinfo',['-F','version',good],{encoding:'utf8'}).trim(),'0.2.0');
 assert.throws(()=>execFileSync('modinfo',['-F','version',bad],{stdio:'pipe'}));
});

test('application final write gate blocks every N5 path until driver health passes', { skip: !process.env.HWMON_TEST_APP },()=>{
 const vm=require('vm');const source=fs.readFileSync(path.join(process.env.HWMON_TEST_APP,'server.js'),'utf8');
 const fn=source.match(/function writeFile\(p, v\) \{[\s\S]*?\n\}/)[0];
 let writes=0, chip=M;
 const ctx={path,readFile:()=>chip,fs:{writeFileSync:()=>writes++},n5Driver:{status:'checking'}};
 vm.createContext(ctx);vm.runInContext(fn,ctx);
 for(const status of ['checking','failed','no-build']){
  ctx.n5Driver.status=status;assert.throws(()=>ctx.writeFile('/sys/class/hwmon/hwmon99/pwm1',0));
 }assert.equal(writes,0);
 ctx.n5Driver.status='loaded';ctx.writeFile('/sys/class/hwmon/hwmon99/pwm1_enable',2);assert.equal(writes,1);
 ctx.n5Driver.status='failed';chip='other_chip';ctx.writeFile('/sys/class/hwmon/hwmon1/pwm1_enable',2);assert.equal(writes,2);
});
