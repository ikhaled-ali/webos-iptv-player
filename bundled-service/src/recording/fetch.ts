import * as http from 'http';
import * as https from 'https';
import * as nodeUrl from 'url';

export type Headers = { [name: string]: string };

export interface ByteRange {
  offset: number;
  length: number;
}

export interface FetchError extends Error {
  statusCode?: number;
}

export type Abort = () => void;

const MAX_REDIRECTS = 5;
const INACTIVITY_TIMEOUT_MS = 15000;

function fetchError(message: string, statusCode?: number): FetchError {
  const error: FetchError = new Error(message);
  if (statusCode !== undefined) error.statusCode = statusCode;
  return error;
}

// Opens a GET and hands back the response once headers arrive, following
// redirects. The returned function aborts whichever request is in flight.
export function openStream(
  url: string,
  headers: Headers,
  range: ByteRange | null,
  cb: (err: FetchError | null, res?: http.IncomingMessage, finalUrl?: string) => void,
): Abort {
  let aborted = false;
  let done = false;
  let current: http.ClientRequest | null = null;

  function finish(err: FetchError | null, res?: http.IncomingMessage, finalUrl?: string): void {
    if (done) return;
    done = true;
    cb(err, res, finalUrl);
  }

  function go(target: string, redirectsLeft: number): void {
    const parsed = nodeUrl.parse(target);
    const isHttps = parsed.protocol === 'https:';
    if (!isHttps && parsed.protocol !== 'http:') {
      finish(fetchError('Unsupported protocol'));
      return;
    }
    const requestHeaders: Headers = {};
    const names = Object.keys(headers);
    for (let i = 0; i < names.length; i++) requestHeaders[names[i]] = headers[names[i]];
    if (range) requestHeaders.Range = 'bytes=' + range.offset + '-' + (range.offset + range.length - 1);
    const options: http.RequestOptions = {
      hostname: parsed.hostname || undefined,
      port: parsed.port ? parseInt(parsed.port, 10) : undefined,
      path: parsed.path || '/',
      method: 'GET',
      headers: requestHeaders,
    };
    const req = (isHttps ? https : http).request(options, (res) => {
      const status = res.statusCode || 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && typeof location === 'string') {
        res.resume();
        if (redirectsLeft <= 0) {
          finish(fetchError('Too many redirects'));
          return;
        }
        go(nodeUrl.resolve(target, location), redirectsLeft - 1);
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        finish(fetchError('HTTP ' + status, status));
        return;
      }
      finish(null, res, target);
    });
    current = req;
    req.setTimeout(INACTIVITY_TIMEOUT_MS, () => {
      req.abort();
      finish(fetchError('Timed out'));
    });
    // Node's messages can name the host; errors only carry the code.
    req.on('error', (e: NodeJS.ErrnoException) => finish(fetchError(e.code || 'Network error')));
    req.end();
  }

  go(url, MAX_REDIRECTS);
  return () => {
    if (aborted) return;
    aborted = true;
    done = true;
    if (current) {
      try { current.abort(); } catch { /* ignore */ }
    }
  };
}

export interface FetchedBody {
  body: Buffer;
  finalUrl: string;
  contentType: string;
}

export function readBody(
  res: http.IncomingMessage,
  maxBytes: number,
  initial: Buffer[],
  cb: (err: FetchError | null, body?: Buffer) => void,
): void {
  const chunks: Buffer[] = initial.slice();
  let size = 0;
  for (let i = 0; i < chunks.length; i++) size += chunks[i].length;
  let done = false;
  function finish(err: FetchError | null, body?: Buffer): void {
    if (done) return;
    done = true;
    cb(err, body);
  }
  res.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > maxBytes) {
      res.destroy();
      finish(fetchError('Response too large'));
      return;
    }
    chunks.push(chunk);
  });
  res.on('end', () => finish(null, Buffer.concat(chunks)));
  res.on('aborted', () => finish(fetchError('Connection closed')));
  res.on('close', () => finish(fetchError('Connection closed')));
  res.on('error', (e: NodeJS.ErrnoException) => finish(fetchError(e.code || 'Network error')));
}

export function fetchBuffer(
  url: string,
  headers: Headers,
  range: ByteRange | null,
  maxBytes: number,
  cb: (err: FetchError | null, result?: FetchedBody) => void,
): Abort {
  return openStream(url, headers, range, (err, res, finalUrl) => {
    if (err || !res) {
      cb(err || fetchError('No response'));
      return;
    }
    const contentType = String(res.headers['content-type'] || '');
    readBody(res, maxBytes, [], (bodyErr, body) => {
      if (bodyErr || !body) cb(bodyErr || fetchError('No body'));
      else cb(null, { body: body, finalUrl: finalUrl || url, contentType: contentType });
    });
  });
}

// Client errors other than timeouts and throttling will not fix themselves.
export function isRetryable(err: FetchError): boolean {
  const status = err.statusCode;
  if (status === undefined) return true;
  return status >= 500 || status === 408 || status === 429;
}
