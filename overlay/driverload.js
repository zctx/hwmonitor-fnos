'use strict';
// N5 精确内核加载器。网络与 kmod 子进程均异步，不阻塞温控循环。
// 信任边界：随 FPK 安装的策略 + 指定 GitHub 仓库的 HTTPS 发布通道。
// SHA256 检查完整性，不是独立签名；不能防御仓库维护权限被攻破。
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { createLocalBuilder } = require('./n5-local-build');
const runFile = promisify(execFile);
const KMOD = 'minisforum_n5_it5571';
const KERNEL_RE = /^6\.18\.18\.c[1-9][0-9]{0,8}-trim$/;
const MAX_MODULE = 4 * 1024 * 1024;
const MAX_INDEX = 512 * 1024;
const HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com',
  'objects.githubusercontent.com', 'github-releases.githubusercontent.com']);

function checkedUrl(value) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || !HOSTS.has(u.hostname) || u.username || u.password ||
      (u.port && u.port !== '443')) throw new Error('不允许的驱动下载地址');
  return u;
}

// 总超时跨重定向累计；限制长度，拒绝 HTTP 降级、非 GitHub 跳转和中断响应。
function fetchBytes(url, limit, signal, request = https.get, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let req, response, finished = false;
    const finish = (error, bytes) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abort);
      if (response) response.destroy();
      if (req) req.destroy();
      error ? reject(error) : resolve(bytes);
    };
    const abort = () => finish(new Error('驱动下载已取消'));
    const timer = setTimeout(() => finish(new Error('驱动下载总超时')), timeoutMs);
    if (signal) signal.addEventListener('abort', abort, { once: true });
    if (signal && signal.aborted) return abort();
    function get(address, redirects) {
      if (finished) return;
      let u;
      try { u = checkedUrl(address); } catch (e) { return finish(e); }
      if (redirects > 5) return finish(new Error('驱动下载重定向过多'));
      try {
        req = request(u, { headers: { 'User-Agent': 'hwmonitor-fnos', 'Accept-Encoding': 'identity' } }, res => {
          if (finished) { res.destroy(); return; }
          response = res;
          res.on('error', e => finish(e));
          if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
            let next;
            try {
              if (!res.headers.location) throw new Error('重定向缺少地址');
              next = checkedUrl(new URL(res.headers.location, u).toString());
            } catch (e) { return finish(e); }
            res.destroy();
            return get(next.toString(), redirects + 1);
          }
          if (res.statusCode !== 200) return finish(new Error('驱动下载 HTTP ' + res.statusCode));
          const declared = res.headers['content-length'];
          if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
            return finish(new Error('驱动下载文件过大或长度无效'));
          }
          if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') {
            return finish(new Error('不接受压缩的驱动下载响应'));
          }
          let size = 0, ended = false;
          const chunks = [];
          res.on('data', data => {
            if (finished) return;
            size += data.length;
            if (size > limit) return finish(new Error('驱动下载超过大小限制'));
            chunks.push(data);
          });
          res.on('aborted', () => finish(new Error('驱动下载响应中断')));
          res.on('end', () => {
            ended = true;
            if (!res.complete || (declared !== undefined && size !== Number(declared))) {
              return finish(new Error('驱动下载响应不完整'));
            }
            finish(null, Buffer.concat(chunks));
          });
          res.on('close', () => { if (!ended) finish(new Error('驱动下载提前关闭')); });
        });
        req.on('error', e => finish(e));
      } catch (e) { finish(e); }
    }
    get(url, 0);
  });
}

function profile(dmi) {
  const product = String((dmi && dmi.product_name) || '').trim();
  const board = String((dmi && dmi.board_name) || '').trim();
  // 与锁定驱动的 DMI_EXACT_MATCH 一致，不扩大实验写权限范围。
  if (board === 'F8NAB' && ['N5A', 'N5 AIR'].includes(product)) return { write: true, experimental: true };
  if (board === 'F8NAA' && product === 'N5') return { write: true, experimental: false };
  if (board === 'F8NAA' && product === 'N5 PRO') return { write: false, experimental: false };
  return null;
}

function validateEntry(entry, kernel, policy) {
  if (!KERNEL_RE.test(kernel) || !entry || entry.kernel !== kernel ||
      entry.asset !== `${KMOD}-${kernel}.ko` || !/^[a-f0-9]{64}$/.test(entry.sha256 || '') ||
      !Number.isSafeInteger(entry.size) || entry.size < 64 || entry.size > MAX_MODULE ||
      entry.driver_version !== policy.driver_version || entry.srcversion !== policy.srcversion ||
      entry.driver_ref !== policy.driver_ref) throw new Error('驱动索引与内核/源码策略不匹配');
  return entry;
}

function createLoader(options = {}) {
  const io = options.fs || fs;
  const kernel = options.kernel || os.release();
  const arch = options.arch || os.arch();
  const owner = options.owner === undefined ? 0 : options.owner; // 仅依赖注入供测试使用。
  const base = options.appDir || __dirname;
  const bundle = path.join(base, 'drivers', 'n5');
  const cache = options.cacheDir || '/var/cache/hwmonitor-fnos/n5';
  const policy = options.policy || JSON.parse(io.readFileSync(path.join(base, 'n5-driver-policy.json'), 'utf8'));
  if (!/^[a-z0-9-]{1,64}$/.test(policy.channel || '')) throw new Error('无效驱动通道');
  const channel = 'https://github.com/zctx/hwmonitor-fnos/releases/download/' + policy.channel;
  const remote = options.remote === undefined ? process.env.HWMON_N5_REMOTE_DRIVER !== '0' : options.remote;
  const localEnabled = options.local === undefined ? process.env.HWMON_N5_LOCAL_BUILD !== '0' : options.local;
  let localAttempted = false;
  let localState = { enabled: localEnabled, status: localEnabled ? 'not-needed' : 'disabled' };
  const localDir = path.join(cache, 'local');
  const run = options.run || ((cmd, args, signal) => runFile(cmd, args,
    { encoding: 'utf8', timeout: 5000, maxBuffer: 256 * 1024, signal }));
  const download = options.download || fetchBytes;
  const signal = new AbortController();
  let pending = null, stopped = false, owned = false;
  if (policy.schema !== 2 || policy.module !== KMOD || !/^[a-f0-9]{40}$/.test(policy.driver_ref || '') ||
      !/^[A-F0-9]{1,24}$/.test(policy.srcversion || '') || !policy.bundled) throw new Error('缺少有效的随包驱动策略');

  function text(file) { try { return io.readFileSync(file, 'utf8').trim(); } catch (_) { return null; } }
  function moduleLoaded() { return io.existsSync('/sys/module/' + KMOD); }
  function command(name) {
    for (const dir of ['/usr/sbin', '/sbin', '/usr/bin', '/bin']) {
      const f = path.join(dir, name);
      try { io.accessSync(f, fs.constants.X_OK); return f; } catch (_) { /* next */ }
    }
    throw new Error(name + ' 不可用');
  }
  function guard() { if (stopped) throw new Error('加载器已停止'); }
  function privateCache(target = cache) {
    // 不从可由普通用户预先创建的 /tmp 路径取 root 内核代码。
    let dir = path.parse(target).root;
    for (const part of target.slice(dir.length).split(path.sep).filter(Boolean)) {
      dir = path.join(dir, part);
      try { io.mkdirSync(dir, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
      const st = io.lstatSync(dir);
      if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== owner || (st.mode & 0o022)) {
        throw new Error('驱动缓存父目录不可信: ' + dir);
      }
    }
    io.chmodSync(target, 0o700);
  }
  function secureRead(file, limit) {
    const fd = io.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const st = io.fstatSync(fd);
      if (!st.isFile() || st.uid !== owner || (st.mode & 0o022) || st.nlink !== 1 || st.size > limit) {
        throw new Error('驱动文件类型/权限/大小无效: ' + path.basename(file));
      }
      return io.readFileSync(fd);
    } finally { io.closeSync(fd); }
  }
  function temporary(suffix) {
    return path.join(cache, '.pending-' + process.pid + '-' + crypto.randomBytes(12).toString('hex') + suffix);
  }
  function writeNew(file, data) { io.writeFileSync(file, data, { flag: 'wx', mode: 0o600 }); }
  function remove(file) { if (file) { try { io.unlinkSync(file); } catch (_) { /* best effort */ } } }
  async function verify(file, entry) {
    guard();
    validateEntry(entry, kernel, policy);
    const bytes = secureRead(file, MAX_MODULE);
    if (bytes.length !== entry.size || crypto.createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
      throw new Error('驱动 SHA256/大小校验失败');
    }
    if (!bytes.subarray(0, 4).equals(Buffer.from([0x7f, 69, 76, 70])) || bytes[4] !== 2 || bytes[5] !== 1 ||
        bytes.readUInt16LE(16) !== 1 || bytes.readUInt16LE(18) !== 62) throw new Error('不是 x86_64 ELF 内核模块');
    const result = await run(command('modinfo'), [file], signal.signal);
    const info = result.stdout || '';
    const field = key => { const m = info.match(new RegExp('^' + key + ':\\s*(.*)$', 'm')); return m ? m[1].trim() : ''; };
    if (field('name') !== KMOD || field('version') !== policy.driver_version || field('srcversion') !== policy.srcversion ||
        field('vermagic').split(/\s+/)[0] !== kernel || !/^parm:\s*experimental_write:/m.test(info)) {
      throw new Error('驱动 modinfo 身份校验失败');
    }
    guard();
  }
  function health(p) {
    if (text('/sys/module/' + KMOD + '/version') !== policy.driver_version ||
        text('/sys/module/' + KMOD + '/srcversion') !== policy.srcversion) return '已加载模块身份不符';
    if (p.experimental && text('/sys/module/' + KMOD + '/parameters/experimental_write') !== 'Y') {
      return '已加载模块未开启 N5A 写权限';
    }
    let dirs = [];
    try { dirs = io.readdirSync('/sys/class/hwmon'); } catch (_) { /* no hwmon */ }
    for (const h of dirs) {
      const dir = '/sys/class/hwmon/' + h;
      if (text(dir + '/name') !== KMOD) continue;
      const attrs = ['temp1_input', 'temp2_input', 'temp3_input', 'temp4_input', 'fan1_input', 'fan2_input', 'fan3_input'];
      if (p.write) for (let n = 1; n <= 4; n++) attrs.push('pwm' + n, 'pwm' + n + '_enable');
      if (attrs.every(a => io.existsSync(path.join(dir, a)))) return null;
    }
    return '模块存在但没有完整的 N5 hwmon/PWM 节点';
  }
  async function localCandidate(log) {
    if (!localEnabled || !policy.local_build) return null;
    privateCache(localDir);
    const receipt = path.join(localDir, kernel + '.json');
    const file = path.join(localDir, `${KMOD}-${kernel}.ko`);
    try {
      const saved = JSON.parse(secureRead(receipt, MAX_INDEX).toString('utf8'));
      if (saved.origin !== 'local' || !saved.source_hashes ||
          !Object.entries(policy.local_build.files).every(([k, v]) => saved.source_hashes[k] === v)) {
        throw new Error('本机缓存源码策略不匹配');
      }
      await verify(file, saved.entry);
      localState = { enabled: true, status: 'cached' };
      return { file, source: 'local-cache' };
    } catch (e) {
      if (e.code !== 'ENOENT' && log) log('N5 本机缓存未通过校验: ' + e.message);
    }
    // 每次服务生命周期最多尝试一次，避免缺工具/编译失败时每五分钟重复 make。
    if (localAttempted) return null;
    localAttempted = true;
    let tmp, meta;
    try {
      const builder = options.localBuilder || createLocalBuilder({ appDir: base, cacheDir: localDir,
        kernel, policy, fs: io, owner });
      localState = { enabled: true, status: 'building' };
      const built = await builder.build(signal.signal, log);
      guard();
      const entry = { kernel, asset: `${KMOD}-${kernel}.ko`, size: built.bytes.length,
        sha256: crypto.createHash('sha256').update(built.bytes).digest('hex'),
        driver_version: policy.driver_version, srcversion: policy.srcversion, driver_ref: policy.driver_ref };
      // 本机编译时先计算新产物摘要，再以真实 modinfo 校验身份；摘要用于后续缓存完整性检查。
      tmp = path.join(localDir, '.pending-' + crypto.randomBytes(12).toString('hex') + '.ko');
      writeNew(tmp, built.bytes);
      await verify(tmp, entry);
      guard();
      io.renameSync(tmp, file); tmp = null;
      meta = path.join(localDir, '.pending-' + crypto.randomBytes(12).toString('hex') + '.json');
      writeNew(meta, JSON.stringify({ origin: 'local', source_hashes: policy.local_build.files, entry,
        headers: built.headers, compiler: built.compiler, symvers_sha256: built.symvers_sha256 }));
      io.renameSync(meta, receipt); meta = null;
      localState = { enabled: true, status: 'compiled', headers: built.headers, compiler: built.compiler };
      if (log) log('N5 本机编译产物身份校验通过，已缓存: ' + kernel);
      return { file, source: 'local-build' };
    } catch (e) {
      localState = { enabled: true, status: 'failed', error: e.message };
      if (!stopped && log) log('N5 本机编译不可用，' + (remote ? '回退远程通道: ' : '远程通道已禁用: ') + e.message);
      return null;
    } finally { remove(tmp); remove(meta); }
  }
  async function candidate(log) {
    const entry = policy.bundled[kernel];
    if (entry) {
      validateEntry(entry, kernel, policy);
      const file = path.join(bundle, entry.asset);
      await verify(file, entry);
      return { file, source: 'bundled' };
    }
    const local = await localCandidate(log);
    guard();
    if (local) return local;
    if (!remote) return null; // 禁用远程时连旧的远程缓存也不加载。
    privateCache();
    const receipt = path.join(cache, kernel + '.json');
    try {
      const saved = JSON.parse(secureRead(receipt, MAX_INDEX).toString('utf8'));
      validateEntry(saved, kernel, policy);
      const file = path.join(cache, saved.asset);
      await verify(file, saved); // 每次加载都检查，不因缓存命中跳过。
      return { file, source: 'cache' };
    } catch (e) {
      if (e.code !== 'ENOENT' && log) log('N5 缓存未通过校验: ' + e.message);
    }
    const bytes = await download(channel + '/driver-index.json', MAX_INDEX, signal.signal);
    guard();
    const index = JSON.parse(bytes.toString('utf8'));
    if (index.schema !== 2 || !index.modules || typeof index.modules !== 'object' || Array.isArray(index.modules) ||
        Object.keys(index.modules).length > 512) throw new Error('驱动索引格式无效');
    if (!Object.prototype.hasOwnProperty.call(index.modules, kernel)) return null;
    const found = validateEntry(index.modules[kernel], kernel, policy);
    const data = await download(channel + '/' + encodeURIComponent(found.asset), found.size, signal.signal);
    guard();
    let tmp, meta;
    try {
      // .ko 必须是最后的扩展名，modinfo 不识别旧版的 .ko.tmp。
      tmp = temporary('.ko');
      writeNew(tmp, data);
      await verify(tmp, found);
      guard();
      const file = path.join(cache, found.asset);
      io.renameSync(tmp, file); tmp = null;
      meta = temporary('.json');
      writeNew(meta, JSON.stringify(found));
      io.renameSync(meta, receipt); meta = null;
      return { file, source: 'remote' };
    } finally { remove(tmp); remove(meta); }
  }
  async function load(dmi, log) {
    const p = profile(dmi);
    if (!p) return { status: 'not-applicable', retryable: false };
    if (arch !== 'x64' || !KERNEL_RE.test(kernel)) {
      return { status: 'no-build', kernel, retryable: false, error: '架构/内核不在自动适配范围内' };
    }
    if (moduleLoaded()) {
      const error = health(p);
      return error ? { status: 'failed', kernel, retryable: false, error } :
        { status: 'already-loaded', kernel, retryable: false, writable: p.write };
    }
    try {
      guard();
      const item = await candidate(log);
      guard();
      if (!item) return { status: 'no-build', kernel, retryable: remote, remote, have: Object.keys(policy.bundled) };
      // 异步下载期间可能已有其他程序加载；不抢占/卸载他人的模块。
      if (moduleLoaded()) {
        const error = health(p);
        return error ? { status: 'failed', kernel, retryable: false, error } :
          { status: 'already-loaded', kernel, retryable: false, writable: p.write };
      }
      const args = [item.file];
      if (p.experimental) args.push('experimental_write=1');
      await run(command('insmod'), args, signal.signal);
      owned = true;
      guard();
      const error = health(p);
      if (error) {
        try { await run(command('rmmod'), [KMOD]); owned = false; } catch (_) { /* report failure below */ }
        return { status: 'failed', kernel, retryable: false, error };
      }
      if (log) log('N5 精确驱动已加载: ' + kernel + ' (' + item.source + ')');
      return { status: 'loaded', kernel, file: path.basename(item.file), source: item.source, retryable: false, writable: p.write };
    } catch (e) {
      if (log && !stopped) log('N5 加载失败: ' + e.message);
      return { status: 'failed', kernel, retryable: !stopped && remote && !policy.bundled[kernel] && !moduleLoaded(), error: e.message };
    }
  }
  function autoload(dmi, log) {
    if (stopped) return Promise.resolve({ status: 'failed', retryable: false, error: '加载器已停止' });
    if (!pending) pending = load(dmi, log).then(state => ({ ...state, local_build: localState })).finally(() => { pending = null; });
    return pending;
  }
  function cancel() { stopped = true; signal.abort(); }
  async function unload() {
    cancel();
    if (pending) await pending;
    if (!owned || !moduleLoaded()) return { status: 'not-owned' };
    await run(command('rmmod'), [KMOD]); owned = false;
    return { status: 'unloaded' };
  }
  return { autoload, cancel, unload, moduleLoaded,
    availableBuilds: () => Object.entries(policy.bundled).map(([k, e]) => ({ kernel: k, file: path.join(bundle, e.asset) })) };
}

// 默认实例延迟到首次调用，单元测试可注入文件系统与命令，不触碰真实内核。
let instance;
const live = () => instance || (instance = createLoader());
module.exports = { KMOD, createLoader, fetchBytes, checkedUrl, profile, validateEntry,
  autoload: (...a) => live().autoload(...a), availableBuilds: () => live().availableBuilds(),
  moduleLoaded: () => live().moduleLoaded(), cancel: () => { if (instance) instance.cancel(); },
  unload: () => live().unload() };
