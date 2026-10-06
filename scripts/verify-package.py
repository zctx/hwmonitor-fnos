#!/usr/bin/env python3
"""从 FPK 反向验证 payload、版本、模块策略和温控逻辑保留项。不会加载模块。"""
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
from driver_index import lock, make_entry

cfg = lock()
with tarfile.open(sys.argv[1]) as root:
    manifest = dict(line.split('=',1) for line in root.extractfile('manifest').read().decode().splitlines() if '=' in line)
    manifest = {k.strip():v.strip() for k,v in manifest.items()}
    assert manifest['version'] == cfg['PACKAGE_VERSION'], 'FPK version mismatch'
    payload = root.extractfile('app.tgz').read()
    assert hashlib.md5(payload).hexdigest() == manifest['checksum'], 'FPK app.tgz checksum mismatch'
with tempfile.TemporaryDirectory() as d:
    dest = Path(d)
    with tarfile.open(fileobj=io.BytesIO(payload)) as app:
        # Node 程序和模块只允许普通文件/目录；拒绝路径穿越与符号链接。
        for m in app.getmembers():
            if m.name.startswith('/') or '..' in Path(m.name).parts or not (m.isfile() or m.isdir()):
                raise ValueError('Unexpected archive member: '+m.name)
        app.extractall(dest)
    assert json.loads((dest/'package.json').read_text())['version'] == cfg['PACKAGE_VERSION']
    policy = json.loads((dest/'n5-driver-policy.json').read_text())
    assert set(policy['bundled']) == set(cfg['SUPPORTED_KERNELS'].split())
    for k, entry in policy['bundled'].items():
        assert make_entry(dest/'drivers/n5'/entry['asset'], k) == entry
    for f in ['driverload.js','n5-startup.js','server.js','web/app.js']:
        subprocess.run(['node','--check',str(dest/f)],check=True,timeout=10)
    server = (dest/'server.js').read_text()
    for marker in ['const nvmeHwmons = listHwmon()', 'storage fan safety floor', "chip.name === 'spd5118'",
                   'diskLastTemps', 'n5Lifecycle.stop()', "require('./n5-startup').start"]:
        assert marker in server, 'Missing application patch: ' + marker
    # 本轮没有改动 UI，按已经发布的 1.5.7 哈希断言字节一致。
    assert hashlib.sha256((dest/'web/app.js').read_bytes()).hexdigest() == 'e0b645610444366f6400cf9a2c4ecfa31fcc76d9b0409aee0f7e5c0b2aa9676c'
    assert 'execFileSync' not in (dest/'driverload.js').read_text()
print('FPK reverse verification passed; no kernel module loaded')
