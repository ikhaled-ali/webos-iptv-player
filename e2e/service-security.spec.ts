import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as http from 'node:http';
import { test, expect } from './helpers';
import { startServer } from '../bundled-service/src/lan/server';
import { UploadStore } from '../bundled-service/src/upload/store';

test('file-origin clients need private access and hostile web origins cannot read playlists', async ({ browser }) => {
  // Routing mocks can bypass native CORS; use an isolated, unrouted context.
  const context = await browser.newContext({ extraHTTPHeaders: {} });
  const page = await context.newPage();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-browser-auth-'));
  const documentPath = path.join(directory, 'client.html');
  fs.writeFileSync(documentPath, '<!doctype html><html><body></body></html>');
  new UploadStore(directory).save('a.m3u', '#EXTM3U\n#EXTINF:-1,ch1\nhttp://host/live/u1/p1/1.ts\n');
  const { server, port, localToken } = await startServer(0, directory);
  let preflights = 0;
  server.on('request', req => { if (req.method === 'OPTIONS') preflights++; });
  let hostileServer: http.Server | null = null;
  try {
    await page.goto(pathToFileURL(documentPath).href);
    const result = await page.evaluate(async ({ base, token }) => {
      let anonymousBlocked = false;
      try {
        const response = await fetch(base + '/uploads');
        anonymousBlocked = !response.ok;
      } catch { anonymousBlocked = true; }
      const response = await fetch(base + '/uploads', { headers: { 'X-IPTV-Local-Token': token } });
      const uploads = await response.json() as Array<{ url: string }>;
      const raw = await fetch(uploads[0].url);
      return { anonymousBlocked, status: response.status, raw: await raw.text() };
    }, { base: `http://127.0.0.1:${port}`, token: localToken });
    expect(result.anonymousBlocked).toBe(true);
    expect(result.status).toBe(200);
    expect(result.raw).toContain('http://host/live/u1/p1/1.ts');
    expect(preflights).toBeGreaterThan(0);

    hostileServer = http.createServer((_req, res) => {
      res.end('<!doctype html><html><body></body></html>');
    });
    await new Promise<void>(resolve => hostileServer!.listen(0, '127.0.0.1', resolve));
    const hostilePort = (hostileServer.address() as import('node:net').AddressInfo).port;
    await page.goto(`http://127.0.0.1:${hostilePort}`);
    const hostileBlocked = await page.evaluate(async ({ base, token }) => {
      try {
        const response = await fetch(base + '/uploads', { headers: { 'X-IPTV-Local-Token': token } });
        return !response.ok;
      } catch { return true; }
    }, { base: `http://127.0.0.1:${port}`, token: localToken });
    expect(hostileBlocked).toBe(true);
  } finally {
    await context.close();
    if (hostileServer) await new Promise<void>(resolve => hostileServer!.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
