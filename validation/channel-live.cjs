'use strict';
// 在隔离 CI 主机验证真实发布通道；唯一允许执行的外部命令是 modinfo。
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const {promisify}=require('util'),{execFile}=require('child_process');
const runFile=promisify(execFile);
const app=path.resolve(process.argv[2]);
const {createLoader,fetchBytes}=require(path.join(app,'driverload.js'));
const original=JSON.parse(fs.readFileSync(path.join(app,'n5-driver-policy.json'),'utf8'));
const policy={...original,bundled:{}}; // 强制走实际网络 fallback，而非内置 c1126。
const M=policy.module,K='6.18.18.c1126-trim';
const cache=fs.mkdtempSync('/var/cache/hwmonitor-validation-');
let loaded=false,offline=false,intents=0,requests=0,ticks=0;
const io={...fs,
  existsSync(p){if(p===`/sys/module/${M}`)return loaded;if(p.startsWith('/sys/class/hwmon/ci/'))return loaded;return fs.existsSync(p);},
  readdirSync(p,...a){if(p==='/sys/class/hwmon')return loaded?['ci']:[];return fs.readdirSync(p,...a);},
  readFileSync(p,...a){
    if(p===`/sys/module/${M}/version`)return policy.driver_version;
    if(p===`/sys/module/${M}/srcversion`)return policy.srcversion;
    if(p===`/sys/module/${M}/parameters/experimental_write`)return 'Y';
    if(p==='/sys/class/hwmon/ci/name')return M;
    return fs.readFileSync(p,...a);
  }
};
const loader=createLoader({fs:io,policy,appDir:app,cacheDir:cache,kernel:K,arch:'x64',remote:true,
  download:async(...a)=>{requests++;if(offline)throw Error('intentional offline test');return fetchBytes(...a);},
  run:async(cmd,args,signal)=>{
    if(path.basename(cmd)==='modinfo')return runFile(cmd,args,{encoding:'utf8',timeout:5000,signal});
    if(path.basename(cmd)==='insmod'){intents++;loaded=true;return {stdout:''};}
    if(path.basename(cmd)==='rmmod'){loaded=false;return {stdout:''};}
    throw Error('Forbidden external command');
  }
});
(async()=>{
  const timer=setInterval(()=>ticks++,10);
  try{
    let r=await loader.autoload({product_name:'N5A',board_name:'F8NAB'},console.log);
    assert.equal(r.source,'remote');assert.equal(intents,1);assert.ok(requests>=2);assert.ok(ticks>0);
    console.log('PASS live HTTPS index/module download, real modinfo, responsive event loop; insmod simulated');
    loaded=false;offline=true;const before=requests;
    r=await loader.autoload({product_name:'N5A',board_name:'F8NAB'},console.log);
    assert.equal(r.source,'cache');assert.equal(intents,2);assert.equal(requests,before);
    console.log('PASS cached load revalidated without network; insmod simulated');
    loaded=false;fs.appendFileSync(path.join(cache,`${M}-${K}.ko`),'tampered');
    r=await loader.autoload({product_name:'N5A',board_name:'F8NAB'},console.log);
    assert.equal(r.status,'failed');assert.equal(intents,2);
    console.log('PASS modified cache + offline rejected, no load attempt');
  }finally{clearInterval(timer);loader.cancel();fs.rmSync(cache,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
