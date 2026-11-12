import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel, PlaylistEntry, Reminder } from '../types';

const mocks = vi.hoisted(() => ({
  removeSources: vi.fn(),
  forgetAccountData: vi.fn(),
  reminders: [] as Reminder[],
  removeReminder: vi.fn(),
  forgetHealth: vi.fn(async () => {}),
  clearEpg: vi.fn(async () => {}),
  forgetCatalog: vi.fn(async () => {}),
}));

vi.mock('./playlist-service', () => ({ PlaylistService: { removeSources: mocks.removeSources } }));
vi.mock('./storage-service', () => ({ StorageService: { forgetAccountData: mocks.forgetAccountData } }));
vi.mock('./reminder-service', () => ({
  ReminderService: { list: () => mocks.reminders, remove: mocks.removeReminder },
}));
vi.mock('./channel-health', () => ({ ChannelHealthService: { forget: mocks.forgetHealth } }));
vi.mock('./idb-cache', () => ({ clearCachedEpgSources: mocks.clearEpg }));
vi.mock('./xtream-catalog', () => ({ forgetAccountCatalog: mocks.forgetCatalog }));

import { forgetXtreamAccounts, removedXtreamAccountIds } from './account-removal';
import { channelKey } from '../utils/channel';

const channel = (url: string): Channel => ({
  id: '', name: '', logo: '', group: '', url, extras: null,
  playlistIds: ['x1'], catchup: '', catchupSource: '', catchupDays: 0,
});
const reminder = (key: string): Reminder => ({
  channelKey: key, channelName: 'Alpha', title: 'Program Alpha', startMs: 1_000, stopMs: 2_000,
});
const xtream = (id: string): PlaylistEntry => ({
  id, name: id, url: 'http://host', source: 'xtream', xtream: { username: 'u', password: 'p' },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.reminders = [];
  mocks.removeSources.mockReturnValue({ channels: [channel('http://host/a')], epgUrls: ['http://host/guide'] });
});

describe('removedXtreamAccountIds', () => {
  it('lists only Xtream accounts that are gone, not edited ones or playlists', () => {
    const previous = [xtream('x1'), xtream('x2'), { id: 'p1', name: 'P1', url: 'http://host/b' }];
    const next = [{ ...xtream('x2'), url: 'http://host/changed' }];
    expect(removedXtreamAccountIds(previous, next)).toEqual(['x1']);
  });
});

describe('forgetXtreamAccounts', () => {
  it('drops the account everywhere and only the reminders of its own channels', async () => {
    const own = channelKey(channel('http://host/a'));
    mocks.reminders = [reminder(own), reminder('shared')];
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});

    const removal = forgetXtreamAccounts(['x1'], async () => {});
    await removal.done;

    expect(mocks.removeSources).toHaveBeenCalledWith(['x1']);
    expect(mocks.forgetAccountData).toHaveBeenCalledWith(['x1'], [own], ['http://host/guide']);
    expect(mocks.removeReminder).toHaveBeenCalledTimes(1);
    expect(mocks.removeReminder).toHaveBeenCalledWith(own, 1_000);
    expect(mocks.forgetCatalog).toHaveBeenCalledWith('x1');
    expect(mocks.forgetHealth).toHaveBeenCalledWith([own]);
    expect(mocks.clearEpg).toHaveBeenCalledWith(['http://host/guide']);
    expect(info).toHaveBeenCalledWith('[AccountRemoval]', 'Removed account data deleted',
      'event=account.data.removed', 'accounts=1', 'channels=1', 'guides=1');
    info.mockRestore();
  });

  it('deletes a cached guide only once the guide has its new sources', async () => {
    let settle = (): void => {};
    const guides = new Promise<void>(resolve => { settle = resolve; });

    const removal = forgetXtreamAccounts(['x1'], () => guides);
    await Promise.resolve();
    expect(mocks.clearEpg).not.toHaveBeenCalled();
    settle();
    await removal.done;
    expect(mocks.clearEpg).toHaveBeenCalledWith(['http://host/guide']);
  });

  it('logs a cache that could not be deleted', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.forgetCatalog.mockRejectedValueOnce(new Error('blocked'));

    const removal = forgetXtreamAccounts(['x1'], async () => {});

    await expect(removal.done).rejects.toThrow('blocked');
    await Promise.resolve();
    expect(warn).toHaveBeenCalledWith('[AccountRemoval]', 'Removed account cache could not be deleted',
      'event=account.data.remove.failed', 'accounts=1', expect.anything());
    warn.mockRestore();
  });
});
