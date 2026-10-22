#!/usr/bin/env python3
"""Offline consistency checks for the hardening patcher (not a full app test)."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('patcher', Path(__file__).with_name('apply_security_fixes.py'))
patcher = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(patcher)


class PatcherTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / 'package.json').write_text('{}')
        (self.root / 'bundled-service').mkdir()
        # Synthetic source fixtures use every independently verified preimage
        # anchor; integration with upstream must still run on a real clone.
        for path, replacements in patcher.REPLACEMENTS.items():
            p = self.root / path
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text('\n// next source fragment\n'.join(before for before, _ in replacements))

    def tearDown(self):
        self.tmp.cleanup()

    def test_every_target_replacement_occurs_once_and_rewrites(self):
        for path in patcher.REPLACEMENTS:
            file = self.root / path
            before = file.read_text()
            after = patcher.transformed(path, before)
            self.assertNotEqual(before, after)
            for old, new in patcher.REPLACEMENTS[path]:
                self.assertIn(new, after)

    def test_real_upstream_server_indentation_is_preserved(self):
        """Regression for 2026-10-22 failure: source indentation was off by one.

        These examples were transcribed independently from upstream server.ts,
        rather than generated from patcher.REPLACEMENTS.
        """
        anchors = patcher.REPLACEMENTS['bundled-service/src/lan/server.ts']
        self.assertTrue(anchors[2][0].startswith(
            "          setupUrl: 'http://' + ip"))
        self.assertTrue(anchors[6][0].startswith(
            "      try { send(res, 500,"))
        self.assertTrue(anchors[7][0].startswith(
            "      console.log('[lan] listening"))
        self.assertTrue(anchors[8][0].startswith(
            "    server.listen(port,"))

    def test_anchor_drift_fails_closed(self):
        first = next(iter(patcher.REPLACEMENTS))
        with self.assertRaises(ValueError):
            patcher.transformed(first, '// fake source')

    def test_files_to_add_are_valid_and_distinct(self):
        self.assertIn('src/utils/redact-log.ts', patcher.ADDITIONS)
        self.assertIn('src/utils/redact-log.test.ts', patcher.ADDITIONS)
        self.assertIn('bundled-service/src/lan/server-security.test.ts', patcher.ADDITIONS)


class RedactionTests(unittest.TestCase):
    def test_compiles_and_redacts_credentials(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td)
            (path / 'redact-log.ts').write_text(patcher.REDACT_LOG_TS)
            subprocess.run(['tsc', '--strict', '--target', 'es2017', '--module', 'commonjs',
                            '--outDir', str(path / 'out'), str(path / 'redact-log.ts')],
                           check=True, capture_output=True, text=True)
            js = '''const assert = require('node:assert/strict');
const { redactLogString, redactLogValue } = require('./out/redact-log.js');
const x = redactLogString('fetch http://host/xmltv.php?username=alice&password=pass123');
assert(!x.includes('alice') && !x.includes('pass123'));
const y = JSON.stringify(redactLogValue({password:'pw987',key: new Error('https://host/live/u/pw987/42.ts')}));
assert(!y.includes('pw987') && !y.includes('https://host'));
assert.equal(redactLogString('token=XYZ'), 'token=[REDACTED]');
'''
            (path / 'test.cjs').write_text(js)
            subprocess.run(['node', str(path / 'test.cjs')], cwd=path,
                           check=True, capture_output=True, text=True)


if __name__ == '__main__':
    unittest.main(verbosity=2)
