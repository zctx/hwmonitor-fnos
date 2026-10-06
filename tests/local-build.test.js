'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { createLocalBuilder, runGroup, MAX_OUTPUT } = require('../overlay/n5-local-build');
const K = '6.18.18.c1126-trim', M = 'minisforum_n5_it5571';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-build-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, 'app'), cache = path.join(root, 'cache'), headers = path.join(root, 'headers'), bin = path.join(root, 'bin');
  const src = path.join(app, 'drivers/n5-src');
  for (const d of [src, cache, headers, bin]) fs.mkdirSync(d, { recursive: true });
  const inputs = { Makefile: 'obj-m += ' + M + '.o\n', [M + '.c']: '/* fixture, never loaded */\n' };
  const files = {};
  for (const [n, text] of Object.entries(inputs)) {
    fs.writeFileSync(path.join(src, n), text); files[n] = crypto.createHash('sha256').update(text).digest('hex');
  }
  for (const [n, text] of Object.entries({
    Makefile: '# trusted Kbuild fixture\n', 'Module.symvers': '0xabcd symbol module EXPORT_SYMBOL\n',
    'include/config/kernel.release': K + '\n',
    'include/config/auto.conf': 'CONFIG_MODULES=y\nCONFIG_X86_64=y\nCONFIG_CC_IS_GCC=y\nCONFIG_GCC_VERSION=120200\n',
    'include/generated/autoconf.h': '#define CONFIG_MODULES 1\n',
    'include/generated/utsrelease.h': '#define UTS_RELEASE "' + K + '"\n',
    'scripts/Makefile.build': '# trusted scripts\n'
  })) {
    const f = path.join(headers, n); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text);
  }
  for (const name of ['make', 'ld', 'gcc-12']) fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const state = { calls: [], version: '12.2.0', output: Buffer.alloc(128, 1) };
  const io = { ...fs, lstatSync(p) {
    const s = fs.lstatSync(p);
    if (p !== root && root.startsWith(p + path.sep)) { s.uid = process.getuid(); s.mode &= ~0o022; }
    return s;
  } };
  const run = async (cmd, args, opts) => {
    state.calls.push({ cmd, args, opts });
    if (args[0] === '-dumpfullversion') return { stdout: state.version + '\n' };
    if (state.error) throw Object.assign(new Error(state.error), { output: 'compiler diagnostic\n' });
    if (state.wait) await state.wait(opts.signal);
    if (!state.noOutput) fs.writeFileSync(path.join(opts.cwd, M + '.ko'), state.output);
    if (state.symlinkOutput) { fs.unlinkSync(path.join(opts.cwd, M + '.ko')); fs.symlinkSync('/etc/passwd', path.join(opts.cwd, M + '.ko')); }
    return { stdout: 'compile ok\n' };
  };
  const policy = { local_build: { files } };
  const builder = createLocalBuilder({ appDir: app, cacheDir: cache, kernel: K, policy,
    fs: io, owner: process.getuid(), headerPaths: [headers], tools: [bin], run });
  return { root, app, src, cache, headers, bin, state, policy, builder,
    build: signal => builder.build(signal || new AbortController().signal) };
}
test('local build: fixed source + exact tree + matching installed GCC, no host environment inheritance', async t => {
  const f = fixture(t); process.env.MAKEFLAGS = '--eval=unsafe';
  try {
    const r = await f.build(); assert.deepEqual(r.bytes, f.state.output);
    const call = f.state.calls.at(-1);
    assert.equal(path.basename(call.cmd), 'make'); assert.deepEqual(call.args.slice(0,3), ['-j2','-C',f.headers]);
    assert.equal(call.args.at(-1),'modules'); assert.equal(call.opts.timeout,120000);
    assert.equal(call.opts.env.MAKEFLAGS,undefined); assert.equal(call.opts.env.LD_PRELOAD,undefined);
    assert.equal(call.opts.env.PATH,'/usr/bin:/bin:/usr/sbin:/sbin');
    assert.ok(!call.args.includes('modules_install'));
    assert.deepEqual(fs.readdirSync(f.cache),['local-build.log']);
  } finally { delete process.env.MAKEFLAGS; }
});
test('source tampering is rejected before any tool is executed', async t => {
  const f=fixture(t); fs.appendFileSync(path.join(f.src,M+'.c'),'bad');
  await assert.rejects(f.build(),/SHA256/); assert.equal(f.state.calls.length,0);
});
test('source symlink rejected',async t=>{
  const f=fixture(t);fs.unlinkSync(path.join(f.src,M+'.c'));fs.symlinkSync('/etc/passwd',path.join(f.src,M+'.c'));
  await assert.rejects(f.build(),/符号链接/);assert.equal(f.state.calls.length,0);
});
test('missing exact headers never runs make or installs dependencies',async t=>{
  const f=fixture(t);fs.rmSync(f.headers,{recursive:true});await assert.rejects(f.build(),/构建树/);assert.equal(f.state.calls.length,0);
});
test('incomplete tree (symvers/autoconf/scripts) fails preflight',async t=>{
  for(const name of ['Module.symvers','include/generated/autoconf.h','scripts/Makefile.build']) {
    const f=fixture(t);fs.unlinkSync(path.join(f.headers,name));await assert.rejects(f.build());assert.equal(f.state.calls.length,0);
  }
});
test('kernel.release and UTS_RELEASE both have to match',async t=>{
  for(const name of ['include/config/kernel.release','include/generated/utsrelease.h']) {
    const f=fixture(t);fs.writeFileSync(path.join(f.headers,name),'6.18.18.c9999-trim');
    await assert.rejects(f.build(),/不匹配/);assert.equal(f.state.calls.length,0);
  }
});
test('unsafe build tree or critical file permissions rejected',async t=>{
  for(const name of ['','Makefile']) {
    const f=fixture(t);fs.chmodSync(path.join(f.headers,name),0o777);
    await assert.rejects(f.build(),/权限/);assert.equal(f.state.calls.length,0);
  }
});
test('system build symlink can point to a protected exact headers tree',async t=>{
  const f=fixture(t),real=f.headers+'-real';fs.renameSync(f.headers,real);fs.symlinkSync(real,f.headers);
  const r=await f.build();assert.equal(r.headers,real);
});
test('missing compiler/make/ld skips without installing or running Kbuild',async t=>{
  for(const name of ['make','ld','gcc-12']) {
    const f=fixture(t);fs.unlinkSync(path.join(f.bin,name));await assert.rejects(f.build());
    assert.ok(f.state.calls.every(c=>c.args[0]==='-dumpfullversion'));
  }
});
test('wrong GCC version is not used for this kernel',async t=>{
  const f=fixture(t);f.state.version='14.2.0';await assert.rejects(f.build(),/GCC_VERSION/);
  assert.ok(f.state.calls.every(c=>c.args[0]==='-dumpfullversion'));
});
test('unsupported kernel configuration does not reach compiler',async t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.headers,'include/config/auto.conf'),'CONFIG_CC_IS_CLANG=y\n');
  await assert.rejects(f.build(),/配置/);assert.equal(f.state.calls.length,0);
});
test('compiler failure leaves diagnostic but removes workspace',async t=>{
  const f=fixture(t);f.state.error='compile failed';await assert.rejects(f.build(),/compile failed/);
  assert.deepEqual(fs.readdirSync(f.cache),['local-build.log']);
  assert.match(fs.readFileSync(path.join(f.cache,'local-build.log'),'utf8'),/compiler diagnostic/);
});
test('missing/oversized/symlink output is not returned as valid bytes',async t=>{
  for(const opt of [{noOutput:true},{output:Buffer.alloc(4*1024*1024+1)},{symlinkOutput:true}]) {
    const f=fixture(t);Object.assign(f.state,opt);await assert.rejects(f.build());
    assert.ok(fs.readdirSync(f.cache).every(n=>!n.startsWith('.local-build-')));
  }
});
test('cancel during make removes workspace and never returns output',async t=>{
  const f=fixture(t),c=new AbortController();f.state.wait=async()=>c.abort();
  await assert.rejects(f.build(c.signal),/取消/);
  assert.ok(fs.readdirSync(f.cache).every(n=>!n.startsWith('.local-build-')));
});
test('pre-aborted build does not run tools',async t=>{
  const f=fixture(t),c=new AbortController();c.abort();await assert.rejects(f.build(c.signal),/取消/);assert.equal(f.state.calls.length,0);
});
test('real child runner: failure, missing binary and log limit settle',async()=>{
  await assert.rejects(runGroup(process.execPath,['-e','process.exit(3)']),/失败/);
  await assert.rejects(runGroup('/no/such/program',[]),/ENOENT/);
  await assert.rejects(runGroup(process.execPath,['-e',`process.stdout.write('x'.repeat(${MAX_OUTPUT+1}));setInterval(()=>{},1000)`]),/日志/);
});
test('real timeout/cancel kills the whole compiler process group',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'build-process-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const abort of [false,true]) {
    const file=path.join(root,String(abort));
    const code=`const{spawn}=require('child_process');const fs=require('fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(file)},String(c.pid));setInterval(()=>{},1000);`;
    const c=new AbortController();
    const p=runGroup(process.execPath,['-e',code],{signal:c.signal,timeout:abort?5000:1000});
    const check=assert.rejects(p,abort?/取消/:/超时/);
    for(let n=0;n<180&&!fs.existsSync(file);n++)await new Promise(r=>setTimeout(r,5));
    assert.ok(fs.existsSync(file));const pid=Number(fs.readFileSync(file,'utf8'));
    if(abort)c.abort();await check;
    await new Promise(r=>setTimeout(r,30));
    let status='gone';try{status=fs.readFileSync('/proc/'+pid+'/stat','utf8').split(' ')[2];}catch(_){}
    assert.ok(['gone','Z','X'].includes(status),'grandchild must not keep running');
  }
});
