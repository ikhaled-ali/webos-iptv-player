import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  cleanupPartFiles, commitRecording, deleteRecordingIn, isValidRecordingId, listRecordingsIn,
  mediaPath, metaPath, newRecordingId, partPath, type RecordingMeta,
} from './store';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-store-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function meta(id: string, startedAt: number): RecordingMeta {
  return {
    id: id, channelId: 'ch1', channelName: 'Alpha', logo: 'http://host/a/logo.png',
    programTitle: 'Bravo', startedAt: startedAt, durationSecs: 61.6, bytes: 0, ext: 'ts',
  };
}

describe('recording ids', () => {
  it('generates ids that validate', () => {
    const id = newRecordingId(1700000000000);
    expect(id).toMatch(/^rec-1700000000000-[0-9a-f]{4}$/);
    expect(isValidRecordingId(id)).toBe(true);
  });

  it('rejects path tricks and malformed ids', () => {
    expect(isValidRecordingId('../rec-1700000000000-abcd')).toBe(false);
    expect(isValidRecordingId('rec-1700000000000-ABCD')).toBe(false);
    expect(isValidRecordingId('rec-170000000000-abcd')).toBe(false);
    expect(isValidRecordingId(42)).toBe(false);
    expect(() => mediaPath(dir, '../x', 'ts')).toThrow();
  });
});

describe('commitRecording', () => {
  it('renames the part file and writes metadata', () => {
    const id = 'rec-1700000000000-abcd';
    fs.writeFileSync(partPath(dir, id, 'ts'), 'data');
    expect(commitRecording(dir, meta(id, 1700000000000))).toBe(true);
    expect(fs.existsSync(partPath(dir, id, 'ts'))).toBe(false);
    expect(fs.readFileSync(mediaPath(dir, id, 'ts'), 'utf-8')).toBe('data');
    const saved = JSON.parse(fs.readFileSync(metaPath(dir, id), 'utf-8'));
    expect(saved).toEqual({
      id: id, channelId: 'ch1', channelName: 'Alpha', logo: 'http://host/a/logo.png',
      programTitle: 'Bravo', startedAt: 1700000000000, durationSecs: 62, bytes: 4, ext: 'ts',
    });
  });

  it('discards an empty part file', () => {
    const id = 'rec-1700000000000-abcd';
    fs.writeFileSync(partPath(dir, id, 'ts'), '');
    expect(commitRecording(dir, meta(id, 1700000000000))).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe('listRecordingsIn', () => {
  it('lists committed recordings with the media file size', () => {
    const a = 'rec-1700000000000-aaaa';
    const b = 'rec-1700000001000-bbbb';
    fs.writeFileSync(partPath(dir, a, 'ts'), '12345');
    commitRecording(dir, meta(a, 1700000000000));
    fs.writeFileSync(partPath(dir, b, 'mp4'), '12');
    const mp4 = meta(b, 1700000001000);
    mp4.ext = 'mp4';
    commitRecording(dir, mp4);
    fs.appendFileSync(mediaPath(dir, b, 'mp4'), '3');

    const list = listRecordingsIn(dir).sort((x, y) => x.meta.startedAt - y.meta.startedAt);
    expect(list.map((r) => [r.meta.id, r.meta.ext, r.meta.bytes])).toEqual([[a, 'ts', 5], [b, 'mp4', 3]]);
    expect(list[1].file).toBe(mediaPath(dir, b, 'mp4'));
  });

  it('skips metadata without media, foreign files, and mismatched ids', () => {
    fs.writeFileSync(metaPath(dir, 'rec-1700000000000-aaaa'), JSON.stringify(meta('rec-1700000000000-aaaa', 1)));
    fs.writeFileSync(path.join(dir, 'other.json'), '{}');
    fs.writeFileSync(metaPath(dir, 'rec-1700000000000-bbbb'), JSON.stringify(meta('rec-1700000000000-cccc', 1)));
    fs.writeFileSync(mediaPath(dir, 'rec-1700000000000-bbbb', 'ts'), 'x');
    expect(listRecordingsIn(dir)).toEqual([]);
  });

  it('returns nothing for a missing directory', () => {
    expect(listRecordingsIn(path.join(dir, 'missing'))).toEqual([]);
  });
});

describe('deleteRecordingIn', () => {
  it('removes media and metadata', () => {
    const id = 'rec-1700000000000-abcd';
    fs.writeFileSync(partPath(dir, id, 'ts'), 'data');
    commitRecording(dir, meta(id, 1700000000000));
    expect(deleteRecordingIn(dir, id)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(deleteRecordingIn(dir, id)).toBe(false);
  });
});

describe('cleanupPartFiles', () => {
  it('removes stale part files but keeps the active one', () => {
    fs.writeFileSync(partPath(dir, 'rec-1700000000000-aaaa', 'ts'), 'x');
    fs.writeFileSync(partPath(dir, 'rec-1700000000000-bbbb', 'mp4'), 'x');
    fs.writeFileSync(path.join(dir, 'other.part'), 'x');
    expect(cleanupPartFiles(dir, 'rec-1700000000000-bbbb')).toBe(1);
    expect(fs.readdirSync(dir).sort()).toEqual(['other.part', 'rec-1700000000000-bbbb.mp4.part']);
  });
});
