import hashlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from driver_index import local_source_policy, MODULE

class LocalSourcePolicyTests(unittest.TestCase):
    def setup_source(self, root):
        src=Path(root)/'drivers/n5-src';src.mkdir(parents=True)
        raw=b'/* test */\n'
        (src/(MODULE+'.c')).write_bytes(raw)
        (src/'Makefile').write_text('obj-m += '+MODULE+'.o\n')
        blob=hashlib.sha1(f'blob {len(raw)}\0'.encode()+raw).hexdigest()
        return src, {'N5_DRIVER_SOURCE_SHA1':blob}
    def test_fixed_sources_receive_hashes(self):
        with tempfile.TemporaryDirectory() as d:
            src,cfg=self.setup_source(d)
            with patch('driver_index.lock',return_value=cfg):
                p=local_source_policy(d)
            self.assertEqual(set(p['files']),{'Makefile',MODULE+'.c'})
            self.assertEqual(p['files']['Makefile'],hashlib.sha256((src/'Makefile').read_bytes()).hexdigest())
    def test_missing_source_fails(self):
        with tempfile.TemporaryDirectory() as d:
            src,cfg=self.setup_source(d);(src/(MODULE+'.c')).unlink()
            with patch('driver_index.lock',return_value=cfg),self.assertRaises(ValueError):local_source_policy(d)
    def test_wrong_driver_blob_fails(self):
        with tempfile.TemporaryDirectory() as d:
            src,cfg=self.setup_source(d);(src/(MODULE+'.c')).write_text('changed')
            with patch('driver_index.lock',return_value=cfg),self.assertRaises(ValueError):local_source_policy(d)
    def test_symlink_source_fails(self):
        with tempfile.TemporaryDirectory() as d:
            src,cfg=self.setup_source(d);(src/'Makefile').unlink();(src/'Makefile').symlink_to('/etc/passwd')
            with patch('driver_index.lock',return_value=cfg),self.assertRaises(ValueError):local_source_policy(d)
    def test_empty_makefile_fails(self):
        with tempfile.TemporaryDirectory() as d:
            src,cfg=self.setup_source(d);(src/'Makefile').write_bytes(b'')
            with patch('driver_index.lock',return_value=cfg),self.assertRaises(ValueError):local_source_policy(d)

if __name__=='__main__': unittest.main()
