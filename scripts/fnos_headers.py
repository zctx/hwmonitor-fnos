#!/usr/bin/env python3
"""仅解析元数据，不执行外部 Dockerfile；必须提供内核精确名称及 SHA256。"""
import json
import re
import shlex
import sys
from driver_index import FAMILY


def parse_recipe(text, kernel):
    if not FAMILY.fullmatch(kernel):
        raise ValueError('Unsupported kernel')
    def env(name):
        values = []
        for line in text.splitlines():
            fields = line.strip().split(None, 1)
            if len(fields) == 2 and fields[0] == 'ENV' and fields[1].startswith(name + '='):
                parsed = shlex.split(fields[1][len(name)+1:])
                if len(parsed) != 1:
                    raise ValueError('Invalid ENV ' + name)
                values += parsed
        if len(values) != 1:
            raise ValueError('Missing or repeated ENV ' + name)
        return values[0]
    base, pkg, key = env('BaseURL'), env('PKG'), env('dlkey')
    if base not in ['https://download.liveupdate.fnnas.com/x86/kernel',
                    'https://download.liveupdate.fnnas.com/x86_64/kernel']:
        raise ValueError('Header package is not on the approved fnOS origin')
    build = re.search(r'\.c(\d+)-', kernel).group(1)
    if pkg != f'linux-headers-{kernel}_{kernel}-{build}_amd64.deb':
        raise ValueError('Header package/kernel/architecture mismatch')
    if not re.fullmatch(r'[A-Za-z0-9+/]{8,256}={0,2}', key):
        raise ValueError('Invalid download key encoding')
    hashes = re.findall(r'^\s*#\s*"sign"\s*:\s*"([a-f0-9]{64})"', text, re.M)
    if len(hashes) != 1:
        raise ValueError('Missing/ambiguous required SHA256')
    return {'BASE_URL': base, 'PKG': pkg, 'DLKEY': key, 'EXPECTED_SHA': hashes[0]}


if __name__ == '__main__':
    src, kernel, output = sys.argv[1:]
    with open(src, encoding='utf-8') as f:
        result = parse_recipe(f.read(), kernel)
    with open(output, 'w', encoding='utf-8') as f:
        for k, v in result.items():
            f.write(f'{k}={shlex.quote(v)}\n')
