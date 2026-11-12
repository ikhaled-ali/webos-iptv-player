import * as nodeUrl from 'url';
import { padStart } from '../compat';

export interface HlsKey {
  method: string;
  uri: string | null;
  iv: string | null;
  keyFormat: string | null;
}

export interface HlsByteRange {
  length: number;
  offset: number;
}

export interface HlsMap {
  uri: string;
  byteRange: HlsByteRange | null;
}

export interface HlsSegment {
  uri: string;
  duration: number;
  sequence: number;
  key: HlsKey | null;
  map: HlsMap | null;
  byteRange: HlsByteRange | null;
}

export interface HlsVariant {
  uri: string;
  bandwidth: number;
  // True when the variant's AUDIO group points at separate rendition playlists.
  separateAudio: boolean;
}

export interface MasterPlaylist {
  kind: 'master';
  variants: HlsVariant[];
}

export interface MediaPlaylist {
  kind: 'media';
  targetDuration: number;
  mediaSequence: number;
  endList: boolean;
  segments: HlsSegment[];
}

export function resolveUri(base: string, uri: string): string {
  return nodeUrl.resolve(base, uri);
}

export function parseAttributes(input: string): { [name: string]: string } {
  const out: { [name: string]: string } = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input)) !== null) {
    let value = match[2];
    if (value.length >= 2 && value.charAt(0) === '"' && value.charAt(value.length - 1) === '"') {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

function parseByteRange(value: string, previousEnd: number | null): HlsByteRange | null {
  const match = /^\s*(\d+)(?:@(\d+))?\s*$/.exec(value);
  if (!match) return null;
  const length = parseInt(match[1], 10);
  const offset = match[2] !== undefined ? parseInt(match[2], 10) : (previousEnd !== null ? previousEnd : 0);
  return { length: length, offset: offset };
}

function tagValue(line: string): string {
  const colon = line.indexOf(':');
  return colon < 0 ? '' : line.slice(colon + 1);
}

function isTag(line: string, tag: string): boolean {
  return line.slice(0, tag.length) === tag;
}

export function isPlaylistText(text: string): boolean {
  return /^﻿?\s*#EXTM3U/.test(text);
}

export function parsePlaylist(text: string, baseUrl: string): MasterPlaylist | MediaPlaylist | null {
  if (!isPlaylistText(text)) return null;
  const lines = text.split(/\r?\n/);

  if (/#EXT-X-STREAM-INF/.test(text)) {
    const audioWithUri: { [group: string]: boolean } = {};
    const raw: Array<{ uri: string; bandwidth: number; group: string }> = [];
    let pending: { [name: string]: string } | null = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      if (isTag(line, '#EXT-X-MEDIA:')) {
        const attrs = parseAttributes(tagValue(line));
        if (attrs.TYPE === 'AUDIO' && attrs['GROUP-ID'] && attrs.URI) audioWithUri[attrs['GROUP-ID']] = true;
      } else if (isTag(line, '#EXT-X-STREAM-INF:')) {
        pending = parseAttributes(tagValue(line));
      } else if (line.charAt(0) !== '#' && pending) {
        raw.push({
          uri: resolveUri(baseUrl, line),
          bandwidth: parseInt(pending.BANDWIDTH || '0', 10) || 0,
          group: pending.AUDIO || '',
        });
        pending = null;
      }
    }
    // EXT-X-MEDIA may follow the variants, so audio groups resolve last.
    const variants: HlsVariant[] = raw.map((v) => ({
      uri: v.uri,
      bandwidth: v.bandwidth,
      separateAudio: !!v.group && audioWithUri[v.group] === true,
    }));
    return { kind: 'master', variants: variants };
  }

  const playlist: MediaPlaylist = {
    kind: 'media', targetDuration: 0, mediaSequence: 0, endList: false, segments: [],
  };
  let key: HlsKey | null = null;
  let map: HlsMap | null = null;
  let duration = 0;
  let range: string | null = null;
  let lastRangeEnd: number | null = null;
  let lastRangeUri: string | null = null;
  let sequence = 0;
  let sequenceSet = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.charAt(0) === '#') {
      if (isTag(line, '#EXT-X-TARGETDURATION:')) {
        playlist.targetDuration = parseFloat(tagValue(line)) || 0;
      } else if (isTag(line, '#EXT-X-MEDIA-SEQUENCE:')) {
        playlist.mediaSequence = parseInt(tagValue(line), 10) || 0;
        if (!sequenceSet) sequence = playlist.mediaSequence;
      } else if (isTag(line, '#EXTINF:')) {
        duration = parseFloat(tagValue(line)) || 0;
      } else if (isTag(line, '#EXT-X-BYTERANGE:')) {
        range = tagValue(line);
      } else if (isTag(line, '#EXT-X-KEY:')) {
        const attrs = parseAttributes(tagValue(line));
        const method = (attrs.METHOD || 'NONE').toUpperCase();
        key = method === 'NONE' ? null : {
          method: method,
          uri: attrs.URI ? resolveUri(baseUrl, attrs.URI) : null,
          iv: attrs.IV || null,
          keyFormat: attrs.KEYFORMAT || null,
        };
      } else if (isTag(line, '#EXT-X-MAP:')) {
        const attrs = parseAttributes(tagValue(line));
        map = attrs.URI ? {
          uri: resolveUri(baseUrl, attrs.URI),
          byteRange: attrs.BYTERANGE ? parseByteRange(attrs.BYTERANGE, null) : null,
        } : null;
      } else if (isTag(line, '#EXT-X-ENDLIST')) {
        playlist.endList = true;
      }
      continue;
    }
    sequenceSet = true;
    const uri = resolveUri(baseUrl, line);
    let byteRange: HlsByteRange | null = null;
    if (range !== null) {
      byteRange = parseByteRange(range, lastRangeUri === uri ? lastRangeEnd : null);
      lastRangeEnd = byteRange ? byteRange.offset + byteRange.length : null;
      lastRangeUri = uri;
    }
    playlist.segments.push({
      uri: uri, duration: duration, sequence: sequence, key: key, map: map, byteRange: byteRange,
    });
    sequence++;
    duration = 0;
    range = null;
  }
  return playlist;
}

// Highest bandwidth wins, but a variant with muxed audio beats one whose
// audio lives in a separate rendition we would not record.
export function pickVariant(master: MasterPlaylist): HlsVariant | null {
  let best: HlsVariant | null = null;
  for (let i = 0; i < master.variants.length; i++) {
    const v = master.variants[i];
    if (v.separateAudio) continue;
    if (!best || v.bandwidth > best.bandwidth) best = v;
  }
  return best;
}

export function isUnsupportedKey(key: HlsKey | null): boolean {
  if (!key) return false;
  if (key.method !== 'AES-128') return true;
  if (!key.uri) return true;
  return !!key.keyFormat && key.keyFormat !== 'identity';
}

export function liveStartIndex(playlist: MediaPlaylist, liveEdgeSegments: number): number {
  if (playlist.endList) return 0;
  return Math.max(0, playlist.segments.length - liveEdgeSegments);
}

export function ivHex(key: HlsKey, sequence: number): string {
  if (key.iv) {
    const hex = key.iv.replace(/^0x/i, '');
    if (/^[0-9a-f]{1,32}$/i.test(hex)) return padStart(hex, 32, '0').toLowerCase();
  }
  return padStart(Math.max(0, Math.floor(sequence)).toString(16), 32, '0');
}

export function pollDelayMs(targetDuration: number): number {
  const half = (targetDuration > 0 ? targetDuration : 4) / 2;
  return Math.round(Math.min(6, Math.max(1, half)) * 1000);
}
