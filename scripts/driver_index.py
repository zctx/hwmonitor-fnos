#!/usr/bin/env python3
"""驱动策略与索引共用验证：构建、发布、缓存格式保持一致。"""
import argparse
import hashlib
import json
import re
import shlex
import subprocess
from pathlib import Path

MODULE = 'minisforum_n5_it5571'
FAMILY = re.compile(r'6\.18\.18\.c[1-9][0-9]{0,8}-trim\Z')
LIMIT = 4 * 1024 * 1024
ROOT = Path(__file__).resolve().parent.parent


def lock():
    result = {}
    for line in (ROOT / 'upstream.lock').read_text().splitlines():
        if line.strip() and not line.lstrip().startswith('#'):
            key, value = line.split('=', 1)
            tokens = shlex.split(value, comments=True)
            if len(tokens) != 1:
                raise ValueError('Invalid lock setting: ' + key)
            result[key] = tokens[0]
    return result


def validate_entry(entry, kernel, cfg=None):
    cfg = cfg or lock()
    if not FAMILY.fullmatch(kernel) or not isinstance(entry, dict):
        raise ValueError('Unsupported kernel/entry')
    expected = dict(kernel=kernel, asset=f'{MODULE}-{kernel}.ko',
                    driver_version=cfg['EXPECTED_DRIVER_VERSION'],
                    srcversion=cfg['EXPECTED_DRIVER_SRCVERSION'], driver_ref=cfg['N5_DRIVER_REF'])
    if any(entry.get(k) != v for k, v in expected.items()):
        raise ValueError('Entry identity mismatch')
    if not re.fullmatch('[0-9a-f]{64}', str(entry.get('sha256', ''))):
        raise ValueError('Invalid SHA256')
    if type(entry.get('size')) is not int or not 64 <= entry['size'] <= LIMIT:
        raise ValueError('Invalid module size')
    return entry


def validate_index(index, cfg=None):
    if not isinstance(index, dict) or index.get('schema') != 2 or type(index.get('modules')) is not dict:
        raise ValueError('Invalid index schema')
    if len(index['modules']) > 512:
        raise ValueError('Index too large')
    for kernel, entry in index['modules'].items():
        validate_entry(entry, kernel, cfg)
    return index


def merge_index(index, entries, cfg=None):
    result = json.loads(json.dumps(validate_index(index, cfg)))
    for entry in entries:
        kernel = entry.get('kernel', '')
        validate_entry(entry, kernel, cfg)
        existing = result['modules'].get(kernel)
        if existing is not None and existing != entry:
            raise ValueError('Refuse to replace an already published kernel: ' + kernel)
        result['modules'][kernel] = entry
    return result


def make_entry(file, kernel, cfg=None):
    cfg = cfg or lock()
    if not FAMILY.fullmatch(kernel):
        raise ValueError('Unsupported kernel')
    file = Path(file)
    size = file.stat().st_size
    if not 64 <= size <= LIMIT or file.suffix != '.ko' or file.is_symlink():
        raise ValueError('Invalid module file')
    raw = file.read_bytes()
    if raw[:6] != b'\x7fELF\x02\x01' or raw[16:20] != b'\x01\x00\x3e\x00':
        raise ValueError('Not an x86_64 relocatable ELF')
    info = subprocess.run(['modinfo', str(file.resolve())], text=True, check=True,
                          capture_output=True, timeout=5).stdout
    def field(key):
        m = re.search(r'^' + key + r':\s*(.*)$', info, re.M)
        return m.group(1).strip() if m else ''
    if (field('name') != MODULE or field('vermagic').split()[0] != kernel or
        field('version') != cfg['EXPECTED_DRIVER_VERSION'] or
        field('srcversion') != cfg['EXPECTED_DRIVER_SRCVERSION'] or
        not re.search(r'^parm:\s*experimental_write:', info, re.M)):
        raise ValueError('modinfo identity mismatch')
    return validate_entry(dict(kernel=kernel, asset=f'{MODULE}-{kernel}.ko', size=size,
        sha256=hashlib.sha256(raw).hexdigest(), driver_version=field('version'),
        srcversion=field('srcversion'), driver_ref=cfg['N5_DRIVER_REF']), kernel, cfg)


def write_json(file, value):
    Path(file).write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + '\n')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['entry', 'policy', 'validate'])
    parser.add_argument('path')
    parser.add_argument('output', nargs='?')
    args = parser.parse_args()
    cfg = lock()
    if args.mode == 'validate':
        validate_index(json.loads(Path(args.path).read_text()))
    elif args.mode == 'entry':
        file = Path(args.path)
        kernel = file.name.removeprefix(MODULE + '-').removesuffix('.ko')
        write_json(args.output, make_entry(file, kernel, cfg))
    else:
        bundle = Path(args.path) / 'drivers' / 'n5'
        kernels = cfg['SUPPORTED_KERNELS'].split()
        entries = {k: make_entry(bundle / f'{MODULE}-{k}.ko', k, cfg) for k in kernels}
        write_json(Path(args.path) / 'n5-driver-policy.json', dict(schema=2, module=MODULE,
            driver_version=cfg['EXPECTED_DRIVER_VERSION'], srcversion=cfg['EXPECTED_DRIVER_SRCVERSION'],
            driver_ref=cfg['N5_DRIVER_REF'], channel=cfg['DRIVER_CHANNEL'], bundled=entries))

if __name__ == '__main__':
    main()
