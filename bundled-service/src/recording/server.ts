import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import { parseUrl } from '../compat';
import { isValidRecordingId, type RecordingExt } from './store';

export interface ServedRecording {
  file: string;
  ext: RecordingExt;
}

export interface RecordingServer {
  server: http.Server;
  port: number;
  token: string;
}

export type RangeResult = { start: number; end: number } | 'unsatisfiable' | null;

// Returns null to serve the whole file: no header, a malformed one, or a
// multi-range request (which RFC 9110 lets a server ignore).
export function parseRange(header: string | undefined, size: number): RangeResult {
  if (!header) return null;
  const match = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!match) return null;
  const first = match[1];
  const last = match[2];
  if (!first && !last) return null;
  let start: number;
  let end: number;
  if (!first) {
    const suffix = parseInt(last, 10);
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = parseInt(first, 10);
    end = last ? parseInt(last, 10) : size - 1;
    if (last && end < start) return null;
    if (start >= size) return 'unsatisfiable';
    end = Math.min(end, size - 1);
  }
  return { start: start, end: end };
}

export function contentTypeFor(ext: RecordingExt): string {
  return ext === 'mp4' ? 'video/mp4' : 'video/mp2t';
}

function isLoopback(req: http.IncomingMessage): boolean {
  const address = req.socket.remoteAddress || '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function sendStatus(res: http.ServerResponse, status: number, extra?: { [name: string]: string }): void {
  const headers: { [name: string]: string } = {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  };
  if (extra) {
    const names = Object.keys(extra);
    for (let i = 0; i < names.length; i++) headers[names[i]] = extra[names[i]];
  }
  res.writeHead(status, headers);
  res.end(String(status));
}

export function handleRecordingRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  token: string,
  resolve: (id: string) => ServedRecording | null,
): void {
  if (!isLoopback(req)) {
    sendStatus(res, 403);
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendStatus(res, 405, { Allow: 'GET, HEAD' });
    return;
  }
  let pathname: string;
  let queryToken: string | null;
  try {
    const parsed = parseUrl(req.url || '/', 'http://127.0.0.1');
    pathname = parsed.pathname;
    queryToken = parsed.query('token');
  } catch {
    sendStatus(res, 400);
    return;
  }
  const match = /^\/recordings\/([^/]+)$/.exec(pathname);
  if (!match) {
    sendStatus(res, 404);
    return;
  }
  if (queryToken !== token) {
    sendStatus(res, 403);
    return;
  }
  const id = match[1];
  const recording = isValidRecordingId(id) ? resolve(id) : null;
  if (!recording) {
    sendStatus(res, 404);
    return;
  }
  fs.stat(recording.file, (err, stat) => {
    if (err || !stat.isFile()) {
      sendStatus(res, 404);
      return;
    }
    const size = stat.size;
    const rangeHeader = req.headers.range;
    const range = parseRange(typeof rangeHeader === 'string' ? rangeHeader : undefined, size);
    if (range === 'unsatisfiable') {
      sendStatus(res, 416, { 'Content-Range': 'bytes */' + size });
      return;
    }
    const headers: { [name: string]: string } = {
      'Content-Type': contentTypeFor(recording.ext),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    };
    const start = range ? range.start : 0;
    const end = range ? range.end : size - 1;
    headers['Content-Length'] = String(size === 0 ? 0 : end - start + 1);
    if (range) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size;
    res.writeHead(range ? 206 : 200, headers);
    if (req.method === 'HEAD' || size === 0) {
      res.end();
      return;
    }
    const stream = fs.createReadStream(recording.file, { start: start, end: end });
    stream.on('error', () => {
      try { res.destroy(); } catch { /* ignore */ }
    });
    res.on('close', () => {
      try { stream.destroy(); } catch { /* ignore */ }
    });
    stream.pipe(res);
  });
}

export function startRecordingServer(
  resolve: (id: string) => ServedRecording | null,
  cb: (err: Error | null, server?: RecordingServer) => void,
): void {
  const token = crypto.randomBytes(32).toString('hex');
  const server = http.createServer((req, res) => {
    try {
      handleRecordingRequest(req, res, token, resolve);
    } catch (e) {
      console.error('[recording] request failed: ' + (e instanceof Error ? e.message : String(e)));
      try { sendStatus(res, 500); } catch { /* ignore */ }
    }
  });
  const onError = (err: Error): void => {
    server.removeListener('listening', onListening);
    cb(err);
  };
  const onListening = (): void => {
    server.removeListener('error', onError);
    server.on('error', (e: Error) => console.error('[recording] server error: ' + e.message));
    const address = server.address();
    const port = address && typeof address === 'object' ? address.port : 0;
    console.log('[recording] media server listening on loopback port ' + port);
    cb(null, { server: server, port: port, token: token });
  };
  server.once('error', onError);
  server.once('listening', onListening);
  server.listen(0, '127.0.0.1');
}
