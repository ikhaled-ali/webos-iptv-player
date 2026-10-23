import { protectedKeymanagerMock } from '../scripts/protected-keymanager-mock.mjs';
import { expect, type Page } from '@playwright/test';

export async function installKeymanagerMock(page: Page): Promise<void> {
  await page.addInitScript(protectedKeymanagerMock);
}

export async function readProtected<T>(page: Page, name: string, kind: 'local' | 'user' = 'local', write?: { rawValue: string | null }): Promise<T> {
  return page.evaluate(async ({ key, kind, write }) => {
    const decode = (value: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(value), char => char.charCodeAt(0));
    const read = (store: string, key: string): Promise<any> => new Promise((resolve, reject) => {
      const request = indexedDB.open('iptv-protected-keys');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction(store);
        const item = tx.objectStore(store).get(key);
        item.onsuccess = () => resolve(item.result);
        item.onerror = () => reject(item.error);
        tx.oncomplete = () => db.close();
      };
    });
    const hardware = await read('keys', 'hardware-v1');
    const browser = hardware ? null : await read('keys', 'browser-v1');
    const wrapping = hardware
      ? await crypto.subtle.importKey('raw', new Uint8Array(32).fill(7), 'AES-GCM', false, ['decrypt'])
      : browser.wrapping;
    const keyBytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode((hardware ?? browser).iv),
      ...(browser ? { additionalData: new TextEncoder().encode('iptv-data-key-v1') } : {}) }, wrapping, decode((hardware ?? browser).data));
    const dataKey = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
    const storedCredentials = localStorage.getItem('iptv_sealed_credentials_v2');
    const secrets: Record<string, string> = storedCredentials ? JSON.parse(new TextDecoder().decode(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(JSON.parse(storedCredentials).iv),
        additionalData: new TextEncoder().encode('credential-fields') }, dataKey,
      decode(JSON.parse(storedCredentials).data)),
    )) : {};
    const reveal = (value: any): any => {
      if (typeof value === 'string') return value.replace(/~iptv-credential-[0-9a-f]{32}~/g, token => secrets[token] ?? token);
      if (Array.isArray(value)) return value.map(reveal);
      if (!value || typeof value !== 'object' || value instanceof Date) return value;
      return Object.fromEntries(Object.keys(value).map(key => [reveal(key), reveal(value[key])]));
    };
    let encrypted: any;
    let context = 'local-config';
    if (kind === 'user') {
      const records: any[] = await new Promise((resolve, reject) => {
        const open = indexedDB.open('iptv');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction(key);
          const request = tx.objectStore(key).getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
          tx.oncomplete = () => db.close();
        };
      });
      if (!records.length || records[0].key !== 'sealed-user-v1') {
        if (!write) return reveal(records);
        await new Promise<void>((resolve, reject) => {
          const open = indexedDB.open('iptv');
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction(key, 'readwrite');
            tx.objectStore(key).clear();
            for (const record of JSON.parse(write.rawValue ?? '[]')) tx.objectStore(key).put(record);
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror = () => reject(tx.error);
          };
        });
        return JSON.parse(write.rawValue ?? '[]');
      } else encrypted = records[0].value;
      context = 'user:' + key;
    } else if (!localStorage.getItem('iptv_sealed_local_v1')) {
      const raw = localStorage.getItem(key);
      if (!write) return raw === null ? null : reveal(JSON.parse(raw));
      if (write.rawValue === null) localStorage.removeItem(key);
      else localStorage.setItem(key, write.rawValue);
      return write.rawValue === null ? null : JSON.parse(write.rawValue);
    } else encrypted = JSON.parse(localStorage.getItem('iptv_sealed_local_v1')!);
    const output = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(encrypted.iv), additionalData: new TextEncoder().encode(context) }, dataKey, decode(encrypted.data));
    let values = JSON.parse(new TextDecoder().decode(output));
    if (write) {
      if (kind === 'user') values = JSON.parse(write.rawValue ?? '[]');
      else if (write.rawValue === null) delete values[key];
      else values[key] = write.rawValue;
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encryptionKey = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(context) }, encryptionKey, new TextEncoder().encode(JSON.stringify(values)));
      const encode = (value: Uint8Array): string => btoa(String.fromCharCode(...value));
      const sealed = { version: 1, iv: encode(iv), data: encode(new Uint8Array(ciphertext)) };
      if (kind === 'user') {
        await new Promise<void>((resolve, reject) => {
          const open = indexedDB.open('iptv');
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction(key, 'readwrite');
            tx.objectStore(key).clear();
            tx.objectStore(key).put({ key: 'sealed-user-v1', value: sealed });
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror = () => reject(tx.error);
          };
        });
      } else localStorage.setItem('iptv_sealed_local_v1', JSON.stringify(sealed));
    }
    return kind === 'user' ? values : JSON.parse(values[key] ?? 'null');
  }, { key: name, kind, write });
}

export const readProtectedLocal = readProtected;

export async function writeProtectedLocal(page: Page, key: string, rawValue: string | null): Promise<void> {
  await expect(page.locator('#view-loading')).toBeHidden();
  await readProtected(page, key, 'local', { rawValue });
}
