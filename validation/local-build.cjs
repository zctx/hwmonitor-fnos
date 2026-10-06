'use strict';
// 在 CI 使用真实 fnOS headers/GCC/Kbuild/modinfo，但绝不执行真实 insmod/PWM。
// 仅清空测试实例的 bundled 策略以覆盖新路径；交付包的内置策略不变。
const fs = require('fs'), path = require('path'), assert = require('node:assert/strict');
const { execFile } = require('child_process');
const { promisify } = require('util');
const runFile = promisify(execFile);
const appInput = path.resolve(process.argv[2]), kernel = process.argv[3];
const M = 'minisforum_n5_it5571';
async function main() {
  assert.equal(process.getuid(), 0, 'CI must be root for production cache permission checks');
  assert.match(kernel, /^6\.18\.18\.c[1-9][0-9]*-trim$/);
  const root = fs.mkdtempSync('/var/cache/hwmonitor-local-validation-');
  try {
    const app = path.join(root, 'app'), cache = path.join(root, 'cache');
    fs.cpSync(appInput, app, { recursive: true });
    const policy = JSON.parse(fs.readFileSync(path.join(app,'n5-driver-policy.json'),'utf8'));
    policy.bundled = {};
    const { createLoader } = require(path.join(app,'driverload.js'));
    let loaded = false, loadCount = 0, downloads = 0, ticks = 0;
    const io = { ...fs,
      existsSync(p) {
        if (p === '/sys/module/' + M) return loaded;
        if (p.startsWith('/sys/class/hwmon/hwmon999/')) return loaded;
        return fs.existsSync(p);
      },
      readFileSync(p,...args) {
        if (p === '/sys/module/' + M + '/version') return loaded ? policy.driver_version : '';
        if (p === '/sys/module/' + M + '/srcversion') return loaded ? policy.srcversion : '';
        if (p === '/sys/module/' + M + '/parameters/experimental_write') return loaded ? 'Y' : 'N';
        if (p === '/sys/class/hwmon/hwmon999/name') return loaded ? M : '';
        return fs.readFileSync(p,...args);
      },
      readdirSync(p,...args) { return p === '/sys/class/hwmon' ? (loaded ? ['hwmon999'] : []) : fs.readdirSync(p,...args); }
    };
    const options = { fs:io, appDir:app, cacheDir:cache, kernel, arch:'x64', policy, local:true, remote:true,
      download: async()=>{downloads++;throw Error('Local validation must not use the network');},
      run: async(cmd,args,signal)=>{
        if (path.basename(cmd)==='modinfo') return runFile(cmd,args,{encoding:'utf8',signal,timeout:5000});
        if (path.basename(cmd)==='insmod') { assert.deepEqual(args.slice(1),['experimental_write=1']);loaded=true;loadCount++;return {stdout:''}; }
        if (path.basename(cmd)==='rmmod') { loaded=false;return {stdout:''}; }
        throw Error('Unexpected command: '+cmd);
      }
    };
    const dmi={product_name:'N5A',board_name:'F8NAB'};
    const timer=setInterval(()=>ticks++,5);
    let result;
    try { result=await createLoader(options).autoload(dmi,console.log); } finally { clearInterval(timer); }
    assert.equal(result.source,'local-build',JSON.stringify(result));
    assert.equal(result.local_build.status,'compiled');assert.equal(downloads,0);assert.equal(loadCount,1);
    assert.ok(ticks>1,'event loop must continue while Kbuild runs');
    loaded=false;
    const cached=await createLoader({...options,remote:false,
      localBuilder:{build:async()=>{throw Error('Cache hit must not rebuild');}}}).autoload(dmi);
    assert.equal(cached.source,'local-cache',JSON.stringify(cached));assert.equal(loadCount,2);
    const entryPath=path.join(cache,'local',kernel+'.json');
    const receipt=JSON.parse(fs.readFileSync(entryPath,'utf8'));
    assert.equal(receipt.origin,'local');assert.equal(receipt.entry.kernel,kernel);
    assert.equal(receipt.entry.srcversion,policy.srcversion);
    console.log('PASS real local Kbuild + real modinfo + fresh-loader offline cache: '+kernel);
    console.log('Real insmod/PWM writes: 0. Module and hwmon state are explicit test stubs.');
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
