import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { startServer } from './server';
import { SetupActionStore } from '../setup/actions';
import { UploadStore } from '../upload/store';

type Started = Awaited<ReturnType<typeof startServer>>;
const opened: Array<{ server: Started['server']; directory: string }> = [];

afterEach(async () => {
  for (const { server, directory } of opened.splice(0)) {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});

async function open(legacy = false): Promise<Started> {
  vi.stubEnv('IPTV_ALLOW_INSECURE_LAN_SETUP', legacy ? '1' : '0');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-auth-'));
  const actions = new SetupActionStore();
  actions.add({ type: 'xtream', serverUrl: 'http://host', username: 'u1', password: 'p1' });
  new UploadStore(directory).save('a.m3u', '#EXTM3U\n#EXTINF:-1,ch1\nhttp://host/live/u1/p1/1.ts\n');
  const started = await startServer(0, directory, undefined, actions);
  opened.push({ server: started.server, directory });
  return started;
}

function tokenOf(started: Started): string {
  return (started as Started & { localToken?: string }).localToken || 'missing-token';
}

function request(started: Started, url: string, options: {
  method?: string; token?: string; origin?: string; host?: string; body?: unknown; remote?: boolean;
} = {}): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise(resolve => {
    const headers: Record<string, string> = { host: options.host || `127.0.0.1:${started.port}` };
    if (options.token) headers['x-iptv-local-token'] = options.token;
    if (options.origin) headers.origin = options.origin;
    const req = Object.assign(new EventEmitter(), {
      url, method: options.method || 'GET', headers,
      socket: { remoteAddress: options.remote ? '192.0.2.1' : '127.0.0.1' },
    });
    let status = 0;
    const responseHeaders: Record<string, string> = {};
    const res = {
      req,
      setHeader: (key: string, value: string) => { responseHeaders[key] = value; },
      writeHead: (code: number, values: Record<string, string>) => {
        status = code;
        Object.assign(responseHeaders, values);
      },
      end: (body: Buffer) => resolve({ status, headers: responseHeaders, body: body.toString('utf8') }),
    };
    started.server.emit('request', req, res);
    if (options.body !== undefined) req.emit('data', Buffer.from(JSON.stringify(options.body)));
    req.emit('end');
  });
}

describe('TV-local HTTP authorization', () => {
  it('rejects anonymous reads of uploads, metadata, and queued passwords', async () => {
    const started = await open();
    for (const url of ['/info', '/uploads', '/uploads/a.m3u', '/setup-actions']) {
      const result = await request(started, url);
      expect(result.status, url).toBe(403);
      expect(result.body).not.toContain('p1');
      expect(result.headers['Access-Control-Allow-Origin']).toBeUndefined();
    }
  });

  it('requires a private token even for opaque origins and rejects hostile origins and hosts', async () => {
    const started = await open();
    expect((await request(started, '/setup-actions', { origin: 'null' })).status).toBe(403);
    const token = tokenOf(started);
    const authorized = await request(started, '/setup-actions', { token, origin: 'null' });
    expect(authorized.status).toBe(200);
    expect(authorized.headers['Access-Control-Allow-Origin']).toBe('null');
    expect((await request(started, '/setup-actions', { token, origin: 'http://host' })).status).toBe(403);
    expect((await request(started, '/setup-actions', { token, host: `host:${started.port}` })).status).toBe(403);
    expect((await request(started, '/setup-actions', { token: 'invalid' })).status).toBe(403);
  });

  it('limits query capabilities to raw playlist reads and rotates them at each bind', async () => {
    const first = await open();
    const token = tokenOf(first);
    expect((await request(first, `/uploads/a.m3u?localToken=${token}`)).status).toBe(200);
    expect((await request(first, `/setup-actions?localToken=${token}`)).status).toBe(403);
    expect((await request(first, `/uploads/a.m3u?localToken=${token}`, { token, remote: true })).status).toBe(403);
    const second = await open();
    expect(tokenOf(second)).not.toBe(token);
    expect((await request(second, '/uploads/a.m3u', { token })).status).toBe(403);
  });

  it('disables pairing when insecure LAN setup is off', async () => {
    const started = await open();
    expect((await request(started, '/pair', { method: 'POST', body: { code: '0000' } })).status).toBe(403);
    expect((await request(started, '/pair', { method: 'POST', token: tokenOf(started), body: { code: '0000' } })).status).toBe(403);
  });

  it('allows packaged-app preflight without granting data access', async () => {
    const started = await open();
    const preflight = await request(started, '/setup-actions', { method: 'OPTIONS', origin: 'null' });
    expect(preflight.status).toBe(204);
    expect(preflight.body).toBe('');
    expect(preflight.headers['Access-Control-Allow-Origin']).toBe('null');
    expect(preflight.headers['Access-Control-Allow-Headers']).toContain('X-IPTV-Local-Token');
    expect((await request(started, '/setup-actions', { origin: 'null' })).status).toBe(403);
  });

  it('enforces pairing lockout across simultaneous requests including the correct code', async () => {
    const started = await open(true);
    const info = JSON.parse((await request(started, '/info', { token: tokenOf(started) })).body);
    const wrong = info.pairingCode === '0000' ? '0001' : '0000';
    const attempts = Array.from({ length: 7 }, () =>
      request(started, '/pair', { method: 'POST', body: { code: wrong } }));
    attempts.push(request(started, '/pair', { method: 'POST', body: { code: info.pairingCode } }));
    const results = await Promise.all(attempts);
    expect(results.slice(0, 4).every(result => result.status === 401)).toBe(true);
    expect(results.slice(4).every(result => result.status === 429)).toBe(true);
    expect(results.some(result => result.body.includes('"token"'))).toBe(false);
  });
});
