import { seal, unseal, vaultReady, type SealedValue } from './credential-vault';

const STORAGE_KEY = 'iptv_sealed_credentials_v2';
const CONTEXT = 'credential-fields';
const SECRET_FIELD = /^(?:username|user|password|passwd|pass|token|access[_-]?token|refresh[_-]?token|auth[_-]?token|local[_-]?token|api[_-]?key|authorization|cookie|secret|signature|sig|hdnea|hdnts)$/i;
const URL_TEXT = /\b(?:https?|rtsp):\/\/[^\s<>"`]+/gi;
const TOKEN = /~iptv-credential-[0-9a-f]{32}~/g;
let credentials: Record<string, string> = {};
let references = new Map<string, string>();
let initialized = false;
let initialization: Promise<void> | null = null;
let revision = 0;
let persisted = 0;
let writes: Promise<void> = Promise.resolve();

export async function initCredentialFields(): Promise<void> {
  if (initialized || !vaultReady()) return;
  if (!initialization) initialization = (async () => {
    const saved = localStorage.getItem(STORAGE_KEY);
    credentials = saved ? await unseal(JSON.parse(saved) as SealedValue, CONTEXT) : {};
    references = new Map(Object.keys(credentials).map(token => [credentials[token], token]));
    initialized = true;
  })().catch(error => { initialization = null; throw error; });
  return initialization;
}

function reference(secret: string): string {
  TOKEN.lastIndex = 0;
  const protectedAlready = TOKEN.test(secret);
  TOKEN.lastIndex = 0;
  if (!secret || protectedAlready) return secret;
  const existing = references.get(secret);
  if (existing) return existing;
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map(byte => ('0' + byte.toString(16)).slice(-2)).join('');
  const token = '~iptv-credential-' + id + '~';
  credentials[token] = secret;
  references.set(secret, token);
  revision++;
  return token;
}

function protectUrl(url: string): string {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return url; }
  const secrets: string[] = [];
  const collect = (value: string): void => {
    if (value && secrets.indexOf(value) < 0) secrets.push(value);
  };
  const decode = (value: string): string => {
    try { return decodeURIComponent(value); } catch { return value; }
  };
  collect(decode(parsed.username));
  collect(decode(parsed.password));
  parsed.searchParams.forEach((value, key) => {
    if (SECRET_FIELD.test(key) || /^(?:key|auth)$/i.test(key)) collect(value);
  });
  const parts = parsed.pathname.split('/');
  if (/^(?:live|movie|series|timeshift)$/i.test(parts[1] ?? '') && parts.length >= 5) {
    collect(decode(parts[2]));
    collect(decode(parts[3]));
  }
  if (parts.length === 4 && /^\d+(?:\.[^.]+)?$/.test(parts[3])) {
    collect(decode(parts[1]));
    collect(decode(parts[2]));
  }
  // Existing account secrets also cover nonstandard provider URL paths.
  for (const secret of Array.from(references.keys())) {
    if (url.indexOf(secret) >= 0 || url.indexOf(encodeURIComponent(secret)) >= 0) collect(secret);
  }
  secrets.sort((a, b) => b.length - a.length);
  for (const secret of secrets) {
    const query = new URLSearchParams();
    query.set('value', secret);
    const queryForm = query.toString().slice(6);
    for (const form of [encodeURIComponent(secret), queryForm, secret]) {
      const parts = url.split(/(~iptv-credential-[0-9a-f]{32}~)/g);
      url = parts.map((part, index) => index % 2 || part.indexOf(form) < 0
        ? part : part.split(form).join(reference(form))).join('');
    }
  }
  return url;
}

function protectText(value: string, field: string): string {
  if (SECRET_FIELD.test(field)) return reference(value);
  return value.indexOf('://') < 0 ? value : value.replace(URL_TEXT, protectUrl);
}

function revealText(value: string): string {
  if (value.indexOf('~iptv-credential-') < 0) return value;
  return value.replace(TOKEN, token => {
    if (!Object.prototype.hasOwnProperty.call(credentials, token)) {
      throw new Error('Saved credential reference is unavailable');
    }
    return credentials[token];
  });
}

// Only changed branches are copied; ordinary guide text and Dates stay in native IDB form.
async function transform<T>(value: T, text: (value: string, field: string) => string): Promise<T> {
  if (typeof value === 'string') return text(value, '') as T;
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  interface Frame {
    source: Record<string, unknown>;
    target: Record<string, unknown> | null;
    keys: string[];
    index: number;
    parentKey: string;
  }
  const frameFor = (source: object, parentKey: string): Frame => ({
    source: source as Record<string, unknown>, target: null,
    keys: Object.keys(source), index: 0, parentKey,
  });
  const assign = (frame: Frame, key: string, item: unknown): void => {
    const name = text(key, '');
    if (name === key && item === frame.source[key]) return;
    if (!frame.target) frame.target = (Array.isArray(frame.source)
      ? frame.source.slice() : { ...frame.source }) as Record<string, unknown>;
    if (name !== key) delete frame.target[key];
    Object.defineProperty(frame.target, name, {
      value: item, enumerable: true, configurable: true, writable: true,
    });
  };
  const ancestors = new WeakSet<object>([value]);
  const stack = [frameFor(value, '')];
  let result: unknown = value;
  let started = Date.now();
  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (frame.index === frame.keys.length) {
      result = frame.target ?? frame.source;
      ancestors.delete(frame.source);
      stack.pop();
      if (stack.length) assign(stack[stack.length - 1], frame.parentKey, result);
    } else {
      const key = frame.keys[frame.index++];
      const item = frame.source[key];
      if (item && typeof item === 'object' && !(item instanceof Date)) {
        if (ancestors.has(item)) throw new Error('Circular persistence value');
        ancestors.add(item);
        stack.push(frameFor(item, key));
      } else assign(frame, key, typeof item === 'string' ? text(item, key) : item);
    }
    if (Date.now() - started >= 6) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      started = Date.now();
    }
  }
  return result as T;
}

async function flushCredentials(): Promise<void> {
  const save = async (): Promise<void> => {
    if (persisted === revision) return;
    const version = revision;
    const snapshot = { ...credentials };
    const encrypted = await seal(snapshot, CONTEXT);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(encrypted));
    persisted = version;
  };
  const pending = writes.then(save, save);
  writes = pending.catch(() => {});
  await pending;
}

export async function protectCredentialFields<T>(value: T): Promise<T> {
  if (!vaultReady()) return value;
  await initCredentialFields();
  const result = await transform(value, protectText);
  await flushCredentials();
  return result;
}

export async function revealCredentialFields<T>(value: T): Promise<T> {
  if (!vaultReady()) return value;
  await initCredentialFields();
  return transform(value, value => revealText(value));
}

export function credentialFieldsStorageKey(): string { return STORAGE_KEY; }

export async function clearCredentialFields(): Promise<void> {
  await writes;
  credentials = {};
  references.clear();
  revision++;
  persisted = revision;
  localStorage.removeItem(STORAGE_KEY);
}
