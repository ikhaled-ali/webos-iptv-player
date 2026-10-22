#!/usr/bin/env python3
"""Synthetic-fixture tests for follow-up patcher; not real application tests."""
from pathlib import Path
import importlib.util
import subprocess
import sys
import tempfile
import unittest

script = Path(__file__).with_name('apply_test_compat_fixes.py')
spec = importlib.util.spec_from_file_location('followup', script)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class FollowupTests(unittest.TestCase):
    def test_complete_apply_and_no_partial_change(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'package.json').write_text('{}')
            (root / 'bundled-service').mkdir()
            originals = {}
            for filename, old, _ in module.REPLACEMENTS:
                originals.setdefault(filename, []).append(old)
            originals[module.SETUP_PAGE_TEST] = [module.SETUP_MOCK_OLD, module.SETUP_MOCK_OLD]
            originals[module.REDACT_TEST_PATH] = ["import { redactLogString, redactLogValue } from './redact-log';"]
            for name, snippets in originals.items():
                dest = root / name
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_text('\n// synthetic fixture\n'.join(snippets))
            base = [sys.executable, str(script), str(root)]
            preview = subprocess.run(base, capture_output=True, text=True)
            self.assertEqual(preview.returncode, 0, preview.stderr)
            self.assertIn('Compatibility checked:', preview.stdout)
            self.assertEqual((root / 'src/test/setup.ts').read_text(), originals['src/test/setup.ts'][0])
            apply = subprocess.run(base + ['--apply'], capture_output=True, text=True)
            self.assertEqual(apply.returncode, 0, apply.stderr)
            for filename, _, new in module.REPLACEMENTS:
                self.assertIn(new, (root / filename).read_text())
            self.assertEqual((root / module.SETUP_PAGE_TEST).read_text().count(module.SETUP_MOCK_NEW), 2)
            self.assertIn('diagnostic Error identity', (root / module.REDACT_TEST_PATH).read_text())
            second = subprocess.run(base + ['--apply'], capture_output=True, text=True)
            self.assertNotEqual(second.returncode, 0)
            self.assertIn('nothing changed', second.stderr)

if __name__ == '__main__':
    unittest.main(verbosity=2)
