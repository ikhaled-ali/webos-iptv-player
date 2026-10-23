import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { bufferFrom, mkdirRecursive, stringEndsWith } from '../compat';

export interface UploadMeta {
  id: string;
  name: string;
  count: number;
  createdAt: number;
}

/**
 * Probe a list of candidate dirs and return the first writable one. The
 * service install dir is read-only and /tmp is wiped on reboot, so prefer
 * persistent storage. Logs each probe so failures are visible in the device
 * log (you can curl /info or check the service stdout to confirm).
 */
export function resolveDataDir(envOverride?: string): string {
  const candidates: string[] = [
    envOverride,
    '/media/internal/iptv-uploads',
    path.join(__dirname, 'uploads'),
    '/tmp/iptv-uploads',
  ].filter((candidate): candidate is string => !!candidate);

  for (const dir of candidates) {
    try {
      mkdirRecursive(dir);
      const probe = path.join(dir, '.probe');
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      console.log('[upload] resolveDataDir: using ' + dir);
      return dir;
    } catch (e) {
      console.log('[upload] resolveDataDir: candidate ' + dir + ' not writable: ' +
        (e instanceof Error ? e.message : String(e)));
    }
  }

  const fallback = '/tmp/iptv-uploads';
  try { mkdirRecursive(fallback); } catch { /* ignore */ }
  console.warn('[upload] resolveDataDir: all candidates failed, falling back to ' + fallback);
  return fallback;
}

function sanitizeId(name: string): string {
  const base = String(name).replace(/\.m3u8?$/i, '');
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return isValidUploadId(slug) ? slug : 'playlist';
}

export function isValidUploadId(id: string): boolean {
  return /^[a-z0-9._-]{1,60}$/.test(id) && id !== '.' && id !== '..';
}

function countChannels(content: string): number {
  const matches = content.match(/^#EXTINF:/gm);
  return matches ? matches.length : 0;
}

export class UploadStore {
  private encryptionKey: Buffer | null = null;
  constructor(private readonly dataDir: string, private readonly encryptionRequired = false) {}

  unlock(encodedKey: string): void {
    if (!/^[A-Za-z0-9+/]{43}=$/.test(encodedKey)) throw new Error('Invalid storage key');
    const key = bufferFrom(encodedKey, 'base64');
    if (key.length !== 32) throw new Error('Invalid storage key');
    const previous = this.encryptionKey;
    this.encryptionKey = key;
    try {
      const pending: Array<{ file: string; value: string }> = [];
      const entries = fs.readdirSync(this.dataDir);
      for (const entry of entries) {
        if (!/^[a-z0-9._-]+\.(m3u|json)$/.test(entry)) continue;
        const file = path.join(this.dataDir, entry);
        const raw = fs.readFileSync(file, 'utf-8');
        const decoded = this.decode(raw, entry);
        if (raw.indexOf('IPTV-URL1:') >= 0 && raw.indexOf('IPTV-SEAL1:') !== 0) continue;
        const encoded = this.encode(decoded, entry);
        if (encoded !== raw) pending.push({ file: file, value: encoded });
      }
      for (const item of pending) this.atomicWrite(item.file, item.value);
    } catch (error) { this.encryptionKey = previous; throw error; }
  }

  private atomicWrite(file: string, value: string): void {
    const temporary = file + '.sealed-tmp';
    fs.writeFileSync(temporary, value, { encoding: 'utf-8', mode: 384 });
    fs.chmodSync(temporary, 384);
    fs.renameSync(temporary, file);
  }

  private encrypt(value: string, context: string): string {
    if (!this.encryptionKey) throw new Error('Upload storage locked');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    cipher.setAAD(bufferFrom(context, 'utf8'));
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return JSON.stringify({ iv: iv.toString('base64'),
      data: data.toString('base64'), tag: cipher.getAuthTag().toString('base64') });
  }

  private decrypt(value: string, context: string): string {
    if (!this.encryptionKey) throw new Error('Upload storage locked');
    const sealed = JSON.parse(value) as { iv: string; data: string; tag: string };
    const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, bufferFrom(sealed.iv, 'base64'));
    decipher.setAAD(bufferFrom(context, 'utf8'));
    decipher.setAuthTag(bufferFrom(sealed.tag, 'base64'));
    return Buffer.concat([decipher.update(bufferFrom(sealed.data, 'base64')), decipher.final()]).toString('utf8');
  }

  private encode(value: string, context: string): string {
    if (!this.encryptionKey) {
      if (this.encryptionRequired) throw new Error('Upload storage locked');
      return value;
    }
    if (stringEndsWith(context, '.json')) return value;
    return value.replace(/(?:https?|rtsp):\/\/[^\s<>"']+/gi, (url: string, offset: number) => {
      const line = value.slice(value.lastIndexOf('\n', offset) + 1, offset).trim();
      const credentialUrl = /[?&](?:user(?:name)?|pass(?:word)?|token|key|api[_-]?key|signature|sig)=|:\/\/[^/]+@|\/(?:live|movie|series|timeshift)\/[^/]+\/[^/]+\//i.test(url);
      if (line.charAt(0) === '#' && !credentialUrl) return url;
      return 'IPTV-URL1:' + bufferFrom(this.encrypt(url, context), 'utf8').toString('base64');
    });
  }

  private decode(value: string, context: string): string {
    if (this.encryptionRequired && !this.encryptionKey) throw new Error('Upload storage locked');
    if (value.indexOf('IPTV-SEAL1:') === 0) return this.decrypt(value.slice(11), context);
    return value.replace(/IPTV-URL1:([A-Za-z0-9+/]+=*)/g, (_match: string, encoded: string) =>
      this.decrypt(bufferFrom(encoded, 'base64').toString('utf8'), context));
  }

  private storagePath(id: string, extension: '.json' | '.m3u'): string {
    if (!isValidUploadId(id)) throw new Error('Invalid upload id');
    const resolved = path.resolve(this.dataDir, id + extension);
    const root = path.resolve(this.dataDir) + path.sep;
    if (resolved.indexOf(root) !== 0) throw new Error('Invalid upload path');
    return resolved;
  }

  private metaPath(id: string): string {
    return this.storagePath(id, '.json');
  }

  private filePath(id: string): string {
    return this.storagePath(id, '.m3u');
  }

  list(): UploadMeta[] {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.dataDir);
    } catch {
      return [];
    }
    const out: UploadMeta[] = [];
    for (const file of entries) {
      if (!stringEndsWith(file, '.json')) continue;
      try {
        const meta = JSON.parse(
          this.decode(fs.readFileSync(path.join(this.dataDir, file), 'utf-8'), file),
        ) as UploadMeta;
        if (fs.existsSync(this.filePath(meta.id))) out.push(meta);
      } catch {
        // Skip malformed metadata.
      }
    }
    out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return out;
  }

  save(rawName: string, content: string): UploadMeta {
    if (!/#EXTM3U/.test(content) && !/^#EXTINF:/m.test(content)) {
      throw new Error('Not a valid M3U playlist (missing #EXTM3U/#EXTINF)');
    }
    const id = sanitizeId(rawName || 'playlist');
    const name = String(rawName || id).replace(/\.m3u8?$/i, '').trim() || id;
    const meta: UploadMeta = {
      id,
      name,
      count: countChannels(content),
      createdAt: Date.now(),
    };
    const m3uPath = this.filePath(id);
    const jsonPath = this.metaPath(id);
    this.atomicWrite(m3uPath, this.encode(content, id + '.m3u'));
    this.atomicWrite(jsonPath, this.encode(JSON.stringify(meta), id + '.json'));
    console.log('[upload] wrote ' + m3uPath + ' (' + content.length + ' bytes)');
    console.log('[upload] wrote ' + jsonPath);
    return meta;
  }

  delete(id: string): boolean {
    let removed = false;
    for (const file of [this.filePath(id), this.metaPath(id)]) {
      try {
        fs.unlinkSync(file);
        console.log('[upload] removed ' + file);
        removed = true;
      } catch { /* file already gone */ }
    }
    return removed;
  }

  read(id: string): string {
    return this.decode(fs.readFileSync(this.filePath(id), 'utf-8'), id + '.m3u');
  }
}
