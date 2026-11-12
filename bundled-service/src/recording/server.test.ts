import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseRange, startRecordingServer, type RecordingServer } from './server';

describe('parseRange', () => {
  it('serves the whole file without a usable header', () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('items=0-1', 100)).toBeNull();
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull();
    expect(parseRange('bytes=-', 100)).toBeNull();
    expect(parseRange('bytes=9-3', 100)).toBeNull();
  });

  it('parses bounded, open-ended, and suffix ranges', () => {
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=50-500', 100)).toEqual({ start: 50, end: 99 });
  });

  it('flags ranges past the end as unsatisfiable', () => {
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-1', 0)).toBe('unsatisfiable');
  });
});

describe('startRecordingServer', () => {
  const id = 'rec-1700000000000-abcd';
  let dir: string;
  let file: string;
  let server: RecordingServer;
  let base: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-server-'));
    file = path.join(dir, id + '.ts');
    fs.writeFileSync(file, '0123456789');
    server = await new Promise<RecordingServer>((resolve, reject) => {
      startRecordingServer((requested) => (requested === id ? { file: file, ext: 'ts' } : null), (err, started) => {
        if (err || !started) reject(err);
        else resolve(started);
      });
    });
    base = 'http://127.0.0.1:' + server.port + '/recordings/';
  });

  afterAll(() => {
    server.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('streams the whole file with the media type', async () => {
    const res = await fetch(base + id + '?token=' + server.token);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp2t');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(await res.text()).toBe('0123456789');
  });

  it('answers a range request with 206', async () => {
    const res = await fetch(base + id + '?token=' + server.token, { headers: { Range: 'bytes=2-4' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 2-4/10');
    expect(await res.text()).toBe('234');
  });

  it('answers an unsatisfiable range with 416', async () => {
    const res = await fetch(base + id + '?token=' + server.token, { headers: { Range: 'bytes=20-' } });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */10');
  });

  it('rejects a bad token and unknown ids', async () => {
    expect((await fetch(base + id + '?token=l1')).status).toBe(403);
    expect((await fetch(base + id)).status).toBe(403);
    expect((await fetch(base + 'rec-1700000000000-ffff?token=' + server.token)).status).toBe(404);
    expect((await fetch(base + '..%2Fx?token=' + server.token)).status).toBe(404);
  });
});
