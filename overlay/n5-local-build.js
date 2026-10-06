'use strict';
// 只消费已安装的精确内核构建树；不联网、不安装依赖、不修改模块树。
// 这不是 sandbox：信任 root 管理的宿主工具链和 Kbuild 文件。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const MODULE = 'minisforum_n5_it5571';
const FILES = ['Makefile', MODULE + '.c'];
const MAX_OUTPUT = 256 * 1024;
const MAX_MODULE = 4 * 1024 * 1024;
const BUILD_TIMEOUT = 120000;
const TOOL_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

// 独立进程组保证超时/停止时同时结束 make、gcc 及其后代；不经过 shell 拼命令。
function runGroup(cmd, args, { cwd, env, signal, timeout = BUILD_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new Error('本机编译已取消'));
    let child, timer, error, bytes = 0, chunks = [];
    const stop = reason => {
      if (!error) error = reason;
      if (child && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (e) {
          if (e.code !== 'ESRCH') child.kill('SIGKILL');
        }
      }
    };
    const abort = () => stop(new Error('本机编译已取消'));
    const clean = () => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', abort); };
    try {
      child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      if (signal) signal.addEventListener('abort', abort, { once: true });
      if (signal && signal.aborted) abort();
      timer = setTimeout(() => stop(new Error('本机编译超时')), timeout);
      const collect = b => {
        const room = MAX_OUTPUT - bytes;
        if (room > 0) chunks.push(b.subarray(0, room));
        bytes += b.length;
        if (bytes > MAX_OUTPUT) stop(new Error('本机编译日志超过限制'));
      };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      child.on('error', e => { error = error || e; });
      child.on('close', (code, sig) => {
        clean();
        const stdout = Buffer.concat(chunks).toString('utf8');
        if (error || code !== 0) {
          const e = error || new Error('构建命令失败: ' + path.basename(cmd) + ' (' + (sig || code) + ')');
          e.output = stdout;
          reject(e);
        } else resolve({ stdout });
      });
    } catch (e) { clean(); reject(e); }
  });
}

function createLocalBuilder({ appDir, cacheDir, kernel, policy, fs: io = fs,
  owner = 0, run = runGroup, headerPaths, tools = ['/usr/bin', '/bin'] }) {
  const cfg = policy.local_build;
  function guard(signal) { if (signal && signal.aborted) throw new Error('本机编译已取消'); }
  // 允许 /lib -> /usr/lib、build -> /usr/src/... 这类系统链接，但目标和父目录必须可信。
  function trusted(file, kind) {
    const real = io.realpathSync(file);
    let p = real;
    for (;;) {
      const s = io.lstatSync(p);
      if (s.uid !== owner || (s.mode & 0o022) || s.isSymbolicLink()) throw new Error('构建路径权限不可信: ' + p);
      if (p === real && (kind === 'file' ? !s.isFile() : !s.isDirectory())) throw new Error('构建路径类型无效: ' + p);
      if (p !== real && !s.isDirectory()) throw new Error('构建父目录无效: ' + p);
      const parent = path.dirname(p);
      if (parent === p) break;
      p = parent;
    }
    return real;
  }
  function read(file, limit = 4 * 1024 * 1024) {
    const real = trusted(file, 'file');
    const fd = io.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const s = io.fstatSync(fd);
      if (!s.isFile() || s.uid !== owner || (s.mode & 0o022) || s.size < 1 || s.size > limit) {
        throw new Error('构建输入为空、过大或权限不符: ' + file);
      }
      return io.readFileSync(fd);
    } finally { io.closeSync(fd); }
  }

  // fnOS 会给 /volX/@appcenter/<app> 添加 group-write/ACL。应用源码和策略都属于
  // 同一 FPK 信任边界，因此不能套用宿主 Kbuild 的“父目录不可写”规则，否则会在
  // 真机安装目录误拒。这里仅接受 appDir 内的普通非 symlink 文件，并对实际读取的
  // 字节做随包 SHA256 校验；宿主 headers/GCC/ld/cache 仍使用 trusted() 严格检查。
  function packagedSource(file, root, limit = 1024 * 1024) {
    const appRoot = io.realpathSync(root);
    const sourceRoot = io.realpathSync(path.join(root, 'drivers', 'n5-src'));
    if (sourceRoot !== path.join(appRoot, 'drivers', 'n5-src')) {
      throw new Error('本机编译源码目录必须位于应用安装目录内');
    }
    const lst = io.lstatSync(file);
    if (lst.isSymbolicLink() || !lst.isFile()) throw new Error('本机编译源码必须是普通非符号链接文件');
    const real = io.realpathSync(file);
    if (path.dirname(real) !== sourceRoot) throw new Error('本机编译源码越出应用目录');
    const fd = io.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const s = io.fstatSync(fd);
      if (!s.isFile() || s.size < 1 || s.size > limit) throw new Error('本机编译源码大小/类型无效: ' + path.basename(file));
      return io.readFileSync(fd);
    } finally { io.closeSync(fd); }
  }
  function tool(name) {
    for (const dir of tools) {
      try {
        const f = trusted(path.join(dir, name), 'file'); io.accessSync(f, fs.constants.X_OK); return f;
      } catch (_) { /* 不采用其他 PATH 下的未知程序 */ }
    }
    throw new Error('缺少现有构建工具: ' + name);
  }
  function sources() {
    if (!cfg || !cfg.files || Object.keys(cfg.files).sort().join(',') !== FILES.slice().sort().join(',')) {
      throw new Error('安装包缺少有效的本机编译源码策略');
    }
    const dir = path.join(appDir, 'drivers', 'n5-src');
    const out = {};
    for (const name of FILES) {
      const f = path.join(dir, name);
      const b = packagedSource(f, appDir);
      if (!/^[a-f0-9]{64}$/.test(cfg.files[name]) || crypto.createHash('sha256').update(b).digest('hex') !== cfg.files[name]) {
        throw new Error('本机编译源码 SHA256 不符: ' + name);
      }
      out[name] = b;
    }
    return out;
  }
  function headers() {
    const candidates = headerPaths || ['/lib/modules/' + kernel + '/build', '/usr/src/linux-headers-' + kernel];
    // 存在但不匹配的首选路径直接拒绝，不能悄悄换到另一棵同名构建树。
    const item = candidates.find(p => { try { io.lstatSync(p); return true; } catch (e) { if (e.code !== 'ENOENT') throw e; return false; } });
    if (!item) throw new Error('缺少当前内核构建树: ' + kernel);
    const dir = trusted(item, 'dir');
    if (!/^\/[A-Za-z0-9_./+-]+$/.test(dir)) throw new Error('构建树路径含不支持的字符');
    const values = {};
    for (const name of ['Makefile', 'Module.symvers', 'include/config/kernel.release', 'include/config/auto.conf',
      'include/generated/autoconf.h', 'include/generated/utsrelease.h', 'scripts/Makefile.build']) {
      values[name] = read(path.join(dir, name));
    }
    if (values['include/config/kernel.release'].toString().trim() !== kernel ||
        !values['include/generated/utsrelease.h'].toString().split('\n').some(l => l.trim() === '#define UTS_RELEASE "' + kernel + '"')) {
      throw new Error('构建树 release 与运行内核不匹配');
    }
    const conf = values['include/config/auto.conf'].toString();
    for (const option of ['CONFIG_MODULES=y', 'CONFIG_X86_64=y', 'CONFIG_CC_IS_GCC=y']) {
      if (!conf.split('\n').includes(option)) throw new Error('不支持的内核构建配置: ' + option);
    }
    const m = conf.match(/^CONFIG_GCC_VERSION=(\d+)$/m);
    if (!m) throw new Error('缺少内核 GCC 版本信息');
    return { dir, gccVersion: Number(m[1]), symvers_sha256: crypto.createHash('sha256').update(values['Module.symvers']).digest('hex') };
  }
  const environment = home => ({ PATH: TOOL_PATH, LANG: 'C', LC_ALL: 'C', HOME: home, TMPDIR: home });
  async function compiler(h, signal) {
    const major = Math.floor(h.gccVersion / 10000);
    for (const name of ['gcc-' + major, 'x86_64-linux-gnu-gcc-' + major, 'gcc', 'x86_64-linux-gnu-gcc']) {
      guard(signal);
      let f;
      try { f = tool(name); } catch (_) { continue; }
      const r = await run(f, ['-dumpfullversion'], { signal, env: environment('/'), timeout: 5000 });
      const m = r.stdout.trim().match(/^(\d+)\.(\d+)(?:\.(\d+))?$/);
      if (m && Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3] || 0) === h.gccVersion) return f;
    }
    throw new Error('没有与内核 GCC_VERSION=' + h.gccVersion + ' 一致的现有编译器');
  }
  function saveLog(text) {
    const temp = path.join(cacheDir, '.build-log-' + crypto.randomBytes(12).toString('hex'));
    try {
      io.writeFileSync(temp, text.slice(-MAX_OUTPUT), { flag: 'wx', mode: 0o600 });
      io.renameSync(temp, path.join(cacheDir, 'local-build.log'));
    } finally { try { io.unlinkSync(temp); } catch (_) { /* renamed */ } }
  }
  async function build(signal, log) {
    guard(signal);
    const src = sources();
    const h = headers();
    const make = tool('make'), ld = tool('ld');
    const cc = await compiler(h, signal);
    guard(signal);
    trusted(cacheDir, 'dir');
    const work = io.mkdtempSync(path.join(cacheDir, '.local-build-'));
    io.chmodSync(work, 0o700);
    let output = '';
    try {
      for (const [name, raw] of Object.entries(src)) io.writeFileSync(path.join(work, name), raw, { flag: 'wx', mode: 0o600 });
      const args = ['-j2', '-C', h.dir, 'M=' + work, 'CC=' + cc, 'HOSTCC=' + cc, 'LD=' + ld, 'modules'];
      if (log) log('N5 本机编译开始: ' + kernel + '，使用现有 headers 与 ' + path.basename(cc));
      const r = await run(make, args, { cwd: work, env: environment(work), signal, timeout: BUILD_TIMEOUT });
      output = r.stdout;
      guard(signal);
      const file = path.join(work, MODULE + '.ko');
      if (io.lstatSync(file).isSymbolicLink()) throw new Error('本机编译输出不能是符号链接');
      const bytes = read(file, MAX_MODULE);
      saveLog('kernel=' + kernel + '\nheaders=' + h.dir + '\ncompiler=' + cc + '\n' + output);
      return { bytes, headers: h.dir, compiler: cc, symvers_sha256: h.symvers_sha256 };
    } catch (e) {
      output = e.output || output;
      try { saveLog('kernel=' + kernel + '\nERROR: ' + e.message + '\n' + output); } catch (_) { /* retain original error */ }
      throw e;
    } finally {
      io.rmSync(work, { recursive: true, force: true });
    }
  }
  return { build };
}
module.exports = { createLocalBuilder, runGroup, BUILD_TIMEOUT, MAX_OUTPUT };
