import type { QualityOption } from './playback-quality';

export interface NativeHlsQuality extends QualityOption {
  url: string;
}

export function nativeHlsQualities(manifest: string, masterUrl: string): NativeHlsQuality[] {
  const lines = manifest.split(/\r?\n/).map(line => line.trim());
  const externalAudio = new Set<string>();
  for (const line of lines) {
    if (!line.startsWith('#EXT-X-MEDIA:') || !/[:,]TYPE=AUDIO(?:,|$)/i.test(line)) continue;
    const group = line.match(/[:,]GROUP-ID="([^"]*)"/i)?.[1];
    if (group && /[:,]URI="[^"]+"/i.test(line)) externalAudio.add(group);
  }
  const options: NativeHlsQuality[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
    let uri = '';
    for (let next = index + 1; next < lines.length; next++) {
      if (!lines[next]) continue;
      if (lines[next].startsWith('#EXT-X-STREAM-INF:')) break;
      if (lines[next].startsWith('#')) continue;
      uri = lines[next];
      break;
    }
    if (!uri) continue;
    try {
      const url = new URL(uri, masterUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      const resolution = line.match(/[:,]RESOLUTION=(\d+)x(\d+)/i);
      const bandwidth = line.match(/[:,]AVERAGE-BANDWIDTH=(\d+)/i)
        ?? line.match(/[:,]BANDWIDTH=(\d+)/i);
      const audio = line.match(/[:,]AUDIO="([^"]*)"/i)?.[1];
      options.push({
        index: options.length,
        width: resolution ? Number(resolution[1]) : 0,
        height: resolution ? Number(resolution[2]) : 0,
        bitrate: bandwidth ? Number(bandwidth[1]) : 0,
        frameRate: Number(line.match(/[:,]FRAME-RATE=([\d.]+)/i)?.[1] || 0),
        // A standalone variant omits separate audio renditions from the master.
        available: !audio || !externalAudio.has(audio),
        url: url.href,
      });
    } catch { /* Ignore malformed variant URLs. */ }
  }
  return options;
}
