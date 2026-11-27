import { createLogger } from '../utils/logger';
import { getCachedCatalog, setCachedCatalog } from './idb-cache';
import type { BroadcastStats } from './broadcast-service';
import type { BroadcastChannel, Transponder } from './broadcast-normalize';

// What the Satellite section shows before the TV answers: the channel list,
// the transponders, and each channel's last reception, kept in the
// disposable IndexedDB cache. Reads come from memory once loaded; the TV's
// answers replace them in the background and are written back.

const log = createLogger('BroadcastCache');

const CHANNELS_KEY = 'satellite:channels';
const TRANSPONDERS_KEY = 'satellite:transponders';
const STATS_KEY = 'satellite:stats';
// Reception changes slowly; writes are batched.
const STATS_WRITE_DELAY_MS = 15000;
// Enough for every scanned service several times over.
const STATS_LIMIT = 2000;

// Reception as last seen, without the moment-to-moment lock state.
export type CachedStats = Pick<BroadcastStats,
  'strength' | 'quality' | 'width' | 'height' | 'fps' | 'interlaced' | 'hdr' | 'codec'>;

let loading: Promise<void> | null = null;
let channels: BroadcastChannel[] | null = null;
let channelsSignature = '';
const transponders = new Map<number, Transponder>();
const stats = new Map<string, CachedStats>();
let statsTimer: ReturnType<typeof setTimeout> | null = null;

function signature(list: readonly BroadcastChannel[]): string {
  let text = '';
  for (const channel of list) text += `${channel.id}\u0001${channel.name}\u0001${channel.numberLabel}\u0002`;
  return text;
}

function isChannelList(value: unknown): value is BroadcastChannel[] {
  return Array.isArray(value) && value.every(item => !!item && typeof item === 'object'
    && typeof (item as BroadcastChannel).id === 'string' && typeof (item as BroadcastChannel).name === 'string');
}

async function read(): Promise<void> {
  try {
    const [cachedChannels, cachedTransponders, cachedStats] = await Promise.all([
      getCachedCatalog<unknown>(CHANNELS_KEY),
      getCachedCatalog<unknown>(TRANSPONDERS_KEY),
      getCachedCatalog<unknown>(STATS_KEY),
    ]);
    // A list cached before services had a stable key is read again from the
    // TV rather than ordered by keys that would not match it.
    if (cachedChannels && isChannelList(cachedChannels.data)
        && cachedChannels.data.every(channel => typeof channel.serviceKey === 'string')) {
      channels = cachedChannels.data.map(channel => ({ ...channel, transponderId: channel.transponderId || 0 }));
      channelsSignature = signature(channels);
    }
    if (cachedTransponders && Array.isArray(cachedTransponders.data)) {
      for (const item of cachedTransponders.data as Transponder[]) {
        if (item && typeof item.id === 'number') transponders.set(item.id, item);
      }
    }
    if (cachedStats && cachedStats.data && typeof cachedStats.data === 'object') {
      const entries = cachedStats.data as Record<string, CachedStats>;
      for (const id of Object.keys(entries)) stats.set(id, entries[id]);
    }
  } catch (err) {
    log.warn('Satellite cache unreadable', 'event=satellite.cache.read_failed', err);
  }
}

function persistStats(): void {
  statsTimer = null;
  const data: Record<string, CachedStats> = {};
  stats.forEach((value, id) => { data[id] = value; });
  void setCachedCatalog(STATS_KEY, data, null);
}

export const BroadcastCache = {
  // Loads every record once; later calls share the same read.
  load(): Promise<void> {
    if (!loading) loading = read();
    return loading;
  },

  channels(): BroadcastChannel[] | null {
    return channels;
  },

  // Stores a fresh list; false when it matches the cached one.
  saveChannels(list: BroadcastChannel[]): boolean {
    const next = signature(list);
    const changed = next !== channelsSignature || !channels;
    channels = list;
    channelsSignature = next;
    // Written even when unchanged, so field additions reach the cache.
    void setCachedCatalog(CHANNELS_KEY, list, null);
    return changed;
  },

  // A scan changed the TV's list: the next open reads it again.
  invalidate(): void {
    channels = null;
    channelsSignature = '';
    transponders.clear();
  },

  transponder(id: number): Transponder | null {
    return id ? transponders.get(id) ?? null : null;
  },

  hasTransponders(): boolean {
    return transponders.size > 0;
  },

  saveTransponders(list: Transponder[]): void {
    transponders.clear();
    for (const item of list) transponders.set(item.id, item);
    void setCachedCatalog(TRANSPONDERS_KEY, list, null);
  },

  stats(channelId: string): CachedStats | null {
    return stats.get(channelId) ?? null;
  },

  rememberStats(channelId: string, value: CachedStats): void {
    stats.delete(channelId);
    stats.set(channelId, value);
    if (stats.size > STATS_LIMIT) {
      const oldest = stats.keys().next();
      if (!oldest.done) stats.delete(oldest.value);
    }
    if (!statsTimer) statsTimer = setTimeout(persistStats, STATS_WRITE_DELAY_MS);
  },

  // Writes pending reception now, such as when the section is left.
  flush(): void {
    if (!statsTimer) return;
    clearTimeout(statsTimer);
    persistStats();
  },
};
