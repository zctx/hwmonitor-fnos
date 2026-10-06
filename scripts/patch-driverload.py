#!/usr/bin/env python3
"""锁定上游 loader，然后安装可单独测试的加载器；不生成嵌套 JS 字符串。"""
import hashlib
from pathlib import Path
import shutil
import sys

if len(sys.argv) != 2:
    raise SystemExit('usage: patch-driverload.py <driverload.js>')
target = Path(sys.argv[1])
raw = target.read_bytes()
blob = hashlib.sha1(f'blob {len(raw)}\0'.encode() + raw).hexdigest()
if blob != '9c7ee91d86084c832fd4c74a963d90c52c1f2c09':
    raise SystemExit('driverload.js upstream identity mismatch')
overlay = Path(__file__).resolve().parent.parent / 'overlay'
for name in ['driverload.js', 'n5-startup.js']:
    shutil.copyfile(overlay / name, target.parent / name)
