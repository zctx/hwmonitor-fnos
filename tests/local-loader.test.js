'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { createLoader } = require('../overlay/driverload');
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
  if(opts.localBuild)policy.local_build={files:{Makefile:'a'.repeat(64),[M+'.c']:'b'.repeat(64)}};
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
  const localBuilder={async build(signal){state.builds=(state.builds||0)+1;if(state.onBuild)await state.onBuild(signal);return {bytes:state.localBytes||buf,headers:'/usr/src/headers',compiler:'/usr/bin/gcc-12',symvers_sha256:'c'.repeat(64)};}};
  const loader=createLoader({fs:io,appDir:app,cacheDir:cache,owner:process.getuid(),kernel:opts.kernel||K,arch:opts.arch||'x64',
    policy,local:opts.local,localBuilder:opts.localBuild?localBuilder:undefined,remote:opts.remote===undefined?true:opts.remote,download,run});
  return {loader,state,root,cache,app,policy,entry,buf,load:()=>loader.autoload(DMI,x=>state.logs.push(x))};
}

test('local build takes priority over remote channel and can operate with remote disabled',async t=>{
 const f=fixture(t,{localBuild:true,remote:false});const r=await f.load();
 assert.equal(r.source,'local-build');assert.equal(r.local_build.status,'compiled');
 assert.equal(f.state.downloads.length,0);assert.equal(f.state.builds,1);
 assert.deepEqual(f.state.runs.map(x=>x[0]),['modinfo','insmod']);
 assert.ok(fs.existsSync(path.join(f.cache,'local',K+'.json')));
});
test('bundled module never triggers local compiler',async t=>{
 const f=fixture(t,{localBuild:true,bundled:true});assert.equal((await f.load()).source,'bundled');assert.equal(f.state.builds,undefined);
});
test('local cache reload revalidates but does not compile a second time',async t=>{
 const f=fixture(t,{localBuild:true,remote:false});await f.load();f.state.loaded=false;f.state.runs=[];
 assert.equal((await f.load()).source,'local-cache');assert.equal(f.state.builds,1);
 assert.deepEqual(f.state.runs.map(x=>x[0]),['modinfo','insmod']);
});
test('local disabled bypasses compiler and local cache, remote remains usable',async t=>{
 const f=fixture(t,{localBuild:true,local:false});assert.equal((await f.load()).source,'remote');assert.equal(f.state.builds,undefined);
});
test('local compile failure falls back to remote and is not repeated each retry',async t=>{
 const f=fixture(t,{localBuild:true});f.state.onBuild=async()=>{throw Error('missing headers')};
 const r=await f.load();assert.equal(r.source,'remote');assert.equal(r.local_build.status,'failed');
 f.state.loaded=false;assert.equal((await f.load()).source,'cache');assert.equal(f.state.builds,1);
});
test('local failure with remote disabled does not download or load',async t=>{
 const f=fixture(t,{localBuild:true,remote:false});f.state.onBuild=async()=>{throw Error('no gcc')};
 const r=await f.load();assert.equal(r.status,'no-build');assert.equal(r.retryable,false);assert.equal(f.state.runs.length,0);
});
test('invalid local bytes do not get a cache receipt and fall back to verified remote',async t=>{
 const f=fixture(t,{localBuild:true});f.state.localBytes=Buffer.alloc(128);
 assert.equal((await f.load()).source,'remote');assert.ok(!fs.existsSync(path.join(f.cache,'local',K+'.json')));
});
test('local cache tampering rejected even when its receipt exists',async t=>{
 const f=fixture(t,{localBuild:true,remote:false});await f.load();f.state.loaded=false;f.state.runs=[];
 fs.appendFileSync(path.join(f.cache,'local',f.entry.asset),'bad');assert.equal((await f.load()).status,'no-build');assert.equal(f.state.runs.length,0);
});
test('changed source hash invalidates local cache receipt',async t=>{
 const f=fixture(t,{localBuild:true,remote:false});await f.load();f.state.loaded=false;f.state.runs=[];
 f.policy.local_build.files.Makefile='f'.repeat(64);assert.equal((await f.load()).status,'no-build');assert.equal(f.state.runs.length,0);
});
test('local compilation remains single-flight and cancellation blocks insmod',async t=>{
 const f=fixture(t,{localBuild:true});let finish;
 f.state.onBuild=()=>new Promise(r=>{finish=r});
 const a=f.load(),b=f.load();assert.equal(a,b);
 while(!finish)await delay(1);f.loader.cancel();finish();
 assert.equal((await a).status,'failed');assert.equal(f.state.builds,1);assert.equal(f.state.runs.length,0);assert.equal(f.state.downloads.length,0);
});
