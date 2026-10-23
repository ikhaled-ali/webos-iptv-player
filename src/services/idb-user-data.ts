import { protectCredentialFields, revealCredentialFields } from './credential-fields';
import { unseal, vaultReady, type SealedValue } from './credential-vault';
import {
  openPersistenceDb,
  requestResult,
  transactionDone,
  USER_DATA_STORES,
  USER_META_STORE,
  type UserDataStore,
} from './idb-database';
import { createLogger } from '../utils/logger';

const log = createLogger('UserDataStorage');

export interface UserDataRecord<T = unknown> {
  key: string;
  value: T;
  scope?: string;
  updatedAt?: number;
  expiresAt?: number;
}

const SNAPSHOT_KEY = 'sealed-user-v1';
async function decodeRecords<T>(store: UserDataStore, records: UserDataRecord[]): Promise<UserDataRecord<T>[]> {
  if (!vaultReady()) return records as UserDataRecord<T>[];
  if (records.length === 1 && records[0].key === SNAPSHOT_KEY) {
    return unseal(records[0].value as SealedValue, 'user:' + store);
  }
  return revealCredentialFields(records) as Promise<UserDataRecord<T>[]>;
}
async function encodeRecords(store: UserDataStore, records: UserDataRecord[]): Promise<UserDataRecord[]> {
  void store;
  return protectCredentialFields(records);
}
export async function migrateEncryptedUserData(): Promise<void> {
  if (!vaultReady()) return;
  const records = await loadAllUserRecords();
  await replaceAllUserData(records);
}
let writeChain: Promise<void> = Promise.resolve();
let writeFailure: unknown = null;

function enqueueWrite(operation: () => Promise<void>): Promise<void> {
  const result = writeChain.then(operation, operation);
  writeChain = result.then(
    () => {},
    (err) => { writeFailure = err; },
  );
  return result;
}

export async function flushUserDataWrites(): Promise<void> {
  await writeChain;
  if (writeFailure !== null) {
    const err = writeFailure;
    writeFailure = null;
    throw err;
  }
}

export async function loadUserRecords<T = unknown>(
  storeName: UserDataStore,
): Promise<UserDataRecord<T>[]> {
  await writeChain;
  const db = await openPersistenceDb();
  if (!db) {
    log.warn(
      'User data storage is unavailable',
      'event=persistence.user.unavailable',
      'operation=read',
      `store=${storeName}`,
    );
    return [];
  }
  try {
    const tx = db.transaction(storeName, 'readonly');
    const records = await requestResult(tx.objectStore(storeName).getAll()) as UserDataRecord[];
    return await decodeRecords<T>(storeName, records);
  } catch (err) {
    log.error(
      'User data read failed',
      'event=persistence.user.read.failed',
      'operation=read',
      `store=${storeName}`,
      err,
    );
    throw err;
  }
}

export async function loadAllUserRecords(): Promise<
Record<UserDataStore, UserDataRecord[]>
> {
  await writeChain;
  const db = await openPersistenceDb();
  if (!db) {
    log.warn(
      'User data storage is unavailable',
      'event=persistence.user.unavailable',
      'operation=read_all',
    );
    return {
      favorites: [],
      reminders: [],
      'channel-state': [],
      watchlist: [],
      'playback-progress': [],
      'recently-watched': [],
      'online-sub-picks': [],
      'parental-control': [],
    };
  }
  try {
    const tx = db.transaction(USER_DATA_STORES, 'readonly');
    const records = await Promise.all(USER_DATA_STORES.map(async (storeName) => [
      storeName,
      await requestResult(tx.objectStore(storeName).getAll()) as UserDataRecord[],
    ] as const));
    const result = {} as Record<UserDataStore, UserDataRecord[]>;
    for (const [storeName, items] of records) result[storeName] = await decodeRecords(storeName, items);
    return result;
  } catch (err) {
    log.error(
      'User data read failed',
      'event=persistence.user.read.failed',
      'operation=read_all',
      err,
    );
    throw err;
  }
}

// TODO: Remove this marker helper once all supported installs have upgraded to IndexedDB v4.
export async function loadMigrationMarkers(): Promise<Set<string>> {
  const db = await openPersistenceDb();
  if (!db) return new Set();
  try {
    const tx = db.transaction(USER_META_STORE, 'readonly');
    const keys = await requestResult(tx.objectStore(USER_META_STORE).getAllKeys());
    const migrated = new Set<string>();
    for (const key of keys) {
      if (typeof key === 'string' && key.indexOf('migration:') === 0) {
        migrated.add(key.slice(10));
      }
    }
    return migrated;
  } catch (err) {
    log.error(
      'Migration markers read failed',
      'event=persistence.user.migration.failed',
      'operation=read_markers',
      err,
    );
    throw err;
  }
}

export interface UserDataMigration {
  legacyKey: string;
  storeName: UserDataStore;
  records: UserDataRecord[];
  replacePrefix: string | null;
  replaceExisting: boolean;
}

// TODO: Remove this migration writer once all supported installs have upgraded to IndexedDB v4.
export function migrateUserRecordSets(migrations: UserDataMigration[]): Promise<void> {
  if (!migrations.length) return Promise.resolve();
  return enqueueWrite(async () => {
    const db = await openPersistenceDb();
    if (!db) {
      log.warn(
        'User data storage is unavailable',
        'event=persistence.user.unavailable',
        'operation=migrate',
      );
      throw new Error('IndexedDB unavailable');
    }
    if (vaultReady()) {
      const snapshots = new Map<UserDataStore, UserDataRecord[]>();
      for (const migration of migrations) {
        let records = snapshots.get(migration.storeName);
        if (!records) {
          const tx = db.transaction(migration.storeName);
          records = await decodeRecords(migration.storeName,
            await requestResult(tx.objectStore(migration.storeName).getAll()));
        }
        if (migration.replaceExisting) records = records.filter(record =>
          migration.replacePrefix !== null && !record.key.startsWith(migration.replacePrefix));
        const byKey = new Map(records.map(record => [record.key, record]));
        for (const record of migration.records) byKey.set(record.key, record);
        snapshots.set(migration.storeName, [...byKey.values()]);
      }
      const encoded = await Promise.all([...snapshots].map(async ([store, records]) =>
        [store, await encodeRecords(store, records)] as const));
      const tx = db.transaction([...snapshots.keys(), USER_META_STORE], 'readwrite');
      for (const [store, records] of encoded) {
        tx.objectStore(store).clear();
        for (const record of records) tx.objectStore(store).put(record);
      }
      for (const migration of migrations) tx.objectStore(USER_META_STORE).put({ key: `migration:${migration.legacyKey}` });
      await transactionDone(tx);
      return;
    }
    try {
      const storeNames = [...new Set(migrations.map(item => item.storeName))];
      const existingKeys = new Map<UserDataStore, string[]>();
      const replacementStores = [...new Set(migrations
        .filter(item => item.replaceExisting)
        .map(item => item.storeName))];
      for (const storeName of replacementStores) {
        const readTx = db.transaction(storeName, 'readonly');
        const readDone = transactionDone(readTx);
        const keys = await requestResult(readTx.objectStore(storeName).getAllKeys());
        await readDone;
        existingKeys.set(storeName, keys.filter((key): key is string => typeof key === 'string'));
      }
      const tx = db.transaction([...storeNames, USER_META_STORE], 'readwrite');
      const meta = tx.objectStore(USER_META_STORE);
      for (const migration of migrations) {
        const store = tx.objectStore(migration.storeName);
        const keys = existingKeys.get(migration.storeName) ?? [];
        if (migration.replaceExisting) {
          for (const key of keys) {
            if (migration.replacePrefix === null || key.startsWith(migration.replacePrefix)) {
              store.delete(key);
            }
          }
        }
        for (const record of migration.records) store.put(record);
        meta.put({
          key: `migration:${migration.legacyKey}`,
          migratedAt: Date.now(),
        });
      }
      await transactionDone(tx);
      log.info(
        'User data migration completed',
        'event=persistence.user.migration.completed',
        `datasets=${migrations.length}`,
        `records=${migrations.reduce((count, item) => count + item.records.length, 0)}`,
      );
    } catch (err) {
      log.error(
        'User data migration failed',
        'event=persistence.user.migration.failed',
        'operation=migrate',
        `keys=${migrations.map(item => item.legacyKey).join(',')}`,
        err,
      );
      throw err;
    }
  });
}

export function applyUserChanges(
  storeName: UserDataStore,
  puts: UserDataRecord[],
  deletes: string[] = [],
): Promise<void> {
  if (!puts.length && !deletes.length) return Promise.resolve();
  return enqueueWrite(async () => {
    const db = await openPersistenceDb();
    if (!db) {
      log.warn(
        'User data storage is unavailable',
        'event=persistence.user.unavailable',
        'operation=write',
        `store=${storeName}`,
      );
      throw new Error('IndexedDB unavailable');
    }
    try {
      const records = await encodeRecords(storeName, puts);
      const removed = await protectCredentialFields(deletes);
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      for (const key of removed) store.delete(key);
      for (const record of records) store.put(record);
      await transactionDone(tx);
    } catch (err) {
      log.error(
        'User data write failed',
        'event=persistence.user.write.failed',
        'operation=write',
        `store=${storeName}`,
        err,
      );
      throw err;
    }
  });
}

export function replaceAllUserData(
  records: Partial<Record<UserDataStore, UserDataRecord[]>>,
): Promise<void> {
  return enqueueWrite(async () => {
    const db = await openPersistenceDb();
    if (!db) {
      log.warn(
        'User data storage is unavailable',
        'event=persistence.user.unavailable',
        'operation=recover',
      );
      throw new Error('IndexedDB unavailable');
    }
    try {
      const encoded = new Map(await Promise.all(USER_DATA_STORES.map(async store =>
        [store, await encodeRecords(store, records[store] ?? [])] as const)));
      const tx = db.transaction(USER_DATA_STORES, 'readwrite');
      for (const storeName of USER_DATA_STORES) {
        const store = tx.objectStore(storeName);
        store.clear();
        for (const item of encoded.get(storeName) ?? []) store.put(item);
      }
      await transactionDone(tx);
    } catch (err) {
      log.error(
        'User data recovery write failed',
        'event=persistence.user.write.failed',
        'operation=recover',
        err,
      );
      throw err;
    }
  });
}

export function clearAllUserData(): Promise<void> {
  return enqueueWrite(async () => {
    const db = await openPersistenceDb();
    if (!db) {
      log.warn(
        'User data storage is unavailable',
        'event=persistence.user.unavailable',
        'operation=clear',
      );
      throw new Error('IndexedDB unavailable');
    }
    try {
      const tx = db.transaction([...USER_DATA_STORES, USER_META_STORE], 'readwrite');
      for (const storeName of USER_DATA_STORES) tx.objectStore(storeName).clear();
      tx.objectStore(USER_META_STORE).clear();
      await transactionDone(tx);
      writeFailure = null;
      log.info(
        'User data clear completed',
        'event=persistence.user.clear.completed',
        'operation=clear',
        'scope=all',
      );
    } catch (err) {
      log.error(
        'User data clear failed',
        'event=persistence.user.clear.failed',
        'operation=clear',
        'scope=all',
        err,
      );
      throw err;
    }
  });
}
