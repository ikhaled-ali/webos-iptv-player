import { isLunaAvailable, lunaRequest, type LunaResponse } from './luna';
import { decodeBytes, encodeBytes, sealValue, unsealValue, utf8, type SealedValue } from './credential-codec';

export { encodeBytes, type SealedValue } from './credential-codec';

interface KeyResponse extends LunaResponse { handle?: string; iv?: string; output?: string; sdkVersion?: string }
const KEY_NAME = 'iptv-storage-v1';
let key: CryptoKey | null = null;
let indexKey: CryptoKey | null = null;
let serviceKey: string | null = null;
let initPromise: Promise<void> | null = null;

export function vaultReady(): boolean { return key !== null; }
export function uploadEncryptionKey(): string | null { return serviceKey; }

function keyRequest(method: string, parameters: Record<string, unknown>, uri = 'luna://com.webos.service.keymanager3'): Promise<KeyResponse> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { request.cancel(); reject(new Error('Protected key request timed out')); }, 10000);
    const request = lunaRequest<KeyResponse>(uri, {
      method, parameters,
      onSuccess: response => { clearTimeout(timer); resolve(response); },
      onFailure: response => {
        clearTimeout(timer);
        const error = new Error('Protected key request failed');
        Object.assign(error, { code: response.errorCode });
        reject(error);
      },
    });
  });
}
async function hardwareCrypt(data: string, encrypted?: SealedValue): Promise<SealedValue> {
  const begin = await keyRequest('begin', {
    name: KEY_NAME,
    params: { type: 'AES', mode: ['GCM'], purpose: [encrypted ? 'decrypt' : 'encrypt'],
      padding: ['None'], mac_length: '128', ...(encrypted ? { iv: encrypted.iv } : {}) },
  });
  if (!begin.handle) throw new Error('Invalid protected key operation');
  try {
    const result = await keyRequest('finish', { handle: begin.handle, data });
    if (typeof result.output !== 'string' || (!encrypted && typeof begin.iv !== 'string')) {
      throw new Error('Invalid protected key result');
    }
    return { version: 1, iv: begin.iv ?? encrypted!.iv, data: result.output };
  } catch (error) {
    await keyRequest('abort', { handle: begin.handle }).catch(() => {});
    throw error;
  }
}
async function keyStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('iptv-protected-keys', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('keys');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Protected key storage unavailable'));
    request.onblocked = () => reject(new Error('Protected key storage blocked'));
  });
}
async function storedKey(db: IDBDatabase, name: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = db.transaction('keys').objectStore('keys').get(name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Protected key read failed'));
  });
}
async function saveKey(db: IDBDatabase, name: string, value: unknown): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('keys', 'readwrite');
    tx.objectStore('keys').put(value, name);
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(new Error('Protected key write failed'));
  });
}
export function initCredentialVault(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = initialize().catch(error => { initPromise = null; throw error; });
  return initPromise;
}
async function browserDataKey(db: IDBDatabase): Promise<Uint8Array<ArrayBuffer>> {
  const stored = await storedKey(db, 'browser-v1') as { wrapping: CryptoKey; iv: string; data: string } | undefined;
  const context = utf8('iptv-data-key-v1');
  if (stored) {
    const output = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decodeBytes(stored.iv), additionalData: context }, stored.wrapping, decodeBytes(stored.data));
    return new Uint8Array(output);
  }
  const wrapping = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const output = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: context }, wrapping, raw);
  await saveKey(db, 'browser-v1', { wrapping, iv: encodeBytes(iv), data: encodeBytes(new Uint8Array(output)) });
  return raw;
}
async function initialize(): Promise<void> {
  if (typeof crypto === 'undefined' || !crypto.subtle) throw new Error('Secure storage unavailable');
  const db = await keyStore();
  let raw: Uint8Array<ArrayBuffer> | null = null;
  try {
    const wrapped = await storedKey(db, 'hardware-v1') as SealedValue | undefined;
    let hardware = isLunaAvailable();
    if (hardware && !wrapped) {
      const info = await keyRequest('getSystemInfo', { keys: ['sdkVersion'] }, 'luna://com.webos.service.tv.systemproperty');
      const sdk = typeof info.sdkVersion === 'string' ? parseInt(info.sdkVersion.split('.')[0], 10) : NaN;
      // Only a confirmed pre-24 TV selects the browser backend; unknown or failing
      // modern devices must not silently downgrade hardware key protection.
      hardware = !Number.isFinite(sdk) || sdk >= 9;
    }
    if (wrapped) raw = decodeBytes((await hardwareCrypt(wrapped.data, wrapped)).data);
    else if (hardware) {
      try {
        // webOS 25 accepts mac_length on begin, but rejects it during generation.
        await keyRequest('generateKey', { name: KEY_NAME, params: { type: 'AES', size: 256,
          mode: ['GCM'], purpose: ['encrypt', 'decrypt'], padding: ['None'] } });
      } catch (error) {
        if ((error as { code?: number }).code !== -10002) throw error;
      }
      // Preserve the data key when a TV upgrades from an older webOS version.
      raw = await storedKey(db, 'browser-v1') ? await browserDataKey(db) : crypto.getRandomValues(new Uint8Array(32));
      const sealed = await hardwareCrypt(encodeBytes(raw));
      if ((await hardwareCrypt(sealed.data, sealed)).data !== encodeBytes(raw)) {
        throw new Error('Protected key verification failed');
      }
      await saveKey(db, 'hardware-v1', sealed);
    } else raw = await browserDataKey(db);
    if (hardware || wrapped) {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('keys', 'readwrite');
        tx.objectStore('keys').delete('browser-v1');
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(new Error('Legacy key cleanup failed'));
      });
    }
    if (raw.length !== 32) throw new Error('Invalid protected data key');
    const aes = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    const hmacMaterial = await crypto.subtle.digest('SHA-256', raw);
    const hmac = await crypto.subtle.importKey('raw', hmacMaterial, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    new Uint8Array(hmacMaterial).fill(0);
    serviceKey = encodeBytes(raw);
    key = aes;
    indexKey = hmac;
  } finally { raw?.fill(0); db.close(); }
}
export async function seal(value: unknown, context: string): Promise<SealedValue> {
  if (!key) throw new Error('Credential vault is locked');
  return sealValue(key, value, context);
}
export async function unseal<T>(value: SealedValue, context: string): Promise<T> {
  if (!key || value.version !== 1) throw new Error('Credential vault is locked or unsupported');
  return unsealValue<T>(key, value, context);
}
export async function privateKey(context: string, value: unknown): Promise<string> {
  if (!indexKey) return String(value);
  const output = await crypto.subtle.sign('HMAC', indexKey, utf8(JSON.stringify([context, value])));
  return 'sealed:' + encodeBytes(new Uint8Array(output));
}
