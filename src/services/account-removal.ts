import type { PlaylistEntry } from '../types';
import { channelKey } from '../utils/channel';
import { createLogger } from '../utils/logger';
import { ChannelHealthService } from './channel-health';
import { clearCachedEpgSources } from './idb-cache';
import { PlaylistService } from './playlist-service';
import { ReminderService } from './reminder-service';
import { StorageService } from './storage-service';
import { forgetAccountCatalog } from './xtream-catalog';

const log = createLogger('AccountRemoval');

export interface AccountRemoval {
  channelKeys: string[];
  epgUrls: string[];
  // Settles once the cached data is gone from IndexedDB too.
  done: Promise<void>;
}

/** Xtream accounts in `previous` that `next` no longer has; an edited one keeps its id. */
export function removedXtreamAccountIds(previous: PlaylistEntry[], next: PlaylistEntry[]): string[] {
  const kept = new Set(next.map(entry => entry.id));
  return previous.filter(entry => entry.source === 'xtream' && !kept.has(entry.id)).map(entry => entry.id);
}

/**
 * Remove everything removed accounts brought, at once: their channels and
 * guides from memory, then their catalogs, caches, history, and the user data
 * of channels no other source carries. `updateGuides` hands the guide its new
 * sources; a guide's cache goes once it settles, so a refresh in flight can't
 * write it back.
 */
export function forgetXtreamAccounts(
  accountIds: string[],
  updateGuides: () => Promise<void>,
): AccountRemoval {
  const { channels, epgUrls } = PlaylistService.removeSources(accountIds);
  const channelKeys = Array.from(new Set(channels.map(channelKey)));
  const removedKeys = new Set(channelKeys);
  StorageService.forgetAccountData(accountIds, channelKeys, epgUrls);
  for (const reminder of ReminderService.list()) {
    if (removedKeys.has(reminder.channelKey)) ReminderService.remove(reminder.channelKey, reminder.startMs);
  }
  const done = Promise.all([
    ...accountIds.map(id => forgetAccountCatalog(id)),
    ChannelHealthService.forget(channelKeys),
    updateGuides().then(() => clearCachedEpgSources(epgUrls)),
  ]).then(() => undefined);
  log.info(
    'Removed account data deleted',
    'event=account.data.removed',
    `accounts=${String(accountIds.length)}`,
    `channels=${String(channelKeys.length)}`,
    `guides=${String(epgUrls.length)}`,
  );
  done.catch((err: unknown) => log.warn(
    'Removed account cache could not be deleted',
    'event=account.data.remove.failed',
    `accounts=${String(accountIds.length)}`,
    err,
  ));
  return { channelKeys, epgUrls, done };
}
