export interface SealedValue { version: 1; iv: string; data: string }

// Each binary chunk ends on a base64 boundary and stays below apply's argument limit.
const BYTE_CHUNK_SIZE = 12 * 1024;
const BASE64_CHUNK_SIZE = BYTE_CHUNK_SIZE / 3 * 4;

export function encodeBytes(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += BYTE_CHUNK_SIZE) {
    const chunk = Array.from(bytes.subarray(offset, offset + BYTE_CHUNK_SIZE));
    chunks.push(btoa(String.fromCharCode.apply(null, chunk)));
  }
  return chunks.join('');
}

export function decodeBytes(value: string): Uint8Array<ArrayBuffer> {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const bytes = new Uint8Array(value.length / 4 * 3 - padding);
  let offset = 0;
  for (let start = 0; start < value.length; start += BASE64_CHUNK_SIZE) {
    const binary = atob(value.slice(start, start + BASE64_CHUNK_SIZE));
    for (let i = 0; i < binary.length; i++) bytes[offset++] = binary.charCodeAt(i);
  }
  return bytes;
}

export function utf8(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(value);
}

const TYPE_TAG = '__iptv_sealed_type__';
function serialize(value: unknown): string {
  return JSON.stringify(value, function (key, item: unknown): unknown {
    const original = (this as Record<string, unknown>)[key];
    if (original instanceof Date) return { [TYPE_TAG]: 'date', value: original.toISOString() };
    if (item && typeof item === 'object' && Object.prototype.hasOwnProperty.call(item, TYPE_TAG)) {
      const object = item as Record<string, unknown>;
      return { [TYPE_TAG]: 'object', value: Object.keys(object).map(key => [key, object[key]]) };
    }
    return item;
  });
}
function deserialize(value: string): unknown {
  return JSON.parse(value, (_key, item: unknown): unknown => {
    if (!item || typeof item !== 'object') return item;
    const tagged = item as { [TYPE_TAG]?: string; value?: unknown };
    if (tagged[TYPE_TAG] === 'date') return new Date(tagged.value as string);
    if (tagged[TYPE_TAG] === 'object') {
      const object: Record<string, unknown> = {};
      for (const [key, value] of tagged.value as [string, unknown][]) {
        Object.defineProperty(object, key, { value, enumerable: true, configurable: true, writable: true });
      }
      return object;
    }
    return item;
  });
}

export async function sealValue(key: CryptoKey, value: unknown, context: string): Promise<SealedValue> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const output = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: utf8(context), tagLength: 128 },
    key,
    utf8(serialize(value)),
  );
  return { version: 1, iv: encodeBytes(iv), data: encodeBytes(new Uint8Array(output)) };
}

export async function unsealValue<T>(key: CryptoKey, value: SealedValue, context: string): Promise<T> {
  const output = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: decodeBytes(value.iv), additionalData: utf8(context), tagLength: 128 },
    key,
    decodeBytes(value.data),
  );
  return deserialize(new TextDecoder('utf-8', { fatal: true }).decode(output)) as T;
}
