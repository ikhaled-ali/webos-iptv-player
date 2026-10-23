import { describe, it, expect, vi } from 'vitest';
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
      const info = await (await fetch(`${base}/info`, { headers: { 'X-IPTV-Local-Token': started.localToken } })).json() as { setupUrl: string };
      const token = new URL(info.setupUrl).searchParams.get('token')!;
      const playlist = '#EXTM3U\n#EXTINF:-1,ch1\nhttp://host/live/u1/p1/1.ts\n';
      const upload = new UploadStore(directory).save('a.m3u', playlist);

      const remoteGet = (url: string): { status: number; headers: Record<string, unknown>; body: string } => {
        const request = {
          url, method: 'GET', headers: { host: `127.0.0.1:${started.port}` },
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
      expect(await (await fetch(`${base}/uploads/${upload.id}.m3u`, { headers: { 'X-IPTV-Local-Token': started.localToken } })).text()).toBe(playlist);
    } finally {
      if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
      fs.rmSync(directory, { recursive: true, force: true });
      if (previous === undefined) delete process.env.IPTV_ALLOW_INSECURE_LAN_SETUP;
      else process.env.IPTV_ALLOW_INSECURE_LAN_SETUP = previous;
    }
  });

  it('sends local responses without the newer ServerResponse.req property', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-legacy-response-'));
    const { server, port, localToken } = await startServer(0, directory);
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
        url: '/info', method: 'GET', headers: { host: `127.0.0.1:${port}`,
          origin: 'null', 'x-iptv-local-token': localToken },
        socket: { remoteAddress: '127.0.0.1' },
      }, response);
      expect(response.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      expect(response.end).toHaveBeenCalledOnce();
      expect(headers['Access-Control-Allow-Origin']).toBe('null');
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
      const res = await fetch(`${base}/info`, { headers: { 'X-IPTV-Local-Token': started.localToken } });
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
