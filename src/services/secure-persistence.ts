import { CONFIG } from '../config';
import { initSecureLocal, localValue, writeLocalValue, flushSecureLocal } from './secure-local';
import { migrateEncryptedUserData } from './idb-user-data';
import { clearAllCachedData } from './idb-cache';

const MARKER = CONFIG.STORAGE_PREFIX + 'credentials_only_v2';
export async function initSecurePersistence(): Promise<void> {
  await initSecureLocal();
  const migrated = localValue(MARKER) === 'true';
  if (!migrated) {
    await migrateEncryptedUserData();
    await clearAllCachedData();
    writeLocalValue(MARKER, 'true');
    await flushSecureLocal();
  }
}
