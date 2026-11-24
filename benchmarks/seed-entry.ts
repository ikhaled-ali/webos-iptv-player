// Benchmark-only seeding API, injected into a page without the app. Fixture
// data goes through the production persistence code, so records carry the
// current on-disk format: vault-sealed keys, protected credential fields, and
// the credentials-only migration marker that otherwise clears every cache.
import {
  flushCacheWrites,
  getCachedPlaylist,
  setCachedCatalog,
  setCachedEpg,
  setCachedPlaylist,
} from '../src/services/idb-cache';
import { initSecurePersistence } from '../src/services/secure-persistence';
import {
  flushSecureLocal,
  localValue,
  removeLocalValue,
  writeLocalValue,
} from '../src/services/secure-local';
import type { Channel, EpgSource, ParsedEpg } from '../src/types';

interface FixtureCacheEntry {
  store: 'playlist-cache' | 'epg-cache' | 'catalog-cache';
  record: Record<string, unknown> & {
    key?: string;
    url?: string;
    timestamp?: number;
    data?: unknown;
    state?: unknown;
    filter?: unknown;
  };
}

interface BenchmarkSeedApi {
  init(): Promise<void>;
  sealCacheEntries(entries: FixtureCacheEntry[]): Promise<void>;
  readPlaylist(): Promise<{ channels: Channel[]; epgSources: EpgSource[] } | null>;
  writePlaylist(channels: Channel[], epgSources: EpgSource[]): Promise<void>;
  localValue(key: string): string | null;
  setLocal(key: string, value: string | null): void;
  flush(): Promise<void>;
}

declare global {
  interface Window {
    __IPTV_BENCHMARK_SEED__?: BenchmarkSeedApi;
  }
}

window.__IPTV_BENCHMARK_SEED__ = {
  init: () => initSecurePersistence(),
  async sealCacheEntries(entries) {
    for (const { store, record } of entries) {
      if (store === 'playlist-cache') {
        const data = record.data as { channels: Channel[]; epgSources?: EpgSource[] };
        await setCachedPlaylist(data.channels, data.epgSources ?? [], record.timestamp, null);
      } else if (store === 'epg-cache') {
        await setCachedEpg(
          record.url as string,
          record.data as ParsedEpg,
          (record.filter ?? null) as never,
          record.timestamp,
          null,
        );
      } else {
        await setCachedCatalog(
          record.key as string,
          record.data,
          null,
          record.state as never,
        );
      }
    }
    await flushCacheWrites();
  },
  async readPlaylist() {
    const cached = await getCachedPlaylist(null);
    return cached ? { channels: cached.channels, epgSources: cached.epgSources } : null;
  },
  async writePlaylist(channels, epgSources) {
    await setCachedPlaylist(channels, epgSources, Date.now(), null);
    await flushCacheWrites();
  },
  localValue,
  setLocal(key, value) {
    if (value === null) removeLocalValue(key);
    else writeLocalValue(key, value);
  },
  flush: () => flushSecureLocal(),
};
