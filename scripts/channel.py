#!/usr/bin/env python3
"""v2 驱动通道：缺失版本全集、严格读取失败、不可变模块、索引最后发布。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from driver_index import FAMILY, MODULE, lock, make_entry, merge_index, validate_index, validate_entry, write_json

ORIGIN = 'https://api.github.com'
ALLOWED = {'github.com', 'release-assets.githubusercontent.com',
           'objects.githubusercontent.com', 'github-releases.githubusercontent.com'}

class CheckedRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        check_download_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)

def check_download_url(url):
    u = urllib.parse.urlsplit(url)
    if u.scheme != 'https' or u.hostname not in ALLOWED or u.username or u.password or u.port not in (None,443):
        raise ValueError('Unapproved asset URL')

def public_download(url, limit):
    check_download_url(url)
    req=urllib.request.Request(url, headers={'User-Agent':'hwmonitor-fnos','Accept-Encoding':'identity'})
    with urllib.request.build_opener(CheckedRedirect()).open(req, timeout=30) as r:
        data=r.read(limit+1)
        if len(data)>limit:
            raise ValueError('Asset too large')
        return data

def api(endpoint, method='GET', data=None, missing=False, binary=False):
    host = 'https://uploads.github.com' if binary else ORIGIN
    headers={'Accept':'application/vnd.github+json','User-Agent':'hwmonitor-fnos',
             'Authorization':'Bearer '+os.environ['GH_TOKEN'],
             'Content-Type':'application/octet-stream' if binary else 'application/json'}
    raw = data if binary else (json.dumps(data).encode() if data is not None else None)
    req=urllib.request.Request(host+endpoint, data=raw, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            body=r.read(4*1024*1024+1)
            if len(body)>4*1024*1024:
                raise ValueError('API response too large')
            return json.loads(body) if body else None
    except urllib.error.HTTPError as e:
        if missing and e.code==404:
            return None
        raise

def missing_kernels(items, index, floor=1032):
    validate_index(index)
    found=set()
    for item in items:
        name=item.get('name','')
        if name.endswith('_amd64.dockerfile'):
            k=name.removesuffix('_amd64.dockerfile')
            if FAMILY.fullmatch(k) and int(k.split('.c')[1].split('-')[0])>=floor:
                found.add(k)
    result=sorted(found-index['modules'].keys(), key=lambda k:int(k.split('.c')[1].split('-')[0]))
    if len(result)>32:
        raise ValueError('Too many new kernels; manual review required')
    return result

def asset_map(release):
    result={}
    for a in release['assets']:
        if a['name'] in result:
            raise ValueError('Duplicate release asset')
        result[a['name']]=a
    return result

def check_assets(index, assets):
    for e in index['modules'].values():
        a=assets.get(e['asset'])
        if not a or a.get('state')!='uploaded' or a.get('size')!=e['size'] or a.get('digest')!='sha256:'+e['sha256']:
            raise ValueError('Published asset missing or mismatched: '+e['asset'])

def state(repo, tag):
    release=api(f'/repos/{repo}/releases/tags/{tag}',missing=True)
    if release is None:
        return None, {'schema':2,'modules':{}}, None
    assets=asset_map(release)
    a=assets.get('driver-index.json')
    if not a:
        # 只有未公开的首次上传草稿可恢复；已公开通道绝不以空索引覆盖。
        if release.get('draft'):
            return release, {'schema':2,'modules':{}}, None
        raise ValueError('Published channel has no index; refusing reset')
    if release.get('draft'):
        with tempfile.TemporaryDirectory() as tmp:
            subprocess.run(['gh','release','download',tag,'--repo',repo,'--pattern','driver-index.json','--dir',tmp],
                           check=True,timeout=60,capture_output=True)
            raw=(Path(tmp)/'driver-index.json').read_bytes()
            if len(raw)>512*1024: raise ValueError('Draft index too large')
    else:
        raw=public_download(f'https://github.com/{repo}/releases/download/{tag}/driver-index.json',512*1024)
    if a.get('digest')!='sha256:'+hashlib.sha256(raw).hexdigest():
        raise ValueError('Index asset digest mismatch')
    idx=validate_index(json.loads(raw))
    check_assets(idx, assets)
    return release,idx,raw

def upload(repo, release_id, file_name, raw):
    endpoint=f'/repos/{repo}/releases/{release_id}/assets?name='+urllib.parse.quote(file_name,safe='')
    result=api(endpoint,'POST',raw,binary=True)
    if result.get('state')!='uploaded' or result.get('size')!=len(raw) or result.get('digest')!='sha256:'+hashlib.sha256(raw).hexdigest():
        raise ValueError('Uploaded asset failed digest/size verification')
    return result

def plan(out):
    cfg=lock();repo=os.environ['GITHUB_REPOSITORY']
    _,idx,_=state(repo,cfg['DRIVER_CHANNEL'])
    tip=api('/repos/GreenDamTan/DockerFile/commits/dev')['sha']
    if not re.fullmatch('[a-f0-9]{40}',tip):
        raise ValueError('Invalid metadata revision')
    items=api('/repos/GreenDamTan/DockerFile/contents/fnOS/buildKernelModulesEnv?ref='+tip)
    kernels=missing_kernels(items,idx)
    write_json(out,dict(metadata_ref=tip,kernels=kernels,build_image=cfg['BUILD_IMAGE']))
    return kernels,tip,cfg['BUILD_IMAGE']

def publish(directory):
    cfg=lock();repo=os.environ['GITHUB_REPOSITORY'];tag=cfg['DRIVER_CHANNEL']
    entries=[];files={};source=None
    for ep in sorted(Path(directory).glob('**/entry.json')):
        e=json.loads(ep.read_text());validate_entry(e,e.get('kernel',''))
        file=ep.parent/e['asset']
        if make_entry(file,e['kernel'])!=e:
            raise ValueError('Build artifact identity mismatch')
        entries.append(e);files[e['asset']]=file.read_bytes()
        src=(ep.parent/'driver-source.tar.gz').read_bytes()
        if source is not None and source!=src:
            raise ValueError('Driver source archives differ across kernel builds')
        source=src
    if not entries:
        raise ValueError('No verified driver artifacts')
    release,old,old_raw=state(repo,tag)
    new=merge_index(old,entries)
    if release is None:
        release=api(f'/repos/{repo}/releases','POST',dict(tag_name=tag,target_commitish=os.environ['GITHUB_SHA'],
            name='N5 exact-kernel driver channel v2',draft=True,prerelease=True,
            body='Schema 2; per-kernel immutable modules. Build checks are not hardware certification.'))
    assets=asset_map(release);rid=release['id']
    files['driver-source-'+cfg['N5_DRIVER_REF']+'.tar.gz']=source
    # 所有模块和对应源码先可用。已有同名附件只允许完全相同，不使用 --clobber。
    for name,raw in files.items():
        if name in assets:
            a=assets[name]
            if a.get('state')!='uploaded' or a.get('size')!=len(raw) or a.get('digest')!='sha256:'+hashlib.sha256(raw).hexdigest():
                raise ValueError('Refuse to overwrite published/orphan asset: '+name)
        else:
            upload(repo,rid,name,raw)
    raw=(json.dumps(new,ensure_ascii=False,indent=2,sort_keys=True)+'\n').encode()
    if raw!=old_raw:
        if 'driver-index.json' in assets:
            api(f"/repos/{repo}/releases/assets/{assets['driver-index.json']['id']}",'DELETE')
        try:
            upload(repo,rid,'driver-index.json',raw)
        except Exception:
            # GitHub 同名附件替换不是原子事务；失败时尽量恢复旧索引。
            if old_raw is not None:
                current=api(f'/repos/{repo}/releases/{rid}')
                a=asset_map(current).get('driver-index.json')
                if a:
                    api(f"/repos/{repo}/releases/assets/{a['id']}",'DELETE')
                upload(repo,rid,'driver-index.json',old_raw)
            raise
    if release.get('draft'):
        api(f'/repos/{repo}/releases/{rid}','PATCH',dict(draft=False,prerelease=True,make_latest='false'))
    _,verified,_=state(repo,tag)
    if verified!=new:
        raise ValueError('Post-publication index mismatch')
    print('Published:',tag,', '.join(e['kernel'] for e in entries))

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('mode',choices=['plan','publish']);p.add_argument('path');a=p.parse_args()
    if a.mode=='publish':
        publish(a.path)
    else:
        kernels,ref,image=plan(a.path)
        with open(os.environ['GITHUB_OUTPUT'],'a') as f:
            f.write('kernels='+json.dumps(kernels,separators=(',',':'))+'\n')
            f.write('metadata_ref='+ref+'\n'+'build_image='+image+'\n')
