import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { mkdirRecursive } from '../compat';

export type LocationKind = 'internal' | 'usb';

export interface RecordingLocation {
  id: string;
  kind: LocationKind;
  name: string;
  dir: string;
}

export interface UsbRoot {
  root: string;
  // How many directory levels below `root` a drive is mounted.
  depth: number;
}

export interface LocationRoots {
  internal: string[];
  usb: UsbRoot[];
}

const RECORDINGS_DIR = 'iptv-recordings';
const DF_TIMEOUT_MS = 5000;

export function defaultLocationRoots(envOverride?: string): LocationRoots {
  return {
    internal: [
      envOverride,
      '/media/internal/iptv-recordings',
      path.join(__dirname, '..', 'recordings'),
      '/tmp/iptv-recordings',
    ].filter((candidate): candidate is string => !!candidate),
    // webOS mounts drives at /tmp/usb/sda/sda1.
    usb: [{ root: '/tmp/usb', depth: 2 }, { root: '/media/usb', depth: 1 }],
  };
}

export function probeWritable(dir: string): boolean {
  try {
    mkdirRecursive(dir);
    const probe = path.join(dir, '.probe');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function mountsUnder(dir: string, depth: number): string[] {
  if (depth <= 0) return [dir];
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  entries.sort();
  const out: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].charAt(0) === '.') continue;
    const child = path.join(dir, entries[i]);
    if (!isDirectory(child)) continue;
    const nested = mountsUnder(child, depth - 1);
    for (let j = 0; j < nested.length; j++) out.push(nested[j]);
  }
  return out;
}

function identity(dir: string): string | null {
  try {
    const stat = fs.statSync(dir);
    return stat.dev + ':' + stat.ino;
  } catch {
    return null;
  }
}

export function listLocations(roots: LocationRoots): RecordingLocation[] {
  const out: RecordingLocation[] = [];
  // A drive visible under two roots must not list its recordings twice.
  const seen: { [identity: string]: boolean } = {};
  function add(location: RecordingLocation): void {
    const key = identity(location.dir);
    if (key !== null) {
      if (seen[key]) return;
      seen[key] = true;
    }
    out.push(location);
  }

  for (let i = 0; i < roots.internal.length; i++) {
    if (!probeWritable(roots.internal[i])) continue;
    add({ id: 'internal', kind: 'internal', name: 'internal', dir: roots.internal[i] });
    break;
  }

  for (let i = 0; i < roots.usb.length; i++) {
    const usbRoot = roots.usb[i];
    const mounts = mountsUnder(usbRoot.root, usbRoot.depth);
    for (let j = 0; j < mounts.length; j++) {
      const dir = path.join(mounts[j], RECORDINGS_DIR);
      if (!probeWritable(dir)) continue;
      const relative = path.relative(usbRoot.root, mounts[j]).split(path.sep).join('/');
      add({ id: 'usb:' + relative, kind: 'usb', name: path.basename(mounts[j]), dir: dir });
    }
  }
  return out;
}

// busybox prints long device names on their own line, so read the token
// before the "Use%" column instead of a fixed column.
export function parseDfAvailable(output: string): number | null {
  const lines = output.split(/\r?\n/);
  const tokens = lines.slice(1).join(' ').split(/\s+/).filter((t) => t.length > 0);
  for (let i = 1; i < tokens.length; i++) {
    if (!/^\d+%$/.test(tokens[i])) continue;
    const available = parseInt(tokens[i - 1], 10);
    return /^\d+$/.test(tokens[i - 1]) && isFinite(available) ? available * 1024 : null;
  }
  return null;
}

export type DfRunner = (
  dir: string,
  cb: (err: Error | null, stdout: string) => void,
) => void;

const runDf: DfRunner = (dir, cb) => {
  childProcess.execFile('df', ['-k', dir], { timeout: DF_TIMEOUT_MS }, (err, stdout) => {
    cb(err, String(stdout || ''));
  });
};

export function freeBytes(dir: string, cb: (bytes: number | null) => void, run?: DfRunner): void {
  try {
    (run || runDf)(dir, (err, stdout) => cb(err ? null : parseDfAvailable(stdout)));
  } catch {
    cb(null);
  }
}
