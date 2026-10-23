import { describe, expect, it } from 'vitest';
import { nativeHlsQualities } from './native-hls-quality';

describe('native HLS qualities', () => {
  it('resolves standalone variants and reads their advertised quality', () => {
    const options = nativeHlsQualities([
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=854x480,FRAME-RATE=30',
      'low.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=5000000,AVERAGE-BANDWIDTH=4000000,RESOLUTION=1920x1080',
      '../high.m3u8',
    ].join('\n'), 'http://host/a/master.m3u8');
    expect(options).toEqual([
      { index: 0, width: 854, height: 480, bitrate: 1000000, frameRate: 30, available: true, url: 'http://host/a/low.m3u8' },
      { index: 1, width: 1920, height: 1080, bitrate: 4000000, frameRate: 0, available: true, url: 'http://host/high.m3u8' },
    ]);
  });

  it('keeps externally demuxed audio variants read-only to avoid losing audio', () => {
    const options = nativeHlsQualities([
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a1",NAME="Track 1",URI="audio.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=854x480,AUDIO="a1"',
      'low.m3u8',
    ].join('\n'), 'http://host/master.m3u8');
    expect(options[0].available).toBe(false);
  });

  it('rejects unsafe schemes and does not invent variants from a media playlist', () => {
    expect(nativeHlsQualities('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\njavascript:alert(1)', 'http://host/a')).toEqual([]);
    expect(nativeHlsQualities('#EXTM3U\n#EXTINF:6,\na.ts', 'http://host/a')).toEqual([]);
  });
});
