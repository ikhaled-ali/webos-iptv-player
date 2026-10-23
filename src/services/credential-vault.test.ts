// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { webcrypto, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const SECRET = 'synthetic-secret-123';
const URL = 'http://host/live/user1/' + SECRET + '/1';
let rootKey = randomBytes(32);
let sdkVersion = '10.3.2';
let handles = new Map<string, { decrypt: boolean; iv: Buffer }>();
let calls: { method: string; payload: Record<string, any> }[] = [];
class Bridge {
  onservicecallback: ((message: string) => void) | null = null;
  cancel(): void {}
  call(uri: string, data: string): void {
    const method = uri.slice(uri.lastIndexOf('/') + 1);
    const payload = JSON.parse(data);
    calls.push({ method, payload });
    let response: Record<string, unknown> = { returnValue: true };
    try {
      if (method === 'getSystemInfo') response.sdkVersion = sdkVersion;
      if (method === 'generateKey' && Object.prototype.hasOwnProperty.call(payload.params, 'mac_length')) {
        response = { returnValue: false, errorCode: -20033 };
      }
      if (method === 'begin') {
        const iv = payload.params.iv ? Buffer.from(payload.params.iv, 'base64') : randomBytes(12);
        handles.set('1', { decrypt: payload.params.purpose[0] === 'decrypt', iv });
        response = { returnValue: true, handle: '1', iv: iv.toString('base64') };
      } else if (method === 'finish') {
        const operation = handles.get(payload.handle)!;
        const input = Buffer.from(payload.data, 'base64');
        let output: Buffer;
        if (operation.decrypt) {
          const cipher = createDecipheriv('aes-256-gcm', rootKey, operation.iv);
          cipher.setAuthTag(input.subarray(input.length - 16));
          output = Buffer.concat([cipher.update(input.subarray(0, input.length - 16)), cipher.final()]);
        } else {
          const cipher = createCipheriv('aes-256-gcm', rootKey, operation.iv);
          output = Buffer.concat([cipher.update(input), cipher.final(), cipher.getAuthTag()]);
        }
        handles.delete(payload.handle);
        response.output = output.toString('base64');
      } else if (method === 'abort') handles.delete(payload.handle);
    } catch { response = { returnValue: false, errorCode: -20030 }; }
    Promise.resolve().then(() => this.onservicecallback?.(JSON.stringify(response)));
  }
}
async function removeDb(name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  await removeDb('iptv-protected-keys');
  await removeDb('iptv');
  rootKey = randomBytes(32); handles = new Map(); calls = []; sdkVersion = '10.3.2';
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  Object.defineProperty(window, 'PalmServiceBridge', { configurable: true, value: Bridge });
});

describe('protected credential persistence', () => {
  it('upgrades previous whole-settings and user snapshots without losing credentials or preferences', async () => {
    const vault = await import('./credential-vault');
    await vault.initCredentialVault();
    const previous = { iptv_theme: JSON.stringify('dark'), iptv_playlists: JSON.stringify([{ url: URL }]) };
    localStorage.setItem('iptv_sealed_local_v1', JSON.stringify(await vault.seal(previous, 'local-config')));
    const database = await import('./idb-database');
    const db = (await database.openPersistenceDb())!;
    const favorite = { key: URL, value: URL };
    const sealed = await vault.seal([favorite], 'user:favorites');
    const tx = db.transaction('favorites', 'readwrite');
    tx.objectStore('favorites').put({ key: 'sealed-user-v1', value: sealed });
    await database.transactionDone(tx);
    await (await import('./secure-persistence')).initSecurePersistence();
    const local = await import('./secure-local');
    expect(local.localValue('iptv_playlists')).toBe(previous.iptv_playlists);
    expect(localStorage.getItem('iptv_theme')).toBe(JSON.stringify('dark'));
    expect(localStorage.getItem('iptv_sealed_local_v1')).toBeNull();
    expect(JSON.stringify(localStorage)).not.toContain(SECRET);
    expect(await (await import('./idb-user-data')).loadUserRecords('favorites')).toEqual([favorite]);
    db.close();
  });

  it('migrates plaintext settings and decrypts after a restart with a hardware-wrapped key', async () => {
    localStorage.setItem('iptv_log_level', 'warn');
    localStorage.setItem('iptv_playlists', JSON.stringify([{ url: URL, xtream: { password: SECRET } }]));
    let local = await import('./secure-local');
    await local.initSecureLocal();
    expect(local.localValue('iptv_playlists')).toContain(SECRET);
    expect(localStorage.getItem('iptv_playlists')).not.toContain(SECRET);
    expect(localStorage.getItem('iptv_log_level')).toBe('warn');
    expect(JSON.stringify(localStorage)).not.toContain(SECRET);
    expect(calls.find(call => call.method === 'generateKey')!.payload.params).toMatchObject({ mode: ['GCM'], size: 256 });
    expect(calls.find(call => call.method === 'generateKey')!.payload.params).not.toHaveProperty('mac_length');
    for (const call of calls.filter(call => call.method === 'begin')) {
      expect(call.payload.params.mac_length).toBe('128');
    }
    vi.resetModules();
    local = await import('./secure-local');
    await local.initSecureLocal();
    expect(local.localValue('iptv_playlists')).toContain(URL);
    local.writeLocalValue('iptv_online_subtitles', JSON.stringify({ password: SECRET }));
    await local.flushSecureLocal();
    expect(JSON.stringify(localStorage)).not.toContain(SECRET);
  });

  it('keeps older TVs working without Keymanager3 and upgrades the same data key on newer firmware', async () => {
    sdkVersion = '4.0.0';
    let local = await import('./secure-local');
    await local.initSecureLocal();
    local.writeLocalValue('iptv_playlists', JSON.stringify([{ url: URL }]));
    await local.flushSecureLocal();
    expect(calls.some(call => call.method === 'generateKey')).toBe(false);
    expect(JSON.stringify(localStorage)).not.toContain(SECRET);
    vi.resetModules();
    sdkVersion = '10.3.2';
    local = await import('./secure-local');
    await local.initSecureLocal();
    expect(local.localValue('iptv_playlists')).toContain(SECRET);
    expect(calls.some(call => call.method === 'generateKey')).toBe(true);
    vi.resetModules();
    local = await import('./secure-local');
    await local.initSecureLocal();
    expect(local.localValue('iptv_playlists')).toContain(SECRET);
  });

  it('migrates old snapshots while retaining ordinary user records', async () => {
    localStorage.setItem('iptv_playlists', JSON.stringify([{ id: 'p1', name: 'List 1', url: URL }]));
    const database = await import('./idb-database');
    const db = (await database.openPersistenceDb())!;
    const tx = db.transaction(['favorites', 'playlist-cache'], 'readwrite');
    tx.objectStore('favorites').put({ key: URL, value: URL });
    tx.objectStore('playlist-cache').put({ key: 'old', data: URL });
    await database.transactionDone(tx);
    await (await import('./secure-persistence')).initSecurePersistence();
    expect(await database.requestResult(db.transaction('playlist-cache').objectStore('playlist-cache').count())).toBe(0);
    const raw = await database.requestResult(db.transaction('favorites').objectStore('favorites').getAll());
    expect(JSON.stringify(raw)).not.toContain(SECRET);
    expect((await (await import('./idb-user-data')).loadUserRecords('favorites'))[0].value).toBe(URL);
    expect((raw as { key: string }[])[0].key).not.toBe('sealed-user-v1');
    db.close();
  });

  it('fails closed when protected keys are unavailable on a modern TV', async () => {
    class UnavailableBridge extends Bridge {
      call(uri: string, payload: string): void {
        if (uri.indexOf('keymanager3') >= 0) {
          Promise.resolve().then(() => this.onservicecallback?.(JSON.stringify({ returnValue: false, errorCode: -10000 })));
        } else super.call(uri, payload);
      }
    }
    Object.defineProperty(window, 'PalmServiceBridge', { configurable: true, value: UnavailableBridge });
    localStorage.setItem('iptv_playlists', JSON.stringify([{ url: URL }]));
    await expect((await import('./secure-local')).initSecureLocal()).rejects.toThrow('Protected key request failed');
    expect(localStorage.getItem('iptv_playlists')).toContain(SECRET);
    expect(localStorage.getItem('iptv_sealed_credentials_v2')).toBeNull();
  });

  it('rejects tampering and context swaps and uses a fresh nonce for every write', async () => {
    const vault = await import('./credential-vault');
    await vault.initCredentialVault();
    const date = new Date('2024-01-01T00:00:00Z');
    const special = { __iptv_sealed_type__: 'date', value: 'ordinary-provider-text' };
    expect(await vault.unseal(await vault.seal({ date, special }, 'types'), 'types')).toEqual({ date, special });
    const one = await vault.seal({ password: SECRET }, 'one');
    const two = await vault.seal({ password: SECRET }, 'one');
    expect(one.iv).not.toBe(two.iv);
    expect(await vault.unseal(one, 'one')).toEqual({ password: SECRET });
    await expect(vault.unseal(one, 'two')).rejects.toBeTruthy();
    await expect(vault.unseal({ ...one, data: 'AAAA' + one.data.slice(4) }, 'one')).rejects.toBeTruthy();
  });

  it('keeps original settings when encrypted migration cannot be persisted', async () => {
    localStorage.setItem('iptv_playlists', JSON.stringify([{ url: URL }]));
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    const local = await import('./secure-local');
    await expect(local.initSecureLocal()).rejects.toThrow('quota');
    expect(localStorage.getItem('iptv_playlists')).toContain(SECRET);
    spy.mockRestore();
  });

  it('never replaces a damaged vault with empty settings', async () => {
    const local = await import('./secure-local');
    await local.initSecureLocal();
    local.writeLocalValue('iptv_playlists', JSON.stringify([{ url: URL }]));
    await local.flushSecureLocal();
    const stored = JSON.parse(localStorage.getItem('iptv_sealed_credentials_v2')!);
    stored.data = 'AAAA' + stored.data.slice(4);
    localStorage.setItem('iptv_sealed_credentials_v2', JSON.stringify(stored));
    vi.resetModules();
    await expect((await import('./secure-local')).initSecureLocal()).rejects.toBeTruthy();
    expect(localStorage.getItem('iptv_sealed_credentials_v2')).toBe(JSON.stringify(stored));
  });

  it('protects credentials while keeping ordinary cache and user data unencrypted', async () => {
    const local = await import('./secure-local');
    await local.initSecureLocal();
    const dbApi = await import('./idb-database');
    const db = (await dbApi.openPersistenceDb())!;
    const users = await import('./idb-user-data');
    const caches = await import('./idb-cache');
    await caches.clearAllCachedData();
    await users.applyUserChanges('favorites', [{ key: URL, value: URL }]);
    await caches.setCachedEpg(URL, {
      channels: { ch1: { name: 'ch1', icon: '' } },
      programmes: { ch1: [{ start: new Date('2024-01-01T00:00:00Z'), stop: new Date('2024-01-01T01:00:00Z'), title: 'p1', description: '', category: '', icon: '' }] },
    });
    expect((await caches.getCachedEpg(URL))!.data.programmes.ch1[0].start.getTime()).toBe(Date.parse('2024-01-01T00:00:00Z'));
    await caches.setCachedCatalog(URL, [{ url: URL }]);
    await caches.setCachedChannelHealth({ [URL]: { status: 'ok' } });
    expect(await users.loadUserRecords('favorites')).toEqual([{ key: URL, value: URL }]);
    expect((await caches.getCachedCatalog(URL))!.data).toEqual([{ url: URL }]);
    expect(await caches.getCachedChannelHealth()).toEqual({ [URL]: { status: 'ok' } });
    const catalog = await dbApi.requestResult(db.transaction('catalog-cache').objectStore('catalog-cache').getAll()) as { data: unknown; sealed?: unknown }[];
    expect(catalog[0].data).toBeDefined();
    expect(catalog[0].sealed).toBeUndefined();
    for (const store of ['favorites', 'catalog-cache', 'channel-health-cache', 'cache-meta']) {
      const records = await dbApi.requestResult(db.transaction(store).objectStore(store).getAll());
      expect(JSON.stringify(records), store).not.toContain(SECRET);
      if (store === 'cache-meta') expect(JSON.stringify(records), store).not.toContain('http://host');
    }
    expect(caches.cacheRecordRef((await caches.getCachedCatalog(URL))!.data as object)).toBeNull();
    db.close();
  });
});
