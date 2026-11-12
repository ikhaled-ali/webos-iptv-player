import * as crypto from 'crypto';
import * as fs from 'fs';
import type * as http from 'http';
import { bufferFrom } from '../compat';
import {
  fetchBuffer, isRetryable, openStream, readBody,
  type Abort, type FetchError, type Headers,
} from './fetch';
import {
  isPlaylistText, isUnsupportedKey, ivHex, liveStartIndex, parsePlaylist, pickVariant, pollDelayMs,
  type HlsKey, type HlsSegment, type MediaPlaylist,
} from './hls';
import { partPath, type RecordingExt } from './store';

export type RecorderFailure = 'unsupported' | 'failed';

export interface RecorderEvents {
  onFirstBytes: () => void;
  // Terminal; the output file is already closed when these fire.
  onFailed: (code: RecorderFailure, text: string) => void;
  onEnded: () => void;
}

export interface RecorderOptions {
  url: string;
  headers: Headers;
  dir: string;
  id: string;
}

const STALL_MS = 30000;
const WATCHDOG_MS = 5000;
const LIVE_EDGE_SEGMENTS = 3;
const MAX_PLAYLIST_BYTES = 4 * 1024 * 1024;
const MAX_SEGMENT_BYTES = 64 * 1024 * 1024;
const MAX_KEY_BYTES = 1024;
const FETCH_ATTEMPTS = 3;
const MAX_VARIANT_HOPS = 2;
const TS_PACKET = 188;

export function isDashUrl(url: string): boolean {
  return /\.mpd(?:[?#]|$)/i.test(url);
}

export function isHlsUrl(url: string): boolean {
  return /\.m3u8?(?:[?#]|$)/i.test(url);
}

export function looksLikeTs(chunk: Buffer): boolean {
  const limit = Math.min(chunk.length, TS_PACKET);
  for (let i = 0; i < limit; i++) {
    if (chunk[i] !== 0x47) continue;
    if (i + TS_PACKET >= chunk.length || chunk[i + TS_PACKET] === 0x47) return true;
  }
  return false;
}

export function decryptAes128(data: Buffer, key: Buffer, iv: string): Buffer {
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, bufferFrom(iv, 'hex'));
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

function backoffMs(attempt: number): number {
  return Math.min(8000, 1000 * Math.pow(2, attempt));
}

export class Recorder {
  ext: RecordingExt | null = null;
  bytes = 0;
  private done = false;
  private started = false;
  private out: fs.WriteStream | null = null;
  private outError = false;
  private abortCurrent: Abort | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastProgressAt = Date.now();
  private firstBytesAt = 0;
  private hls = false;
  private hlsDuration = 0;
  private playlistUrl = '';
  private variantHops = 0;
  private lastSequence: number | null = null;
  private mapWritten = false;
  private keys: { [uri: string]: Buffer } = {};

  constructor(private readonly options: RecorderOptions, private readonly events: RecorderEvents) {}

  start(): void {
    this.lastProgressAt = Date.now();
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastProgressAt > STALL_MS) this.fail('failed', 'No stream data for 30 seconds');
    }, WATCHDOG_MS);
    const url = this.options.url;
    if (isDashUrl(url)) {
      this.fail('unsupported', 'MPEG-DASH streams cannot be recorded');
    } else if (isHlsUrl(url)) {
      this.playlistUrl = url;
      this.hls = true;
      this.loadPlaylist(0);
    } else {
      this.probe(0);
    }
  }

  durationSecs(): number {
    if (this.hls) return this.hlsDuration;
    return this.firstBytesAt ? (Date.now() - this.firstBytesAt) / 1000 : 0;
  }

  stop(cb: () => void): void {
    if (this.done) {
      cb();
      return;
    }
    this.done = true;
    this.teardown();
    this.closeOutput(cb);
  }

  private fail(code: RecorderFailure, text: string): void {
    if (this.done) return;
    this.done = true;
    console.log('[recording] recorder failed: ' + text);
    this.teardown();
    this.closeOutput(() => this.events.onFailed(code, text));
  }

  private finish(): void {
    if (this.done) return;
    this.done = true;
    console.log('[recording] stream ended');
    this.teardown();
    this.closeOutput(() => this.events.onEnded());
  }

  private teardown(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.abortCurrent) this.abortCurrent();
    this.abortCurrent = null;
  }

  private later(ms: number, fn: () => void): void {
    if (this.done) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.done) fn();
    }, ms);
  }

  private openOutput(ext: RecordingExt): void {
    if (this.out) return;
    this.ext = ext;
    const out = fs.createWriteStream(partPath(this.options.dir, this.options.id, ext));
    out.on('error', (e: Error) => {
      this.outError = true;
      console.error('[recording] write failed: ' + e.message);
      this.fail('failed', 'Could not write to storage');
    });
    this.out = out;
  }

  private closeOutput(cb: () => void): void {
    const out = this.out;
    if (!out || this.outError) {
      cb();
      return;
    }
    let called = false;
    const once = (): void => {
      if (called) return;
      called = true;
      cb();
    };
    out.once('finish', once);
    out.once('error', once);
    out.end();
  }

  private progress(length: number): void {
    this.bytes += length;
    this.lastProgressAt = Date.now();
    if (!this.started && length > 0) {
      this.started = true;
      this.firstBytesAt = Date.now();
      this.events.onFirstBytes();
    }
  }

  private write(data: Buffer, next: () => void): void {
    if (this.done || !this.out) return;
    this.out.write(data, () => {
      if (this.done) return;
      this.progress(data.length);
      next();
    });
  }

  private fetchRetry(
    url: string,
    range: { offset: number; length: number } | null,
    maxBytes: number,
    cb: (err: FetchError | null, body?: Buffer, finalUrl?: string, contentType?: string) => void,
    attempt?: number,
  ): void {
    const tries = attempt || 0;
    this.abortCurrent = fetchBuffer(url, this.options.headers, range, maxBytes, (err, result) => {
      this.abortCurrent = null;
      if (this.done) return;
      if (!err && result) {
        cb(null, result.body, result.finalUrl, result.contentType);
        return;
      }
      const error = err as FetchError;
      if (tries + 1 < FETCH_ATTEMPTS && isRetryable(error)) {
        this.later(backoffMs(tries), () => this.fetchRetry(url, range, maxBytes, cb, tries + 1));
        return;
      }
      cb(error);
    });
  }

  // --- Unknown URL: sniff the first response ---

  private probe(attempt: number): void {
    const url = this.options.url;
    this.abortCurrent = openStream(url, this.options.headers, null, (err, res, finalUrl) => {
      this.abortCurrent = null;
      if (this.done) {
        if (res) res.resume();
        return;
      }
      if (err || !res) {
        const error = err as FetchError;
        if (attempt + 1 < FETCH_ATTEMPTS && isRetryable(error)) {
          this.later(backoffMs(attempt), () => this.probe(attempt + 1));
        } else {
          this.fail('failed', 'Stream request failed: ' + error.message);
        }
        return;
      }
      const contentType = String(res.headers['content-type'] || '').toLowerCase();
      if (contentType.indexOf('dash+xml') >= 0) {
        res.resume();
        this.fail('unsupported', 'MPEG-DASH streams cannot be recorded');
        return;
      }
      const base = finalUrl || url;
      if (contentType.indexOf('mpegurl') >= 0) {
        this.readPlaylistBody(res, [], base);
        return;
      }
      res.once('data', (first: Buffer) => {
        if (this.done) return;
        if (isPlaylistText(first.slice(0, 16).toString('utf8'))) {
          this.readPlaylistBody(res, [first], base);
        } else if (looksLikeTs(first)) {
          this.openOutput('ts');
          this.attachTs(res, first);
        } else {
          res.destroy();
          this.fail('unsupported', 'Stream format cannot be recorded');
        }
      });
    });
  }

  private readPlaylistBody(res: http.IncomingMessage, initial: Buffer[], base: string): void {
    this.hls = true;
    this.playlistUrl = base;
    readBody(res, MAX_PLAYLIST_BYTES, initial, (err, body) => {
      if (this.done) return;
      if (err || !body) {
        this.schedulePoll(0);
        return;
      }
      this.handlePlaylist(body.toString('utf8'), base);
    });
  }

  // --- Continuous MPEG-TS ---

  private attachTs(res: http.IncomingMessage, first: Buffer | null): void {
    const out = this.out;
    if (!out) return;
    let ended = false;
    const onEnd = (): void => {
      if (ended) return;
      ended = true;
      if (this.done) return;
      // Live TS servers drop connections; reconnect until the watchdog gives up.
      this.later(1000, () => this.reconnectTs(0));
    };
    const onData = (chunk: Buffer): void => {
      if (this.done) {
        res.destroy();
        return;
      }
      const flushed = out.write(chunk);
      this.progress(chunk.length);
      if (!flushed) {
        res.pause();
        out.once('drain', () => res.resume());
      }
    };
    if (first) onData(first);
    res.on('data', onData);
    res.on('end', onEnd);
    res.on('aborted', onEnd);
    res.on('close', onEnd);
    res.on('error', onEnd);
    this.abortCurrent = () => {
      ended = true;
      try { res.destroy(); } catch { /* ignore */ }
    };
  }

  private reconnectTs(attempt: number): void {
    console.log('[recording] reconnecting stream, attempt=' + (attempt + 1));
    this.abortCurrent = openStream(this.options.url, this.options.headers, null, (err, res) => {
      this.abortCurrent = null;
      if (this.done) {
        if (res) res.resume();
        return;
      }
      if (err || !res) {
        this.later(backoffMs(attempt), () => this.reconnectTs(attempt + 1));
        return;
      }
      this.attachTs(res, null);
    });
  }

  // --- HLS ---

  private schedulePoll(targetDuration: number): void {
    this.later(pollDelayMs(targetDuration), () => this.loadPlaylist(0));
  }

  private loadPlaylist(attempt: number): void {
    this.fetchRetry(this.playlistUrl, null, MAX_PLAYLIST_BYTES, (err, body, finalUrl) => {
      if (err || !body) {
        console.log('[recording] playlist fetch failed: ' + (err ? err.message : 'empty'));
        if (!this.out && err && !isRetryable(err)) {
          this.fail('failed', 'Stream request failed: ' + err.message);
          return;
        }
        this.schedulePoll(0);
        return;
      }
      this.handlePlaylist(body.toString('utf8'), finalUrl || this.playlistUrl);
    }, attempt);
  }

  private handlePlaylist(text: string, url: string): void {
    const playlist = parsePlaylist(text, url);
    if (!playlist) {
      if (!this.out) this.fail('unsupported', 'Stream format cannot be recorded');
      else this.schedulePoll(0);
      return;
    }
    if (playlist.kind === 'master') {
      const variant = pickVariant(playlist);
      if (!variant) {
        this.fail('unsupported', 'Streams with separate audio cannot be recorded');
        return;
      }
      if (++this.variantHops > MAX_VARIANT_HOPS) {
        this.fail('failed', 'Too many nested playlists');
        return;
      }
      this.playlistUrl = variant.uri;
      this.loadPlaylist(0);
      return;
    }
    this.playlistUrl = url;
    this.handleMedia(playlist);
  }

  private handleMedia(playlist: MediaPlaylist): void {
    const segments = playlist.segments;
    for (let i = 0; i < segments.length; i++) {
      if (isUnsupportedKey(segments[i].key)) {
        this.fail('unsupported', 'DRM-protected streams cannot be recorded');
        return;
      }
    }
    if (segments.length === 0) {
      if (playlist.endList) this.finish();
      else this.schedulePoll(playlist.targetDuration);
      return;
    }
    const last = segments[segments.length - 1].sequence;
    if (this.lastSequence === null) {
      this.openOutput(segments[0].map ? 'mp4' : 'ts');
      this.lastSequence = segments[liveStartIndex(playlist, LIVE_EDGE_SEGMENTS)].sequence - 1;
    } else if (last < this.lastSequence) {
      // The server restarted its media sequence; resume at its live edge.
      this.lastSequence = last - 1;
    }
    const after = this.lastSequence;
    const pending: HlsSegment[] = [];
    for (let i = 0; i < segments.length; i++) {
      if (segments[i].sequence > after) pending.push(segments[i]);
    }
    this.downloadAll(pending, 0, () => {
      if (playlist.endList) this.finish();
      else this.schedulePoll(playlist.targetDuration);
    });
  }

  private downloadAll(segments: HlsSegment[], index: number, done: () => void): void {
    if (this.done) return;
    if (index >= segments.length) {
      done();
      return;
    }
    this.downloadSegment(segments[index], () => this.downloadAll(segments, index + 1, done));
  }

  private downloadSegment(segment: HlsSegment, next: () => void): void {
    const skip = (reason: string): void => {
      console.log('[recording] skipped segment ' + segment.sequence + ': ' + reason);
      this.lastSequence = segment.sequence;
      next();
    };
    if (segment.map && !this.mapWritten) {
      const map = segment.map;
      this.fetchRetry(map.uri, map.byteRange, MAX_SEGMENT_BYTES, (err, body) => {
        if (err || !body) {
          skip('init segment ' + (err ? err.message : 'empty'));
          return;
        }
        this.write(body, () => {
          this.mapWritten = true;
          this.downloadSegment(segment, next);
        });
      });
      return;
    }
    this.withKey(segment.key, (keyErr, key) => {
      if (keyErr) {
        skip('key ' + keyErr);
        return;
      }
      this.fetchRetry(segment.uri, segment.byteRange, MAX_SEGMENT_BYTES, (err, body) => {
        if (err || !body) {
          skip(err ? err.message : 'empty');
          return;
        }
        let data = body;
        if (key && segment.key) {
          try {
            data = decryptAes128(body, key, ivHex(segment.key, segment.sequence));
          } catch {
            skip('decrypt failed');
            return;
          }
        }
        this.write(data, () => {
          this.lastSequence = segment.sequence;
          this.hlsDuration += segment.duration;
          next();
        });
      });
    });
  }

  private withKey(key: HlsKey | null, cb: (err: string | null, key?: Buffer) => void): void {
    if (!key || !key.uri) {
      cb(null);
      return;
    }
    const uri = key.uri;
    const cached = this.keys[uri];
    if (cached) {
      cb(null, cached);
      return;
    }
    this.fetchRetry(uri, null, MAX_KEY_BYTES, (err, body) => {
      if (err || !body) {
        cb(err ? err.message : 'empty');
        return;
      }
      if (body.length !== 16) {
        cb('invalid length');
        return;
      }
      this.keys[uri] = body;
      cb(null, body);
    });
  }
}
