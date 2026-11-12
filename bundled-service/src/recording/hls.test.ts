import { describe, expect, it } from 'vitest';
import {
  isUnsupportedKey, ivHex, liveStartIndex, parseAttributes, parsePlaylist, pickVariant, pollDelayMs,
  type MasterPlaylist, type MediaPlaylist,
} from './hls';

describe('parseAttributes', () => {
  it('keeps commas inside quoted values', () => {
    expect(parseAttributes('BANDWIDTH=100,CODECS="a,b",URI="k.bin"')).toEqual({
      BANDWIDTH: '100', CODECS: 'a,b', URI: 'k.bin',
    });
  });
});

describe('parsePlaylist', () => {
  it('returns null for non-playlist text', () => {
    expect(parsePlaylist('<html></html>', 'http://host/a/live.m3u8')).toBeNull();
  });

  it('parses a master playlist and resolves variant URIs', () => {
    const master = parsePlaylist([
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000',
      'low/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=2400000',
      'http://host/b/high.m3u8',
    ].join('\n'), 'http://host/a/master.m3u8') as MasterPlaylist;
    expect(master.kind).toBe('master');
    expect(master.variants.map((v) => v.uri)).toEqual([
      'http://host/a/low/index.m3u8',
      'http://host/b/high.m3u8',
    ]);
    expect(pickVariant(master)!.bandwidth).toBe(2400000);
  });

  it('prefers a muxed variant over a higher one with separate audio', () => {
    const master = parsePlaylist([
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=5000000,AUDIO="aud"',
      'v1.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=1000000',
      'v2.m3u8',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Track 1",URI="a1.m3u8"',
    ].join('\n'), 'http://host/a/master.m3u8') as MasterPlaylist;
    expect(pickVariant(master)!.uri).toBe('http://host/a/v2.m3u8');
  });

  it('returns no variant when every variant has separate audio', () => {
    const master = parsePlaylist([
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Track 1",URI="a1.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=5000000,AUDIO="aud"',
      'v1.m3u8',
    ].join('\n'), 'http://host/a/master.m3u8') as MasterPlaylist;
    expect(pickVariant(master)).toBeNull();
  });

  it('parses a live media playlist with keys, sequence numbers, and relative URIs', () => {
    const media = parsePlaylist([
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:6',
      '#EXT-X-MEDIA-SEQUENCE:100',
      '#EXTINF:6.0,',
      'seg100.ts',
      '#EXT-X-KEY:METHOD=AES-128,URI="../keys/k1",IV=0x0000000000000000000000000000000A',
      '#EXTINF:5.5,',
      'seg101.ts',
      '#EXT-X-DISCONTINUITY',
      '#EXT-X-KEY:METHOD=NONE',
      '#EXTINF:6,',
      'http://host/b/seg102.ts',
    ].join('\n'), 'http://host/a/live/index.m3u8') as MediaPlaylist;
    expect(media.kind).toBe('media');
    expect(media.targetDuration).toBe(6);
    expect(media.endList).toBe(false);
    expect(media.segments.map((s) => s.sequence)).toEqual([100, 101, 102]);
    expect(media.segments.map((s) => s.duration)).toEqual([6, 5.5, 6]);
    expect(media.segments[0].key).toBeNull();
    expect(media.segments[1].key).toEqual({
      method: 'AES-128', uri: 'http://host/a/keys/k1', iv: '0x0000000000000000000000000000000A', keyFormat: null,
    });
    expect(media.segments[1].uri).toBe('http://host/a/live/seg101.ts');
    expect(media.segments[2].key).toBeNull();
  });

  it('parses fMP4 init maps, byte ranges, and the end list', () => {
    const media = parsePlaylist([
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:4',
      '#EXT-X-MAP:URI="init.mp4",BYTERANGE="700@0"',
      '#EXTINF:4,',
      '#EXT-X-BYTERANGE:1000@700',
      'media.mp4',
      '#EXTINF:4,',
      '#EXT-X-BYTERANGE:500',
      'media.mp4',
      '#EXT-X-ENDLIST',
    ].join('\n'), 'http://host/a/vod.m3u8') as MediaPlaylist;
    expect(media.endList).toBe(true);
    expect(media.segments[0].map).toEqual({
      uri: 'http://host/a/init.mp4', byteRange: { length: 700, offset: 0 },
    });
    expect(media.segments[0].byteRange).toEqual({ length: 1000, offset: 700 });
    expect(media.segments[1].byteRange).toEqual({ length: 500, offset: 1700 });
  });
});

describe('isUnsupportedKey', () => {
  it('allows clear and AES-128 identity keys', () => {
    expect(isUnsupportedKey(null)).toBe(false);
    expect(isUnsupportedKey({ method: 'AES-128', uri: 'http://host/k', iv: null, keyFormat: null })).toBe(false);
    expect(isUnsupportedKey({ method: 'AES-128', uri: 'http://host/k', iv: null, keyFormat: 'identity' })).toBe(false);
  });

  it('rejects SAMPLE-AES and DRM key formats', () => {
    expect(isUnsupportedKey({ method: 'SAMPLE-AES', uri: 'http://host/k', iv: null, keyFormat: null })).toBe(true);
    expect(isUnsupportedKey({ method: 'SAMPLE-AES-CTR', uri: 'http://host/k', iv: null, keyFormat: null })).toBe(true);
    expect(isUnsupportedKey({ method: 'AES-128', uri: 'http://host/k', iv: null, keyFormat: 'l1' })).toBe(true);
  });
});

describe('ivHex', () => {
  const key = { method: 'AES-128', uri: 'http://host/k', iv: null, keyFormat: null };

  it('derives a big-endian IV from the media sequence', () => {
    expect(ivHex(key, 255)).toBe('000000000000000000000000000000ff');
  });

  it('uses and pads the IV attribute', () => {
    expect(ivHex({ method: 'AES-128', uri: 'http://host/k', iv: '0xAB', keyFormat: null }, 1))
      .toBe('000000000000000000000000000000ab');
  });
});

describe('live edge and polling', () => {
  function media(count: number, endList: boolean): MediaPlaylist {
    const segments = [];
    for (let i = 0; i < count; i++) {
      segments.push({ uri: 'http://host/a/' + i, duration: 6, sequence: i, key: null, map: null, byteRange: null });
    }
    return { kind: 'media', targetDuration: 6, mediaSequence: 0, endList: endList, segments: segments };
  }

  it('starts live playlists three segments from the end', () => {
    expect(liveStartIndex(media(10, false), 3)).toBe(7);
    expect(liveStartIndex(media(2, false), 3)).toBe(0);
    expect(liveStartIndex(media(10, true), 3)).toBe(0);
  });

  it('polls at half the target duration within 1-6 seconds', () => {
    expect(pollDelayMs(6)).toBe(3000);
    expect(pollDelayMs(1)).toBe(1000);
    expect(pollDelayMs(20)).toBe(6000);
  });
});
