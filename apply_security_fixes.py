#!/usr/bin/env python3
"""Inspect historical first-pass hardening anchors for webos-iptv-player.

Requires an existing, clean clone of upstream; no downloads or credentials.
Source anchors reviewed against upstream main on 2026-10-22. Fails closed on drift.
"""
from __future__ import annotations

import argparse
from pathlib import Path
import sys

REDACT_LOG_TS = r'''/**
 * Redact secret-bearing diagnostic data before it reaches the debug console.
 * Deliberately hide entire URLs: Xtream credentials can occur in arbitrary
 * path segments, queries, URL userinfo, and provider-defined formats.
 */
const URL_IN_TEXT = /\b(?:https?|rtsp):\/\/[^\s<>"`]+/gi;
const CREDENTIAL_ASSIGNMENT = /\b(password|passwd|username|token|api[_-]?key|authorization|secret)["']?\s*[:=]\s*(?:(?:Bearer|Basic)\s+[^\s,;}]+|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi;
const SECRET_PROPERTY = /password|passwd|username|token|api[_-]?key|authorization|secret|\burl\b|uri|headers/i;

export function redactLogString(input: string): string {
  return input
    .replace(URL_IN_TEXT, '[URL REDACTED]')
    .replace(CREDENTIAL_ASSIGNMENT, (_whole, name: string) => `${name}=[REDACTED]`);
}

export function redactLogValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactLogString(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 4) return '[OBJECT HIDDEN]';
  if (value instanceof Error) {
    return {
      name: redactLogString(value.name),
      message: redactLogString(value.message),
      stack: value.stack ? redactLogString(value.stack) : undefined,
    };
  }
  if (Array.isArray(value)) return value.map(item => redactLogValue(item, depth + 1));
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (SECRET_PROPERTY.test(key)) {
      result[key] = '[REDACTED]';
    } else {
      try {
        result[key] = redactLogValue((value as Record<string, unknown>)[key], depth + 1);
      } catch {
        result[key] = '[UNAVAILABLE]';
      }
    }
  }
  return result;
}
'''

REDACT_TEST_TS = r'''import { describe, it, expect } from 'vitest';
import { redactLogString, redactLogValue } from './redact-log';

describe('credential-safe logger', () => {
  it('removes Xtream query credentials and URLs completely', () => {
    const input = 'EPG http://provider.test/xmltv.php?username=alice&password=SECRETPASS';
    const output = redactLogString(input);
    expect(output).not.toContain('SECRETPASS');
    expect(output).not.toContain('alice');
    expect(output).toContain('[URL REDACTED]');
  });
  it('removes password-bearing stream paths', () => {
    const output = redactLogString('http://host/live/alice/SECRETPASS/123.ts');
    expect(output).not.toContain('SECRETPASS');
    expect(output).not.toContain('alice');
  });
  it('redacts nested credentials and error messages', () => {
    const value = redactLogValue({
      auth: { password: 'SECRETPASS', apiKey: 'OTHERSECRET' },
      error: new Error('Request https://host/api?token=SECRET failed'),
    });
    const text = JSON.stringify(value);
    expect(text).not.toContain('SECRETPASS');
    expect(text).not.toContain('OTHERSECRET');
    expect(text).not.toContain('SECRET failed');
    expect(text).not.toContain('https://host');
  });
  it('redacts plain assignments outside URLs', () => {
    expect(redactLogString('password=SECRETPASS')).toBe('password=[REDACTED]');
  });
});
'''


SERVER_SECURITY_TEST_TS = r'''import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { startServer } from './server';
import { UploadStore } from '../upload/store';

describe('secure-by-default LAN service', () => {
  it('requires remote listing authorization and keeps raw playlists local even when paired', async () => {
    const previous = process.env.IPTV_ALLOW_INSECURE_LAN_SETUP;
    process.env.IPTV_ALLOW_INSECURE_LAN_SETUP = '1';
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-remote-access-'));
    let server: Awaited<ReturnType<typeof startServer>>['server'] | undefined;
    try {
      const started = await startServer(0, directory);
      server = started.server;
      expect((server.address() as AddressInfo).address).toBe('0.0.0.0');
      const base = `http://127.0.0.1:${started.port}`;
      const info = await (await fetch(`${base}/info`)).json() as { setupUrl: string };
      const token = new URL(info.setupUrl).searchParams.get('token')!;
      const playlist = '#EXTM3U\n#EXTINF:-1,ch1\nhttp://host/live/u1/p1/1.ts\n';
      const upload = new UploadStore(directory).save('a.m3u', playlist);

      const remoteGet = (url: string): { status: number; headers: Record<string, unknown>; body: string } => {
        const request = {
          url, method: 'GET', headers: { host: '127.0.0.1' },
          socket: { remoteAddress: '192.0.2.1' },
        };
        const result = { status: 0, headers: {} as Record<string, unknown>, body: '' };
        server!.emit('request', request, {
          req: request,
          setHeader: (name: string, value: unknown) => { result.headers[name] = value; },
          writeHead: (status: number, headers: Record<string, unknown>) => {
            result.status = status;
            Object.assign(result.headers, headers);
          },
          end: (body: Buffer) => { result.body = body.toString('utf8'); },
        });
        expect(result.headers['Access-Control-Allow-Origin']).toBeUndefined();
        expect(result.headers['Cache-Control']).toBe('no-store');
        expect(result.headers['Referrer-Policy']).toBe('no-referrer');
        expect(result.headers['X-Content-Type-Options']).toBe('nosniff');
        expect(result.headers['X-Frame-Options']).toBe('DENY');
        return result;
      };

      expect(remoteGet('/uploads').status).toBe(403);
      expect(remoteGet('/uploads?token=invalid').status).toBe(403);
      const listing = remoteGet(`/uploads?token=${token}`);
      expect(listing.status).toBe(200);
      expect(JSON.parse(listing.body)).toHaveLength(1);
      for (const suffix of ['', `?token=${token}`]) {
        const raw = remoteGet(`/uploads/${upload.id}.m3u${suffix}`);
        expect(raw.status).toBe(403);
        expect(raw.body).not.toContain('p1');
      }
      expect(await (await fetch(`${base}/uploads/${upload.id}.m3u`)).text()).toBe(playlist);
    } finally {
      if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
      fs.rmSync(directory, { recursive: true, force: true });
      if (previous === undefined) delete process.env.IPTV_ALLOW_INSECURE_LAN_SETUP;
      else process.env.IPTV_ALLOW_INSECURE_LAN_SETUP = previous;
    }
  });

  it('sends local responses without the newer ServerResponse.req property', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-legacy-response-'));
    const { server } = await startServer(0, directory);
    try {
      const headers: Record<string, unknown> = {};
      const response = {
        setHeader: vi.fn((name: string, value: unknown) => { headers[name] = value; }),
        writeHead: vi.fn((_status: number, values: Record<string, unknown>) => {
          Object.assign(headers, values);
        }),
        end: vi.fn(),
      };
      server.emit('request', {
        url: '/info', method: 'GET', headers: { host: '127.0.0.1' },
        socket: { remoteAddress: '127.0.0.1' },
      }, response);
      expect(response.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      expect(response.end).toHaveBeenCalledOnce();
      expect(headers['Access-Control-Allow-Origin']).toBe('*');
      expect(headers['Cache-Control']).toBe('no-store');
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('binds to loopback and does not advertise insecure phone onboarding', async () => {
    const previous = process.env.IPTV_ALLOW_INSECURE_LAN_SETUP;
    delete process.env.IPTV_ALLOW_INSECURE_LAN_SETUP;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-secure-server-'));
    let server: Awaited<ReturnType<typeof startServer>>['server'] | undefined;
    try {
      const started = await startServer(0, directory);
      server = started.server;
      expect((server.address() as AddressInfo).address).toBe('127.0.0.1');
      const base = `http://127.0.0.1:${started.port}`;
      const res = await fetch(`${base}/info`);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const info = await res.json();
      expect(info.setupUrl).toBe('');
      expect(info.manualUrl).toBe('');
      expect(info.pairingCode).toBe('');
    } finally {
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
      fs.rmSync(directory, { recursive: true, force: true });
      if (previous === undefined) delete process.env.IPTV_ALLOW_INSECURE_LAN_SETUP;
      else process.env.IPTV_ALLOW_INSECURE_LAN_SETUP = previous;
    }
  });
});
'''

# Each anchor must appear exactly once. Keep edits conservative to avoid drifting
# into parser / playback / storage code without a complete upstream checkout.
REPLACEMENTS = {
  'bundled-service/src/lan/server.ts': [
    (
      "  let boundPort = port;",
      "  let boundPort = port;\n" \
      "  // TV-local by default. Remote HTTP setup explicitly opts into LAN exposure.\n" \
      "  const allowInsecureLanSetup = process.env.IPTV_ALLOW_INSECURE_LAN_SETUP === '1';",
    ),
    (
      "  res.writeHead(status, {\n" \
      "    'Content-Type': contentType,\n" \
      "    'Content-Length': buf.length,\n" \
      "    'Access-Control-Allow-Origin': '*',\n" \
      "  });",
      "  const headers: http.OutgoingHttpHeaders = {\n" \
      "    'Content-Type': contentType,\n" \
      "    'Content-Length': buf.length,\n" \
      "    'Cache-Control': 'no-store',\n" \
      "    'Pragma': 'no-cache',\n" \
      "    'Referrer-Policy': 'no-referrer',\n" \
      "    'X-Content-Type-Options': 'nosniff',\n" \
      "    'X-Frame-Options': 'DENY',\n" \
      "  };\n" \
      "  res.writeHead(status, headers);",
    ),
    (
      "          setupUrl: 'http://' + ip + ':' + hostPort + '/setup?token=' + setupToken,\n" \
      "          manualUrl: 'http://' + ip + ':' + hostPort,\n" \
      "          pairingCode,",
      "          setupUrl: allowInsecureLanSetup\n" \
      "            ? 'http://' + ip + ':' + hostPort + '/setup?token=' + setupToken : '',\n" \
      "          manualUrl: allowInsecureLanSetup ? 'http://' + ip + ':' + hostPort : '',\n" \
      "          pairingCode: allowInsecureLanSetup ? pairingCode : '',",
    ),
    (
      "      } else if (pathname === '/uploads') {\n        const base = 'http://' + host;",
      "      } else if (pathname === '/uploads' && req.method === 'GET') {\n" \
      "        if (!isLoopback(req) && query('token') !== setupToken) {\n" \
      "          sendJson(res, 403, { error: 'Invalid setup token' });\n" \
      "          return;\n" \
      "        }\n" \
      "        const base = 'http://' + host;",
    ),
    (
      "        } else {\n          try {\n            send(res, 200, 'audio/mpegurl; charset=utf-8', uploads.read(id));",
      "        } else if (req.method === 'GET') {\n" \
      "          // Raw M3U files may contain live provider usernames/passwords.\n" \
      "          // Do not expose contents over the unencrypted LAN, even to a\n" \
      "          // paired client holding the setup token.\n" \
      "          if (!isLoopback(req)) {\n" \
      "            sendJson(res, 403, { error: 'TV-local access only' });\n" \
      "            return;\n" \
      "          }\n" \
      "          try {\n            send(res, 200, 'audio/mpegurl; charset=utf-8', uploads.read(id));",
    ),
    (
      "          } catch {\n" \
      "            send(res, 404, 'text/plain; charset=utf-8', 'Upload not found: ' + id);\n" \
      "          }\n" \
      "        }",
      "          } catch {\n" \
      "            send(res, 404, 'text/plain; charset=utf-8', 'Upload not found');\n" \
      "          }\n" \
      "        } else {\n" \
      "          sendJson(res, 405, { error: 'Method not allowed' });\n" \
      "        }",
    ),
    (
      "      try { send(res, 500, 'text/plain; charset=utf-8', 'Internal error: ' + msg); } catch { /* ignore */ }",
      "      try { send(res, 500, 'text/plain; charset=utf-8', 'Internal server error'); } catch { /* ignore */ }",
    ),
    (
      "      console.log('[lan] listening on http://0.0.0.0:' + actualPort);\n" \
      "      console.log('[lan] setup page: http://' + getLanIp() + ':' + actualPort + '/setup');",
      "      const bindHost = allowInsecureLanSetup ? '0.0.0.0' : '127.0.0.1';\n" \
      "      console.log('[lan] listening on http://' + bindHost + ':' + actualPort);\n" \
      "      if (allowInsecureLanSetup) {\n" \
      "        console.warn('[lan] INSECURE phone setup explicitly enabled; HTTP can expose IPTV credentials');\n" \
      "      }",
    ),
    (
      "    server.listen(port, '0.0.0.0');",
      "    server.listen(port, allowInsecureLanSetup ? '0.0.0.0' : '127.0.0.1');",
    ),
    (
      "    const server = http.createServer((req, res) => {",
      "    const server = http.createServer((req, res) => {\n"
      "      // Node 0.12 has no res.req; decide CORS while the request is available.\n"
      "      if (isLoopback(req)) res.setHeader('Access-Control-Allow-Origin', '*');",
    ),
  ],
  'scripts/service-runtime-smoke.js': [
    (
      "          status: res.statusCode,",
      "          status: res.statusCode,\n          headers: res.headers,",
    ),
    (
      "    req.on('error', reject);",
      "    req.on('error', reject);\n"
      "    req.setTimeout(5000, function () {\n"
      "      req.abort();\n"
      "      reject(new Error('HTTP request timed out: ' + method + ' ' + route.split('?')[0]));\n"
      "    });",
    ),
    (
      "startServer(0, dataDir).then(function (bound) {",
      r'''delete process.env.IPTV_ALLOW_INSECURE_LAN_SETUP;
startServer(0, dataDir).then(function (bound) {
  server = bound.server;
  if (server.address().address !== '127.0.0.1') {
    throw new Error('Default service must bind only to loopback');
  }
  return request(bound.port, 'GET', '/info').then(function (response) {
    var info = expectStatus(response, 200, '/info');
    if (info.setupUrl !== '' || info.manualUrl !== '' || info.pairingCode !== '') {
      throw new Error('Default service must not advertise phone setup');
    }
    if (response.headers['access-control-allow-origin'] !== '*' ||
        response.headers['cache-control'] !== 'no-store' ||
        response.headers['referrer-policy'] !== 'no-referrer' ||
        response.headers['x-content-type-options'] !== 'nosniff' ||
        response.headers['x-frame-options'] !== 'DENY') {
      throw new Error('Missing local response security headers');
    }
    return new Promise(function (resolve) {
      server.close(function () { server = null; resolve(); });
    });
  });
}).then(function () {
  process.env.IPTV_ALLOW_INSECURE_LAN_SETUP = '1';
  return startServer(0, dataDir);
}).then(function (bound) {''',
    ),
  ],
  'bundled-service/src/lan/server.test.ts': [
    (
      "  const result = await startServer(0, dataDir);",
      "  // This existing suite covers the legacy phone setup behavior. Explicit\n" \
      "  // opt-in is required after the security hardening; production is local-only.\n" \
      "  process.env.IPTV_ALLOW_INSECURE_LAN_SETUP = '1';\n" \
      "  const result = await startServer(0, dataDir);",
    ),
    (
      "  fs.rmSync(dataDir, { recursive: true, force: true });",
      "  fs.rmSync(dataDir, { recursive: true, force: true });\n" \
      "  delete process.env.IPTV_ALLOW_INSECURE_LAN_SETUP;",
    ),
  ],
  'bundled-service/src/setup/setup-page.html': [
    (
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n' \
      '<meta name="referrer" content="no-referrer">',
    ),
    (
      '    fetch("/uploads").then(function (r) { return r.json(); })',
      '    fetch(authenticatedUrl("/uploads"), { cache: "no-store" }).then(function (r) {\n' \
      '      if (!r.ok) throw new Error("Could not list uploads");\n' \
      '      return r.json();\n' \
      '    })',
    ),
  ],
  'src/utils/logger.ts': [
    (
      " *   localStorage.setItem('iptv_log_level', 'warn'); location.reload();",
      " *   localStorage.setItem('iptv_log_level', 'debug'); location.reload();",
    ),
    (
      " * Default level is 'debug' so everything is visible in ares-inspect without\n" \
      " * any setup. Logging cost is negligible (<0.01% CPU even on webOS 5).\n" \
      " * To quiet things down: Logger.setLevel('warn') or",
      " * Default level is 'warn' to reduce disclosure on production TVs.\n" \
      " * To enable diagnostics: Logger.setLevel('debug') or",
    ),
    (
      "type Level = 'debug' | 'info' | 'warn' | 'error' | 'silent';",
      "import { redactLogString, redactLogValue } from './redact-log';\n\n" \
      "type Level = 'debug' | 'info' | 'warn' | 'error' | 'silent';",
    ),
    (
      "let currentLevel: Level = 'debug';",
      "let currentLevel: Level = 'warn';",
    ),
    (
      "    debug: (...args) => { if (should('debug')) console.log(prefix, ...args); },\n" \
      "    info:  (...args) => { if (should('info'))  console.log(prefix, ...args); },\n" \
      "    warn:  (...args) => { if (should('warn'))  console.warn(prefix, ...args); },\n" \
      "    error: (...args) => { if (should('error')) console.error(prefix, ...args); },",
      "    debug: (...args) => { if (should('debug')) console.log(prefix, ...args.map(a => redactLogValue(a))); },\n" \
      "    info:  (...args) => { if (should('info')) console.log(prefix, ...args.map(a => redactLogValue(a))); },\n" \
      "    warn:  (...args) => { if (should('warn')) console.warn(prefix, ...args.map(a => redactLogValue(a))); },\n" \
      "    error: (...args) => { if (should('error')) console.error(prefix, ...args.map(a => redactLogValue(a))); },",
    ),
    (
      "        if (should('info')) console.log(prefix, `${label}: ${Date.now() - start}ms`);",
      "        if (should('info')) console.log(prefix, redactLogString(`${label}: ${Date.now() - start}ms`));",
    ),
  ],
  'src/utils/xtream-url.ts': [
    (
      '/** `scheme://host[:port][/path]` with a default http scheme and no trailing slash. */',
      '/** `scheme://host[:port][/path]` with a default https scheme and no trailing slash. */',
    ),
    (
      "  if (!/^https?:\\/\\//i.test(s)) s = 'http://' + s;",
      "  if (!/^https?:\\/\\//i.test(s)) s = 'https://' + s;",
    ),
  ],
  'src/utils/xtream-url.test.ts': [
    (
      "it('defaults a missing scheme to http', () => {\n" \
      "    expect(normalizeXtreamBaseUrl('host:8080')).toBe('http://host:8080');",
      "it('defaults a missing scheme to https', () => {\n" \
      "    expect(normalizeXtreamBaseUrl('host:8080')).toBe('https://host:8080');",
    ),
    (
      "expect(normalizeXtreamBaseUrl('  host:8080  ')).toBe('http://host:8080');",
      "expect(normalizeXtreamBaseUrl('  host:8080  ')).toBe('https://host:8080');",
    ),
    (
      "it('normalizes a scheme-less, trailing-slash base', () => {\n" \
      "    expect(xtreamPlaylistUrl({ ...creds, baseUrl: 'host:8080/' })).toBe(\n" \
      "      'http://host:8080/get.php?username=u1&password=p1&type=m3u_plus&output=ts',",
      "it('normalizes a scheme-less, trailing-slash base', () => {\n" \
      "    expect(xtreamPlaylistUrl({ ...creds, baseUrl: 'host:8080/' })).toBe(\n" \
      "      'https://host:8080/get.php?username=u1&password=p1&type=m3u_plus&output=ts',",
    ),
    (
      "'http://host:8080/movie/u1/p1/10.mkv');",
      "'https://host:8080/movie/u1/p1/10.mkv');",
    ),
  ],
}

ADDITIONS = {
    'src/utils/redact-log.ts': REDACT_LOG_TS,
    'src/utils/redact-log.test.ts': REDACT_TEST_TS,
    'bundled-service/src/lan/server-security.test.ts': SERVER_SECURITY_TEST_TS,
}


def transformed(path: str, original: str) -> str:
    data = original
    for before, after in REPLACEMENTS[path]:
        n = data.count(before)
        if n != 1:
            raise ValueError(f'{path}: expected one copy of anchor, found {n}: {before[:90]!r}')
        data = data.replace(before, after, 1)
    return data


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('repository', type=Path, help='The local cloned GitHub repository')
    parser.add_argument('--apply', action='store_true', help='Disabled historical apply mode; use the current project sources')
    args = parser.parse_args()
    if args.apply:
        print('This historical patcher is disabled. Build the current project sources for authenticated service access.', file=sys.stderr)
        return 2
    root = args.repository.resolve()
    if not (root / 'package.json').is_file() or not (root / 'bundled-service').is_dir():
        print(f'Error: {root} does not look like the IPTV repository', file=sys.stderr)
        return 2
    prepared: dict[Path, str] = {}
    try:
        for rel in REPLACEMENTS:
            file = root / rel
            original = file.read_text(encoding='utf-8')
            prepared[file] = transformed(rel, original)
        for rel, data in ADDITIONS.items():
            file = root / rel
            if file.exists():
                if file.read_text(encoding='utf-8') != data:
                    raise ValueError(f'{rel}: file already exists with different contents')
            else:
                prepared[file] = data
    except (OSError, ValueError) as exc:
        print(f'ERROR (nothing changed): {exc}', file=sys.stderr)
        return 1
    print(f'Historical anchor compatibility checked: {len(prepared)} files. Build the current project sources.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
