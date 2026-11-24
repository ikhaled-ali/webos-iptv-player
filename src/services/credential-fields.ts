import { seal, unseal, vaultReady, type SealedValue } from './credential-vault';

const STORAGE_KEY = 'iptv_sealed_credentials_v2';
const CONTEXT = 'credential-fields';
const SECRET_FIELD = /^(?:username|user|password|passwd|pass|token|access[_-]?token|refresh[_-]?token|auth[_-]?token|local[_-]?token|api[_-]?key|authorization|cookie|secret|signature|sig|hdnea|hdnts)$/i;
const URL_TEXT = /\b(?:https?|rtsp):\/\/[^\s<>"`]+/gi;
// A reference is TOKEN_PREFIX, 32 lowercase hex digits, and '~'.
const TOKEN_PREFIX = '~iptv-credential-';
const TOKEN_LENGTH = TOKEN_PREFIX.length + 33;
// Long walks hand the thread back this often; the clock is read every few steps.
const SLICE_MS = 6;
const CLOCK_STEPS = 64;
let credentials: Record<string, string> = {};
let references = new Map<string, string>();
// Each secret's distinct URL forms (percent-encoded, query-encoded, raw), computed once.
let secretForms = new Map<string, string[]>();
let encodedSecrets = new Map<string, string>();
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

function isHexDigit(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 97 && code <= 102);
}

// Whether a whole reference starts at `at`, which already holds TOKEN_PREFIX.
function tokenAt(value: string, at: number): boolean {
  if (at + TOKEN_LENGTH > value.length) return false;
  const digits = at + TOKEN_PREFIX.length;
  for (let i = digits; i < digits + 32; i++) {
    if (!isHexDigit(value.charCodeAt(i))) return false;
  }
  return value.charCodeAt(digits + 32) === 126;
}

// The next reference at or after `from`, or -1.
function nextToken(value: string, from: number): number {
  let at = value.indexOf(TOKEN_PREFIX, from);
  while (at >= 0 && !tokenAt(value, at)) at = value.indexOf(TOKEN_PREFIX, at + 1);
  return at;
}

function reference(secret: string): string {
  if (!secret || nextToken(secret, 0) >= 0) return secret;
  const existing = references.get(secret);
  if (existing) return existing;
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map(byte => ('0' + byte.toString(16)).slice(-2)).join('');
  const token = TOKEN_PREFIX + id + '~';
  credentials[token] = secret;
  references.set(secret, token);
  revision++;
  return token;
}

function encodedSecret(secret: string): string {
  let encoded = encodedSecrets.get(secret);
  if (encoded === undefined) {
    encoded = encodeURIComponent(secret);
    encodedSecrets.set(secret, encoded);
  }
  return encoded;
}

function formsOf(secret: string): string[] {
  let forms = secretForms.get(secret);
  if (!forms) {
    const query = new URLSearchParams();
    query.set('value', secret);
    const queryForm = query.toString().slice(6);
    const encoded = encodedSecret(secret);
    // A repeated form finds nothing left to replace, so it is checked once.
    forms = [encoded];
    if (queryForm !== encoded) forms.push(queryForm);
    if (secret !== encoded && secret !== queryForm) forms.push(secret);
    secretForms.set(secret, forms);
  }
  return forms;
}

// Replaces `form` in the text between references, never inside one.
function replaceOutsideTokens(url: string, form: string): string {
  let token = nextToken(url, 0);
  if (token < 0) return url.split(form).join(reference(form));
  // Joined rather than concatenated, so the result is one flat string.
  const pieces: string[] = [];
  let start = 0;
  while (true) {
    const end = token < 0 ? url.length : token;
    const part = url.slice(start, end);
    pieces.push(part.indexOf(form) < 0 ? part : part.split(form).join(reference(form)));
    if (token < 0) return pieces.join('');
    pieces.push(url.slice(token, token + TOKEN_LENGTH));
    start = token + TOKEN_LENGTH;
    token = nextToken(url, start);
  }
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
  references.forEach((_token, secret) => {
    if (url.indexOf(secret) >= 0 || url.indexOf(encodedSecret(secret)) >= 0) collect(secret);
  });
  secrets.sort((a, b) => b.length - a.length);
  for (const secret of secrets) {
    for (const form of formsOf(secret)) {
      // No occurrence anywhere means none between references either.
      if (url.indexOf(form) >= 0) url = replaceOutsideTokens(url, form);
    }
  }
  return url;
}

function protectText(value: string, field: string): string {
  if (SECRET_FIELD.test(field)) return reference(value);
  return value.indexOf('://') < 0 ? value : value.replace(URL_TEXT, protectUrl);
}

function revealText(value: string): string {
  let token = value.indexOf(TOKEN_PREFIX);
  if (token < 0) return value;
  token = nextToken(value, token);
  if (token < 0) return value;
  // Joined rather than concatenated, so the result is one flat string.
  const pieces: string[] = [];
  let start = 0;
  while (token >= 0) {
    const name = value.slice(token, token + TOKEN_LENGTH);
    if (!Object.prototype.hasOwnProperty.call(credentials, name)) {
      throw new Error('Saved credential reference is unavailable');
    }
    pieces.push(value.slice(start, token), credentials[name]);
    start = token + TOKEN_LENGTH;
    token = nextToken(value, start);
  }
  pieces.push(value.slice(start));
  return pieces.join('');
}

// A macrotask that, unlike a nested setTimeout(0), is not clamped to 4ms.
interface NodePort { ref?: () => void; unref?: () => void }
let yieldChannel: MessageChannel | null = null;
const yieldWaiters: Array<() => void> = [];
function yieldToEventLoop(): Promise<void> {
  if (typeof MessageChannel === 'undefined') {
    return new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  if (!yieldChannel) {
    const created = new MessageChannel();
    created.port1.onmessage = () => {
      yieldWaiters.shift()?.();
      // Under Node (unit tests) an idle port must not keep the process alive.
      if (!yieldWaiters.length) (created.port1 as unknown as NodePort).unref?.();
    };
    yieldChannel = created;
  }
  const channel = yieldChannel;
  return new Promise<void>(resolve => {
    yieldWaiters.push(resolve);
    (channel.port1 as unknown as NodePort).ref?.();
    channel.port2.postMessage(null);
  });
}

type Text = (value: string, field: string) => string;
type Branch = Record<string, unknown>;

function isBranch(item: unknown): item is Branch {
  return !!item && typeof item === 'object' && !(item instanceof Date);
}

// Stores `item` under the transformed `key`, copying `source` into `target`
// on the first change; returns the copy, or null while nothing has changed.
function assignInto(source: Branch, target: Branch | null, key: string, item: unknown, text: Text): Branch | null {
  // Only a key holding '~' (a reference) or '://' (a URL) can change.
  const name = key.indexOf('~') < 0 && key.indexOf('://') < 0 ? key : text(key, '');
  if (name === key && item === source[key]) return target;
  if (!target) target = (Array.isArray(source) ? source.slice() : { ...source }) as Branch;
  if (name === key && key !== '__proto__') {
    // The copy already owns `key` as a plain writable data property.
    target[key] = item;
    return target;
  }
  if (name !== key) delete target[key];
  Object.defineProperty(target, name, {
    value: item, enumerable: true, configurable: true, writable: true,
  });
  return target;
}

// A branch whose values are all leaves, transformed in one pass; null when
// it holds a nested branch and needs the general walk.
function transformLeaves(source: Branch, keys: string[], text: Text): Branch | null {
  for (let i = 0; i < keys.length; i++) {
    if (isBranch(source[keys[i]])) return null;
  }
  let target: Branch | null = null;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const item = source[key];
    target = assignInto(source, target, key, typeof item === 'string' ? text(item, key) : item, text);
  }
  return target ?? source;
}

// Only changed branches are copied; ordinary guide text and Dates stay in native IDB form.
async function transform<T>(value: T, text: Text): Promise<T> {
  if (typeof value === 'string') return text(value, '') as T;
  if (!isBranch(value)) return value;
  interface Frame {
    source: Branch;
    target: Branch | null;
    keys: string[];
    index: number;
    parentKey: string;
  }
  // The branches on the stack: a value that reaches one of them is circular.
  const ancestors = new WeakSet<object>([value]);
  const stack: Frame[] = [{ source: value, target: null, keys: Object.keys(value), index: 0, parentKey: '' }];
  let result: unknown = value;
  let started = Date.now();
  let steps = 0;
  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (frame.index === frame.keys.length) {
      result = frame.target ?? frame.source;
      ancestors.delete(frame.source);
      stack.pop();
      if (stack.length) {
        const parent = stack[stack.length - 1];
        parent.target = assignInto(parent.source, parent.target, frame.parentKey, result, text);
      }
    } else {
      const key = frame.keys[frame.index++];
      const item = frame.source[key];
      if (isBranch(item)) {
        if (ancestors.has(item)) throw new Error('Circular persistence value');
        const keys = Object.keys(item);
        const leaves = transformLeaves(item, keys, text);
        if (leaves) {
          frame.target = assignInto(frame.source, frame.target, key, leaves, text);
          steps += keys.length;
        } else {
          ancestors.add(item);
          stack.push({ source: item, target: null, keys, index: 0, parentKey: key });
        }
      } else {
        frame.target = assignInto(frame.source, frame.target, key,
          typeof item === 'string' ? text(item, key) : item, text);
      }
    }
    if (++steps >= CLOCK_STEPS) {
      steps = 0;
      if (Date.now() - started >= SLICE_MS) {
        await yieldToEventLoop();
        started = Date.now();
      }
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
  secretForms = new Map();
  encodedSecrets = new Map();
  revision++;
  persisted = revision;
  localStorage.removeItem(STORAGE_KEY);
}
