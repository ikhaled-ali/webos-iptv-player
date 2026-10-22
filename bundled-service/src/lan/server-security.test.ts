import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { startServer } from './server';

describe('secure-by-default LAN service', () => {
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
