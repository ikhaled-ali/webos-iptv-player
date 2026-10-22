#!/usr/bin/env python3
"""Follow-up for the webOS IPTV security hardening kit v2.

This does NOT roll back security behavior. It restores diagnostic test visibility,
keeps harmless Error objects identical, updates tests for intended HTTPS/URL
redaction behavior, and matches Xtream provider paths across HTTP/HTTPS.

Use from a cloned repository which already has the v2 security patch applied.
"""
from __future__ import annotations

from pathlib import Path
import argparse
import sys

# (filename, old source, replacement source). The script verifies all anchors
# before touching a file; it refuses to replace ambiguous or changed source.
REPLACEMENTS: list[tuple[str, str, str]] = [
    (
        'src/test/setup.ts',
        "import { DEFAULT_LOCALE, setLocale } from '../i18n';",
        "import { DEFAULT_LOCALE, setLocale } from '../i18n';\n"
        "import { Logger } from '../utils/logger';\n\n"
        "// Keep production logging at 'warn'; the existing diagnostic tests\n"
        "// intentionally assert debug/info events. Tests use fake credentials.\n"
        "Logger.setLevel('debug');",
    ),
    (
        'src/utils/redact-log.ts',
        """  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactLogString(value.message),
      stack: value.stack ? redactLogString(value.stack) : undefined,
    };
  }""",
        """  if (value instanceof Error) {
    const cleanMessage = redactLogString(value.message);
    const cleanStack = value.stack ? redactLogString(value.stack) : value.stack;
    // Keep ordinary Errors intact so diagnostics and test identity checks work.
    // Errors with custom fields/cause may themselves contain secrets, so
    // sanitize them even if message/stack alone look harmless.
    const additionalKeys = Object.getOwnPropertyNames(value)
      .filter(key => key !== 'name' && key !== 'message' && key !== 'stack');
    if (cleanMessage === value.message && cleanStack === value.stack
        && additionalKeys.length === 0) return value;
    const sanitized: Record<string, unknown> = {
      name: redactLogString(value.name), message: cleanMessage, stack: cleanStack,
    };
    for (const key of additionalKeys) {
      if (SECRET_PROPERTY.test(key)) sanitized[key] = '[REDACTED]';
      else {
        try {
          sanitized[key] = redactLogValue((value as unknown as Record<string, unknown>)[key], depth + 1);
        } catch { sanitized[key] = '[UNAVAILABLE]'; }
      }
    }
    return sanitized;
  }""",
    ),
    (
        'src/components/player.test.ts',
        "expect(detail).toContain('url=http://host:8080/movie/***/***/10.mkv');",
        "expect(detail).toContain('url=[URL REDACTED]');",
    ),
    (
        'src/components/settings.test.ts',
        """        name: 'My Provider',
        url: 'http://host:8080',
        source: 'xtream',""",
        """        name: 'My Provider',
        url: 'https://host:8080',
        source: 'xtream',""",
    ),
    (
        'src/components/settings.test.ts',
        """    card.querySelector<HTMLInputElement>('.xtream-url')!.value = 'host:8080/';
    card.querySelector<HTMLInputElement>('.xtream-password')!.value = 'p2';""",
        """    // Preserve the *explicit* HTTP origin of the previously saved account.
    // A scheme-less URL now defaults to HTTPS and changes the origin, so
    // clearing origin-specific category filters would be correct in that case.
    card.querySelector<HTMLInputElement>('.xtream-url')!.value = 'http://host:8080/';
    card.querySelector<HTMLInputElement>('.xtream-password')!.value = 'p2';""",
    ),
    (
        'src/services/phone-setup.integration.test.ts',
        """beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-setup-test-'));""",
        """const previousLanOptIn = process.env.IPTV_ALLOW_INSECURE_LAN_SETUP;
beforeAll(async () => {
  // Integration test deliberately exercises the legacy, opt-in HTTP setup
  // using fake credentials; production stays loopback-only by default.
  process.env.IPTV_ALLOW_INSECURE_LAN_SETUP = '1';
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-setup-test-'));""",
    ),
    (
        'src/services/phone-setup.integration.test.ts',
        """  fs.rmSync(dataDir, { recursive: true, force: true });
});""",
        """  fs.rmSync(dataDir, { recursive: true, force: true });
  if (previousLanOptIn === undefined) delete process.env.IPTV_ALLOW_INSECURE_LAN_SETUP;
  else process.env.IPTV_ALLOW_INSECURE_LAN_SETUP = previousLanOptIn;
});""",
    ),
    (
        'src/utils/xtream-live-match.ts',
        """  if (basePathPrefix && value.indexOf(basePathPrefix) === 0
      && value.charCodeAt(basePathPrefix.length) === 47) {
    pathStart = basePathPrefix.length;
  }""",
        """  // The default Xtream protocol is HTTPS, but existing M3U streams
  // can still use explicit HTTP. Match a configured *host/path* without
  // imposing that default protocol on the playlist's actual URLs.
  // No URL allocations per entry: this runs over large M3U catalogs.
  const delimiter = basePathPrefix.indexOf('://');
  const authorityAndPath = delimiter >= 0
    ? basePathPrefix.slice(delimiter + 3) : '';
  if (authorityAndPath && value.startsWith(authorityAndPath, authorityStart)
      && value.charCodeAt(authorityStart + authorityAndPath.length) === 47) {
    pathStart = authorityStart + authorityAndPath.length;
  }""",
    ),
]

# This one test file contains multiple upload mocks; allow only a clearly
# delimited exact condition, and require at least one match.
SETUP_PAGE_TEST = 'bundled-service/src/setup/setup-page.test.ts'
SETUP_MOCK_OLD = "if (url === '/uploads')"
SETUP_MOCK_NEW = "if (url === '/uploads' || url.startsWith('/uploads?token='))"

REDACT_TEST_PATH = 'src/utils/redact-log.test.ts'
REDACT_TEST_ADD = """

describe('diagnostic Error identity', () => {
  it('keeps safe Error objects unchanged but scrubs errors carrying URLs', () => {
    const harmless = new Error('metadata read failed');
    expect(redactLogValue(harmless)).toBe(harmless);
    const sensitive = redactLogValue(new Error('GET https://test.invalid/api?password=secret'));
    expect(JSON.stringify(sensitive)).not.toContain('secret');
    expect(JSON.stringify(sensitive)).not.toContain('https://test.invalid');
    const wrapped = new Error('Request failed') as Error & { cause?: unknown };
    wrapped.cause = new Error('https://test.invalid/?token=secret');
    const sanitized = redactLogValue(wrapped);
    expect(JSON.stringify(sanitized)).not.toContain('secret');
    expect(JSON.stringify(sanitized)).not.toContain('https://test.invalid');
  });
});
"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('repository', type=Path, help='Path to cloned and already v2-patched repository')
    parser.add_argument('--apply', action='store_true', help='Write changes after validation')
    args = parser.parse_args()
    root = args.repository.resolve()
    if not (root / 'package.json').is_file() or not (root / 'bundled-service').is_dir():
        print(f'ERROR: not a webOS IPTV repo: {root}', file=sys.stderr)
        return 2
    if not (root / 'src/utils/redact-log.ts').is_file():
        print('ERROR: apply hardening kit v2 before this follow-up', file=sys.stderr)
        return 2
    prepared: dict[Path, str] = {}
    try:
        for filename, old, new in REPLACEMENTS:
            path = root / filename
            original = prepared.get(path, path.read_text(encoding='utf-8'))
            count = original.count(old)
            if count != 1:
                raise ValueError(f'{filename}: expected one unmodified anchor, found {count}: {old[:75]!r}')
            prepared[path] = original.replace(old, new, 1)
        path = root / SETUP_PAGE_TEST
        original = prepared.get(path, path.read_text(encoding='utf-8'))
        count = original.count(SETUP_MOCK_OLD)
        if count == 0:
            raise ValueError(f'{SETUP_PAGE_TEST}: could not find expected /uploads mock conditions')
        prepared[path] = original.replace(SETUP_MOCK_OLD, SETUP_MOCK_NEW)
        path = root / REDACT_TEST_PATH
        original = prepared.get(path, path.read_text(encoding='utf-8'))
        if 'diagnostic Error identity' in original:
            raise ValueError(f'{REDACT_TEST_PATH}: follow-up test already present')
        if "from './redact-log'" not in original:
            raise ValueError(f'{REDACT_TEST_PATH}: missing v2 unit test')
        prepared[path] = original.rstrip() + '\n' + REDACT_TEST_ADD
    except (OSError, ValueError) as exc:
        print('ERROR (nothing changed):', exc, file=sys.stderr)
        return 1
    if not args.apply:
        print(f'Compatibility checked: {len(prepared)} files. Run with --apply to write.')
        return 0
    for path, new in prepared.items():
        path.write_text(new, encoding='utf-8')
        print('Updated', path.relative_to(root))
    return 0


if __name__ == '__main__':
    sys.exit(main())
