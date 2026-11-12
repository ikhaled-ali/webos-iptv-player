import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { freeBytes, listLocations, parseDfAvailable } from './locations';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-locations-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('listLocations', () => {
  it('uses the first writable internal candidate', () => {
    const blocker = path.join(root, 'file');
    fs.writeFileSync(blocker, 'x');
    const locations = listLocations({
      internal: [path.join(blocker, 'nested'), path.join(root, 'internal'), path.join(root, 'other')],
      usb: [],
    });
    expect(locations).toEqual([
      { id: 'internal', kind: 'internal', name: 'internal', dir: path.join(root, 'internal') },
    ]);
    expect(fs.existsSync(path.join(root, 'other'))).toBe(false);
  });

  it('lists drives two levels under the USB root', () => {
    const usb = path.join(root, 'usb');
    fs.mkdirSync(path.join(usb, 'sda', 'sda1'), { recursive: true });
    fs.mkdirSync(path.join(usb, 'sdb', 'sdb1'), { recursive: true });
    fs.writeFileSync(path.join(usb, 'stray'), 'x');
    const locations = listLocations({ internal: [], usb: [{ root: usb, depth: 2 }] });
    expect(locations).toEqual([
      { id: 'usb:sda/sda1', kind: 'usb', name: 'sda1', dir: path.join(usb, 'sda', 'sda1', 'iptv-recordings') },
      { id: 'usb:sdb/sdb1', kind: 'usb', name: 'sdb1', dir: path.join(usb, 'sdb', 'sdb1', 'iptv-recordings') },
    ]);
    expect(fs.existsSync(path.join(usb, 'sda', 'sda1', 'iptv-recordings'))).toBe(true);
  });

  it('lists one level under a media root and ignores missing roots', () => {
    const media = path.join(root, 'media');
    fs.mkdirSync(path.join(media, 'drive1'), { recursive: true });
    const locations = listLocations({
      internal: [],
      usb: [{ root: path.join(root, 'missing'), depth: 2 }, { root: media, depth: 1 }],
    });
    expect(locations.map((l) => l.id)).toEqual(['usb:drive1']);
  });

  it('lists a drive reachable from two roots once', () => {
    const usb = path.join(root, 'usb');
    fs.mkdirSync(path.join(usb, 'sda', 'sda1'), { recursive: true });
    const media = path.join(root, 'media');
    fs.mkdirSync(media);
    fs.symlinkSync(path.join(usb, 'sda', 'sda1'), path.join(media, 'drive1'));
    const locations = listLocations({
      internal: [],
      usb: [{ root: usb, depth: 2 }, { root: media, depth: 1 }],
    });
    expect(locations.map((l) => l.id)).toEqual(['usb:sda/sda1']);
  });
});

describe('parseDfAvailable', () => {
  it('reads busybox df output', () => {
    expect(parseDfAvailable([
      'Filesystem           1K-blocks      Used Available Use% Mounted on',
      '/dev/sda1             15000000      1000  14999000   1% /tmp/usb/sda/sda1',
    ].join('\n'))).toBe(14999000 * 1024);
  });

  it('reads output whose device name wraps onto its own line', () => {
    expect(parseDfAvailable([
      'Filesystem           1K-blocks      Used Available Use% Mounted on',
      '/dev/mapper/a-very-long-device-name',
      '                       2000000    500000   1500000  25% /media/internal',
    ].join('\n'))).toBe(1500000 * 1024);
  });

  it('returns null for unparseable output', () => {
    expect(parseDfAvailable('')).toBeNull();
    expect(parseDfAvailable('df: l1: No such file or directory')).toBeNull();
  });
});

describe('freeBytes', () => {
  it('reports null when df fails', () => {
    let result: number | null | undefined;
    freeBytes('/x', (bytes) => { result = bytes; }, (_dir, cb) => cb(new Error('l1'), ''));
    expect(result).toBeNull();
  });

  it('passes the directory to df', () => {
    let seen = '';
    let result: number | null | undefined;
    freeBytes('/x', (bytes) => { result = bytes; }, (dir, cb) => {
      seen = dir;
      cb(null, 'Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/a 10 2 8 20% /x\n');
    });
    expect(seen).toBe('/x');
    expect(result).toBe(8 * 1024);
  });
});
