import { CONFIG } from '../config';
import { initCredentialVault, unseal, type SealedValue } from './credential-vault';
import { initCredentialFields, protectCredentialFields, revealCredentialFields, credentialFieldsStorageKey, clearCredentialFields } from './credential-fields';

const VAULT_KEY = CONFIG.STORAGE_PREFIX + 'sealed_local_v1';
const LOG_LEVEL_KEY = CONFIG.STORAGE_PREFIX + 'log_level';
let values: Record<string, string> | null = null;
let chain: Promise<void> = Promise.resolve();
let revision = 0;
let savedRevision = 0;
let failure: unknown = null;
let onFailure = (): void => {};
export function setSecureWriteFailureHandler(handler: () => void): void { onFailure = handler; }
export function localValue(key: string): string | null {
  return values ? values[key] ?? null : localStorage.getItem(key);
}
async function transformValue(value: string, protect: boolean): Promise<string> {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { parsed = value; }
  const transformed = protect
    ? await protectCredentialFields(parsed)
    : await revealCredentialFields(parsed);
  return typeof parsed === 'string' && parsed === value
    ? transformed as string : JSON.stringify(transformed);
}
async function saveValues(snapshot: Record<string, string>): Promise<void> {
  const protectedValues: Record<string, string> = {};
  for (const key of Object.keys(snapshot)) protectedValues[key] = await transformValue(snapshot[key], true);
  for (const key of Object.keys(protectedValues)) {
    if (localStorage.getItem(key) !== protectedValues[key]) localStorage.setItem(key, protectedValues[key]);
  }
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (key && key.indexOf(CONFIG.STORAGE_PREFIX) === 0 && key !== LOG_LEVEL_KEY
      && key !== credentialFieldsStorageKey() && !Object.prototype.hasOwnProperty.call(snapshot, key)) {
      localStorage.removeItem(key);
    }
  }
}
function persist(): void {
  const snapshot = { ...values };
  const snapshotRevision = ++revision;
  chain = chain.then(async () => {
    await saveValues(snapshot);
    savedRevision = snapshotRevision;
    failure = null;
  }).catch(error => { failure = error; onFailure(); });
}
export function writeLocalValue(key: string, value: string): void {
  if (!values) {
    if (localStorage.getItem(VAULT_KEY) || localStorage.getItem(credentialFieldsStorageKey())) {
      throw new Error('Credential vault is locked');
    }
    localStorage.setItem(key, value);
    return;
  }
  values[key] = value;
  persist();
}
export function removeLocalValue(key: string): void {
  if (values) { delete values[key]; persist(); }
  localStorage.removeItem(key);
}
export function clearLocalValues(): void {
  values = {};
  chain = chain.then(async () => {
    await clearCredentialFields();
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key !== null) localStorage.removeItem(key);
    }
  }).catch(error => { failure = error; onFailure(); });
  persist();
}
async function drainWrites(): Promise<void> {
  let pending: Promise<void>;
  do {
    pending = chain;
    await pending;
  } while (pending !== chain);
}
export async function flushSecureLocal(): Promise<void> {
  await drainWrites();
  if (savedRevision !== revision) {
    persist();
    await drainWrites();
  }
  if (savedRevision !== revision) throw failure ?? new Error('Encrypted settings write failed');
}
export async function initSecureLocal(): Promise<void> {
  if (values) return;
  await initCredentialVault();
  await initCredentialFields();
  const encrypted = localStorage.getItem(VAULT_KEY);
  const loaded: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.indexOf(CONFIG.STORAGE_PREFIX) === 0 && key !== VAULT_KEY
      && key !== LOG_LEVEL_KEY && key !== credentialFieldsStorageKey()) {
      loaded[key] = await transformValue(localStorage.getItem(key)!, false);
    }
  }
  if (encrypted) Object.assign(loaded, await unseal(JSON.parse(encrypted) as SealedValue, 'local-config'));
  // Commit protected references before retiring the previous whole-settings snapshot.
  await saveValues(loaded);
  values = loaded;
}
