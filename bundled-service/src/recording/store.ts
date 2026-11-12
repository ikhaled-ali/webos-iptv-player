import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export type RecordingExt = 'ts' | 'mp4';

export interface RecordingMeta {
  id: string;
  channelId: string;
  channelName: string;
  logo: string;
  programTitle: string;
  startedAt: number;
  durationSecs: number;
  bytes: number;
  ext: RecordingExt;
}

export interface StoredRecording {
  meta: RecordingMeta;
  file: string;
}

const ID_PATTERN = /^rec-\d{13}-[0-9a-f]{4}$/;
const META_FILE = /^(rec-\d{13}-[0-9a-f]{4})\.json$/;
const PART_FILE = /^(rec-\d{13}-[0-9a-f]{4})\.(?:ts|mp4)\.part$/;

export function isValidRecordingId(id: unknown): id is string {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

export function newRecordingId(now: number): string {
  return 'rec-' + now + '-' + crypto.randomBytes(2).toString('hex');
}

function checkedId(id: string): string {
  if (!isValidRecordingId(id)) throw new Error('Invalid recording id');
  return id;
}

export function mediaPath(dir: string, id: string, ext: RecordingExt): string {
  return path.join(dir, checkedId(id) + '.' + ext);
}

export function partPath(dir: string, id: string, ext: RecordingExt): string {
  return mediaPath(dir, id, ext) + '.part';
}

export function metaPath(dir: string, id: string): string {
  return path.join(dir, checkedId(id) + '.json');
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number {
  return typeof value === 'number' && isFinite(value) && value >= 0 ? value : 0;
}

export function parseMeta(raw: string, expectedId: string): RecordingMeta | null {
  let data: { [name: string]: unknown };
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || data.id !== expectedId) return null;
  const ext = data.ext;
  if (ext !== 'ts' && ext !== 'mp4') return null;
  return {
    id: expectedId,
    channelId: str(data.channelId),
    channelName: str(data.channelName),
    logo: str(data.logo),
    programTitle: str(data.programTitle),
    startedAt: num(data.startedAt),
    durationSecs: num(data.durationSecs),
    bytes: num(data.bytes),
    ext: ext,
  };
}

export function readRecording(dir: string, id: string): StoredRecording | null {
  try {
    const meta = parseMeta(fs.readFileSync(metaPath(dir, id), 'utf-8'), id);
    if (!meta) return null;
    const file = mediaPath(dir, id, meta.ext);
    // The media file is the truth for size; metadata may predate a crash.
    meta.bytes = fs.statSync(file).size;
    return { meta: meta, file: file };
  } catch {
    return null;
  }
}

export function listRecordingsIn(dir: string): StoredRecording[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: StoredRecording[] = [];
  for (let i = 0; i < entries.length; i++) {
    const match = META_FILE.exec(entries[i]);
    if (!match) continue;
    const recording = readRecording(dir, match[1]);
    if (recording) out.push(recording);
  }
  return out;
}

function unlinkQuietly(file: string): boolean {
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

export function deleteRecordingIn(dir: string, id: string): boolean {
  const recording = readRecording(dir, id);
  let removed = false;
  if (recording) removed = unlinkQuietly(recording.file) || removed;
  else {
    removed = unlinkQuietly(mediaPath(dir, id, 'ts')) || removed;
    removed = unlinkQuietly(mediaPath(dir, id, 'mp4')) || removed;
  }
  removed = unlinkQuietly(metaPath(dir, id)) || removed;
  return removed;
}

export function discardPart(dir: string, id: string, ext: RecordingExt): void {
  unlinkQuietly(partPath(dir, id, ext));
}

// Renames the finished .part into place and writes its metadata. Returns
// false (and removes the part) when nothing was recorded.
export function commitRecording(dir: string, meta: RecordingMeta): boolean {
  const part = partPath(dir, meta.id, meta.ext);
  let size = 0;
  try {
    size = fs.statSync(part).size;
  } catch {
    return false;
  }
  if (size === 0) {
    unlinkQuietly(part);
    return false;
  }
  fs.renameSync(part, mediaPath(dir, meta.id, meta.ext));
  const saved: RecordingMeta = {
    id: meta.id,
    channelId: meta.channelId,
    channelName: meta.channelName,
    logo: meta.logo,
    programTitle: meta.programTitle,
    startedAt: meta.startedAt,
    durationSecs: Math.max(0, Math.round(meta.durationSecs)),
    bytes: size,
    ext: meta.ext,
  };
  const tmp = metaPath(dir, meta.id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(saved));
  fs.renameSync(tmp, metaPath(dir, meta.id));
  return true;
}

export function cleanupPartFiles(dir: string, activeId: string | null): number {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (let i = 0; i < entries.length; i++) {
    const match = PART_FILE.exec(entries[i]);
    if (!match || match[1] === activeId) continue;
    if (unlinkQuietly(path.join(dir, entries[i]))) removed++;
  }
  return removed;
}
