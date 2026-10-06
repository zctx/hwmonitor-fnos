import copy
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from driver_index import lock, validate_entry, validate_index, merge_index, make_entry
from fnos_headers import parse_recipe
from channel import missing_kernels, check_assets, state, check_download_url, publish

K='6.18.18.c1126-trim'
CFG=lock()
def entry(k=K):
    return dict(kernel=k,asset='minisforum_n5_it5571-'+k+'.ko',size=128,sha256='a'*64,
        driver_version=CFG['EXPECTED_DRIVER_VERSION'],srcversion=CFG['EXPECTED_DRIVER_SRCVERSION'],driver_ref=CFG['N5_DRIVER_REF'])
def recipe():
    return '\n'.join(['FROM unused', 'ENV BaseURL="https://download.liveupdate.fnnas.com/x86/kernel"',
       f'ENV PKG="linux-headers-{K}_{K}-1126_amd64.deb"', 'ENV dlkey="abcdefgh1234abcd="',
       '# "sign": "'+'a'*64+'",'])

class HeaderTests(unittest.TestCase):
    def test_exact_recipe(self): self.assertEqual(parse_recipe(recipe(),K)['EXPECTED_SHA'],'a'*64)
    def test_missing_hash(self):
        with self.assertRaises(ValueError): parse_recipe(recipe().split('#')[0],K)
    def test_ambiguous_hash(self):
        with self.assertRaises(ValueError): parse_recipe(recipe()+'\n# "sign": "'+'b'*64+'"',K)
    def test_wrong_kernel(self):
        with self.assertRaises(ValueError): parse_recipe(recipe(),'6.18.18.c11260-trim')
    def test_wrong_arch(self):
        with self.assertRaises(ValueError): parse_recipe(recipe().replace('_amd64.deb','_arm64.deb'),K)
    def test_wrong_host(self):
        with self.assertRaises(ValueError): parse_recipe(recipe().replace('download.liveupdate.fnnas.com','example.com'),K)
    def test_http_downgrade(self):
        with self.assertRaises(ValueError): parse_recipe(recipe().replace('https:','http:'),K)
    def test_env_duplicates(self):
        with self.assertRaises(ValueError): parse_recipe(recipe()+'\nENV dlkey="abcdefgh1234abcd="',K)
    def test_shell_injection_is_not_executed(self):
        with self.assertRaises(ValueError): parse_recipe(recipe().replace('abcdefgh1234abcd=','$(touch /tmp/review-must-not-exist)'),K)
    def test_unsupported_family(self):
        with self.assertRaises(ValueError): parse_recipe(recipe(),'6.19.0-trim')

class IndexTests(unittest.TestCase):
    def test_entry(self): self.assertEqual(validate_entry(entry(),K),entry())
    def test_wrong_asset(self):
        e=entry();e['asset']='../other.ko'
        with self.assertRaises(ValueError): validate_entry(e,K)
    def test_wrong_identity(self):
        for key in ['kernel','driver_ref','driver_version','srcversion']:
            with self.subTest(key=key):
                e=entry();e[key]='wrong'
                with self.assertRaises(ValueError): validate_entry(e,K)
    def test_size_limits(self):
        for size in [True,0,-1,4*1024*1024+1,'128']:
            e=entry();e['size']=size
            with self.assertRaises(ValueError): validate_entry(e,K)
    def test_schema_failure(self):
        for i in [None,{}, {'schema':1,'modules':{}},{'schema':2,'modules':[]}]:
            with self.assertRaises(ValueError): validate_index(i)
    def test_merge_preserves_old(self):
        old={'schema':2,'modules':{'6.18.18.c1032-trim':entry('6.18.18.c1032-trim')}}
        got=merge_index(old,[entry()]);self.assertEqual(len(got['modules']),2);self.assertEqual(len(old['modules']),1)
    def test_refuse_overwrite(self):
        old={'schema':2,'modules':{K:entry()}};e=entry();e['sha256']='b'*64
        with self.assertRaises(ValueError): merge_index(old,[e])
    def test_idempotent_merge(self):
        old={'schema':2,'modules':{K:entry()}};self.assertEqual(merge_index(old,[entry()]),old)
    def test_all_missing_not_just_latest(self):
        names=[{'name':f'6.18.18.c{n}-trim_amd64.dockerfile'} for n in [938,1032,1078,1126]]
        names.append({'name':'6.19.0-trim_amd64.dockerfile'})
        self.assertEqual(missing_kernels(names,{'schema':2,'modules':{'6.18.18.c1032-trim':entry('6.18.18.c1032-trim')}}),['6.18.18.c1078-trim',K])
    def test_asset_checks(self):
        idx={'schema':2,'modules':{K:entry()}}
        with self.assertRaises(ValueError): check_assets(idx,{})
        a=dict(state='uploaded',size=128,digest='sha256:'+'a'*64)
        check_assets(idx,{entry()['asset']:a})
        a['digest']='sha256:'+'b'*64
        with self.assertRaises(ValueError): check_assets(idx,{entry()['asset']:a})
    def test_publication_read_failure_cannot_reset(self):
        with patch('channel.api',side_effect=RuntimeError('network failure')):
            with self.assertRaises(RuntimeError): state('zctx/hwmonitor-fnos','kernel-modules-v2')
    def test_only_not_found_initializes(self):
        with patch('channel.api',return_value=None):
            self.assertEqual(state('zctx/hwmonitor-fnos','kernel-modules-v2')[1],{'schema':2,'modules':{}})
    def test_published_index_missing_fails(self):
        with patch('channel.api',return_value={'draft':False,'assets':[]}):
            with self.assertRaises(ValueError): state('zctx/hwmonitor-fnos','kernel-modules-v2')
    def test_download_origin(self):
        check_download_url('https://github.com/zctx/hwmonitor-fnos/releases/download/kernel-modules-v2/driver-index.json')
        for u in ['http://github.com/a','https://evil.example/a','https://user@github.com/a','https://github.com:444/a']:
            with self.assertRaises(ValueError): check_download_url(u)
    @unittest.skipUnless(os.environ.get('HWMON_TEST_KO'),'requires built .ko; never loads it')
    def test_real_built_module(self):
        e=make_entry(os.environ['HWMON_TEST_KO'],K)
        self.assertEqual(e['srcversion'],CFG['EXPECTED_DRIVER_SRCVERSION'])

class ApplicationTests(unittest.TestCase):
    @unittest.skipUnless(os.environ.get('HWMON_TEST_APP'),'requires patched upstream app')
    def test_ui_unchanged_and_lifecycle_guard(self):
        app=Path(os.environ['HWMON_TEST_APP']);s=(app/'server.js').read_text()
        self.assertEqual(hashlib.sha256((app/'web/app.js').read_bytes()).hexdigest(),
            'e0b645610444366f6400cf9a2c4ecfa31fcc76d9b0409aee0f7e5c0b2aa9676c')
        self.assertIn('reconcile: state => { n5Driver = state; reconcileOnBoot(true); }',s)
        self.assertIn("if (fan.chip === 'minisforum_n5_it5571' && !n5Ready) continue;",s)
        self.assertIn('n5Lifecycle.stop()',s)
        self.assertNotIn('n5DriverRetry = setInterval',s)
        self.assertIn('target = Math.max(target, 77)',s)
        self.assertIn('const nvmeHwmons = listHwmon()',s)
        self.assertIn("chip.name === 'spd5118'",s)


class PublishTests(unittest.TestCase):
    def setup_artifact(self, root):
        d=Path(root)/'driver';d.mkdir();e=entry()
        (d/'entry.json').write_text(json.dumps(e));(d/e['asset']).write_bytes(b'fake-ko')
        (d/'driver-source.tar.gz').write_bytes(b'fake-source')
        return e
    def test_modules_and_source_before_index(self):
        with tempfile.TemporaryDirectory() as td:
            e=self.setup_artifact(td);old={'schema':2,'modules':{}}
            new=merge_index(old,[e]);events=[]
            rel={'id':1,'draft':False,'assets':[{'id':7,'name':'driver-index.json'}]}
            def up(repo,rid,name,raw): events.append(('upload',name));return {}
            def api_mock(ep,method='GET',*args,**kwargs): events.append((method,ep));return {'assets':[]}
            with patch.dict(os.environ,{'GITHUB_REPOSITORY':'zctx/hwmonitor-fnos','GITHUB_SHA':'1'*40}), \
                 patch('channel.make_entry',return_value=e),patch('channel.state',side_effect=[(rel,old,b'old'),(rel,new,b'new')]), \
                 patch('channel.upload',side_effect=up),patch('channel.api',side_effect=api_mock):
                publish(td)
            self.assertEqual(events[0],('upload',e['asset']))
            self.assertTrue(events[1][1].startswith('driver-source-'))
            self.assertEqual(events[2][0],'DELETE')
            self.assertEqual(events[3],('upload','driver-index.json'))
    def test_index_failure_restores_old(self):
        with tempfile.TemporaryDirectory() as td:
            e=self.setup_artifact(td);old={'schema':2,'modules':{}};writes=[]
            rel={'id':1,'draft':False,'assets':[{'id':7,'name':'driver-index.json'}]}
            def up(repo,rid,name,raw):
                writes.append((name,raw))
                if name=='driver-index.json' and raw!=b'old': raise RuntimeError('upload failed')
            with patch.dict(os.environ,{'GITHUB_REPOSITORY':'zctx/hwmonitor-fnos'}), \
                 patch('channel.make_entry',return_value=e),patch('channel.state',return_value=(rel,old,b'old')), \
                 patch('channel.upload',side_effect=up),patch('channel.api',return_value={'assets':[]}):
                with self.assertRaises(RuntimeError): publish(td)
            self.assertEqual(writes[-1],('driver-index.json',b'old'))
    def test_existing_kernel_cannot_change_bytes(self):
        with tempfile.TemporaryDirectory() as td:
            e=self.setup_artifact(td);prior=copy.deepcopy(e);prior['sha256']='b'*64
            rel={'id':1,'draft':False,'assets':[]};old={'schema':2,'modules':{K:prior}}
            with patch.dict(os.environ,{'GITHUB_REPOSITORY':'zctx/hwmonitor-fnos'}), \
                 patch('channel.make_entry',return_value=e),patch('channel.state',return_value=(rel,old,b'old')), \
                 patch('channel.upload') as up:
                with self.assertRaises(ValueError): publish(td)
                up.assert_not_called()
    def test_partial_orphan_asset_cannot_be_overwritten(self):
        with tempfile.TemporaryDirectory() as td:
            e=self.setup_artifact(td);rel={'id':1,'draft':False,'assets':[{'name':e['asset'],'size':1,'digest':'wrong'}]}
            with patch.dict(os.environ,{'GITHUB_REPOSITORY':'zctx/hwmonitor-fnos'}), \
                 patch('channel.make_entry',return_value=e),patch('channel.state',return_value=(rel,{'schema':2,'modules':{}},b'old')), \
                 patch('channel.upload') as up:
                with self.assertRaises(ValueError): publish(td)
                up.assert_not_called()

if __name__=='__main__': unittest.main()
