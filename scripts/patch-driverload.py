#!/usr/bin/env python3
from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit('usage: patch-driverload.py <driverload.js>')

p = Path(sys.argv[1])
s = p.read_text(encoding='utf-8')

def rep(old, new, desc):
    global s
    if old not in s:
        raise SystemExit(f'{desc} anchor not found')
    s = s.replace(old, new, 1)

rep("const { execFileSync } = require('child_process');\n",
    "const { execFileSync } = require('child_process');\nconst crypto = require('crypto');\n",
    'crypto require')

rep("const DRIVER_DIR = path.join(__dirname, 'drivers', 'n5');\n",
'''const DRIVER_DIR = path.join(__dirname, 'drivers', 'n5');
const CACHE_DIR = path.join(process.env.TRIM_PKGVAR || '/tmp/hwmon-data', 'drivers', 'n5');
const REMOTE_TAG = 'kernel-modules';
const REMOTE_BASE = 'https://github.com/zctx/hwmonitor-fnos/releases/download/' + REMOTE_TAG;
const REMOTE_INDEX = REMOTE_BASE + '/driver-index.json';
const REMOTE_ENABLED = process.env.HWMON_N5_REMOTE_DRIVER !== '0';
''', 'remote constants')

old_avail = '''function availableBuilds() {
  try {
    return fs.readdirSync(DRIVER_DIR)
      .filter(f => f.startsWith(KMOD + '-') && f.endsWith('.ko'))
      .map(f => ({ kernel: f.slice((KMOD + '-').length, -3), file: path.join(DRIVER_DIR, f) }));
  } catch (e) { return []; }
}
'''
new_avail = '''function scanBuildDir(dir, source) {
  try {
    return fs.readdirSync(dir)
      .filter(f => f.startsWith(KMOD + '-') && f.endsWith('.ko'))
      .map(f => ({ kernel: f.slice((KMOD + '-').length, -3), file: path.join(dir, f), source }));
  } catch (e) { return []; }
}

function availableBuilds() {
  const out = [];
  const seen = new Set();
  for (const b of [...scanBuildDir(DRIVER_DIR, 'bundled'), ...scanBuildDir(CACHE_DIR, 'cache')]) {
    if (seen.has(b.kernel)) continue;
    seen.add(b.kernel);
    out.push(b);
  }
  return out;
}

const DOWNLOAD_JS = String.raw`
const fs=require('fs'),http=require('http'),https=require('https');
const url=process.argv[1], out=process.argv[2];
function get(u,n){
  if(n>6) process.exit(12);
  const lib=u.startsWith('https:')?https:http;
  const req=lib.get(u,{headers:{'User-Agent':'hwmonitor-fnos'}},res=>{
    if([301,302,303,307,308].includes(res.statusCode)&&res.headers.location){
      res.resume();
      return get(new URL(res.headers.location,u).toString(),n+1);
    }
    if(res.statusCode!==200){res.resume();process.exit(13);}
    const f=fs.createWriteStream(out,{mode:0o600});
    res.pipe(f);
    f.on('finish',()=>f.close(()=>process.exit(0)));
    f.on('error',()=>process.exit(14));
  });
  req.setTimeout(15000,()=>req.destroy(new Error('timeout')));
  req.on('error',()=>process.exit(15));
}
get(url,0);
`;

function downloadSync(url, out) {
  execFileSync(process.execPath, ['-e', DOWNLOAD_JS, url, out],
    { timeout: 30000, stdio: 'pipe' });
}

function sha256File(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

function verifyRemoteModule(file, kernel) {
  const modinfo = which(['/usr/sbin/modinfo', '/sbin/modinfo', '/usr/bin/modinfo', '/bin/modinfo']);
  if (!modinfo) return;
  const vermagic = execFileSync(modinfo, ['-F', 'vermagic', file], { encoding: 'utf8' }).trim();
  if (!vermagic.startsWith(kernel + ' ')) throw new Error('remote module vermagic mismatch: ' + vermagic);
  const version = execFileSync(modinfo, ['-F', 'version', file], { encoding: 'utf8' }).trim();
  if (version !== '0.2.0') throw new Error('remote module version mismatch: ' + version);
  const info = execFileSync(modinfo, [file], { encoding: 'utf8' });
  if (!/^parm:.*experimental_write:/m.test(info)) throw new Error('remote module missing experimental_write');
}

function tryRemoteBuild(kernel, log) {
  if (!REMOTE_ENABLED) return null;
  if (!/^6\\.18\\.18\\.c\\d+-trim$/.test(kernel)) return null;
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const indexTmp = path.join(CACHE_DIR, '.driver-index.json.tmp');
    downloadSync(REMOTE_INDEX, indexTmp);
    const index = JSON.parse(fs.readFileSync(indexTmp, 'utf8'));
    try { fs.unlinkSync(indexTmp); } catch (e) {}
    const ent = index && index.modules && index.modules[kernel];
    if (!ent || !ent.asset || !/^[\\w.-]+\\.ko$/.test(ent.asset) || !/^[0-9a-f]{64}$/i.test(ent.sha256 || '')) {
      if (log) log('N5 remote channel has no verified build for ' + kernel);
      return null;
    }
    const final = path.join(CACHE_DIR, ent.asset);
    if (fs.existsSync(final) && sha256File(final) === ent.sha256.toLowerCase()) {
      verifyRemoteModule(final, kernel);
      return { kernel, file: final, source: 'cache' };
    }
    const tmp = final + '.tmp';
    downloadSync(REMOTE_BASE + '/' + encodeURIComponent(ent.asset), tmp);
    const got = sha256File(tmp);
    if (got !== ent.sha256.toLowerCase()) {
      try { fs.unlinkSync(tmp); } catch (e) {}
      throw new Error('SHA256 mismatch: ' + got);
    }
    verifyRemoteModule(tmp, kernel);
    fs.renameSync(tmp, final);
    fs.chmodSync(final, 0o644);
    if (log) log('N5 driver downloaded and verified for kernel ' + kernel);
    return { kernel, file: final, source: 'remote' };
  } catch (e) {
    if (log) log('N5 remote driver fetch failed for ' + kernel + ': ' + (e.message || e));
    return null;
  }
}
'''
rep(old_avail, new_avail, 'availableBuilds')

old_nomatch = '''  const builds = availableBuilds();
  const match = builds.find(b => b.kernel === krel);
  if (!match) {
    if (log) log(`N5 detected but no bundled driver for kernel ${krel} ` +
      `(bundled: ${builds.map(b => b.kernel).join(', ') || 'none'})`);
    return { status: 'no-build', kernel: krel, have: builds.map(b => b.kernel) };
  }
'''
new_nomatch = '''  const builds = availableBuilds();
  let match = builds.find(b => b.kernel === krel);
  if (!match) match = tryRemoteBuild(krel, log);
  if (!match) {
    if (log) log(`N5 detected but no exact driver for kernel ${krel} ` +
      `(local: ${builds.map(b => b.kernel).join(', ') || 'none'})`);
    return { status: 'no-build', kernel: krel, have: builds.map(b => b.kernel), remote: REMOTE_ENABLED };
  }
'''
rep(old_nomatch, new_nomatch, 'no-match block')

old_insmod = '''  try {
    execFileSync(insmod, [match.file], { timeout: 20000, stdio: 'pipe' });
    if (log) log(`N5 driver loaded: ${path.basename(match.file)}`);
    return { status: 'loaded', kernel: krel, file: path.basename(match.file) };
'''
new_insmod = '''  const product = (dmi && dmi.product_name) || '';
  const n5AirF8nab = /^(N5A|N5 AIR)$/i.test(product) && /^F8NAB$/i.test(board);
  const insmodArgs = [match.file];
  if (n5AirF8nab) {
    insmodArgs.push('experimental_write=1');
    if (log) log('N5A/F8NAB: enabling upstream experimental_write=1');
  }

  try {
    execFileSync(insmod, insmodArgs, { timeout: 20000, stdio: 'pipe' });
    if (log) log(`N5 driver loaded: ${path.basename(match.file)} (${match.source || 'local'})`);
    return { status: 'loaded', kernel: krel, file: path.basename(match.file), source: match.source || 'local' };
'''
rep(old_insmod, new_insmod, 'insmod block')

p.write_text(s, encoding='utf-8')
