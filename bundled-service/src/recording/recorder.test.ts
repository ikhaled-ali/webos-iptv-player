import { describe, expect, it } from 'vitest';
import * as crypto from 'crypto';
import { decryptAes128, isDashUrl, isHlsUrl, looksLikeTs } from './recorder';
import { sanitizeHeaders } from './service';

describe('stream detection', () => {
  it('recognizes HLS and DASH URLs', () => {
    expect(isHlsUrl('http://host/a/live.m3u8')).toBe(true);
    expect(isHlsUrl('http://host/a/live.m3u8?t=1')).toBe(true);
    expect(isHlsUrl('http://host/a/ch1.ts')).toBe(false);
    expect(isDashUrl('http://host/a/manifest.mpd')).toBe(true);
    expect(isDashUrl('http://host/a/ch1')).toBe(false);
  });

  it('accepts MPEG-TS sync bytes and rejects other bodies', () => {
    const ts = Buffer.alloc(188 * 2);
    ts[0] = 0x47;
    ts[188] = 0x47;
    expect(looksLikeTs(ts)).toBe(true);
    expect(looksLikeTs(Buffer.concat([Buffer.alloc(4), ts]))).toBe(true);
    expect(looksLikeTs(Buffer.from('<html><body>l1</body></html>'))).toBe(false);
  });
});

describe('decryptAes128', () => {
  it('decrypts AES-128-CBC segments', () => {
    const key = crypto.randomBytes(16);
    const iv = '000000000000000000000000000000ff';
    const cipher = crypto.createCipheriv('aes-128-cbc', key, Buffer.from(iv, 'hex'));
    const encrypted = Buffer.concat([cipher.update('segment l1'), cipher.final()]);
    expect(decryptAes128(encrypted, key, iv).toString()).toBe('segment l1');
  });
});

describe('sanitizeHeaders', () => {
  it('keeps safe string headers and drops the rest', () => {
    expect(sanitizeHeaders({
      'User-Agent': 'Agent 1',
      Referer: 'http://host/a',
      Host: 'host',
      'Bad Name': 'x',
      'X-Split': 'a\r\nb',
      'X-Number': 1,
    })).toEqual({ 'User-Agent': 'Agent 1', Referer: 'http://host/a' });
    expect(sanitizeHeaders(null)).toEqual({});
  });
});
