// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { CatchupProgressEntry, ChannelCustomization, ResumeEntry, WatchlistEntry } from '../types';
import { loadUserRecords } from './idb-user-data';
import { StorageService } from './storage-service';

const resume = (accountId: string): ResumeEntry => ({
  accountId, kind: 'vod', itemId: '10', name: 'Movie Alpha', poster: '', ext: 'mp4',
  position: 120, duration: 3_600, updatedAt: 3_000,
});
const watch = (accountId: string): WatchlistEntry => ({
  accountId, kind: 'vod', itemId: '10', name: 'Movie Alpha', poster: '', rating: '',
  categoryId: '1', addedAt: 4_000,
});
const catchup = (channelKey: string): CatchupProgressEntry & { expiresAt: number } => ({
  channelKey, progStart: 5_000, progEnd: 6_000, position: 60, duration: 300,
  updatedAt: 5_500, completed: false, expiresAt: Date.now() + 86_400_000,
});
const pick = { providerId: 'subdl', id: 'sub1', name: 'Track 1', lang: 'l1', format: 'srt' };
const track = { name: 'Track 1', lang: 'l1' };
const subtitle = { off: false, name: 'Track 2', lang: 'l2' };

describe('StorageService.forgetAccountData', () => {
  it('deletes a removed account and its own channels from memory and IndexedDB, keeping the rest', async () => {
    const customization: ChannelCustomization = {
      version: 1,
      overrides: { ch1: { name: 'Bravo' }, ch2: { name: 'Charlie' } },
      order: ['ch1', 'ch2'],
      groupOrder: ['Group Alpha'],
      groupOverrides: {},
      customGroups: [],
    };
    const seed: Record<string, unknown> = {
      favorites: ['ch1', 'ch2'],
      channel_custom: customization,
      audio_prefs: { ch1: track, ch2: track, 'vod:x1:vod:10': track, 'vod:x2:vod:10': track },
      subtitle_prefs: { ch1: subtitle, 'vod:x1:episode:5': subtitle, ch2: subtitle },
      subtitle_offsets: { ch1: 1.5, ch2: 2 },
      resume: { 'x1|vod|10': resume('x1'), 'x2|vod|10': resume('x2') },
      watchlist: { 'x1|vod|10': watch('x1'), 'x2|vod|10': watch('x2') },
      online_sub_picks: { 'x1|vod|10': pick, 'x2|vod|10': pick },
      catchup_progress: { 'ch1|5000': catchup('ch1'), 'ch2|5000': catchup('ch2') },
      recently_watched_live: [{ channelKey: 'ch1', updatedAt: 7_000 }, { channelKey: 'ch2', updatedAt: 6_000 }],
      epg_offsets: { 'http://host/a': 30, 'http://host/b': 15 },
      selectedXtream: 'x1',
    };
    for (const key of Object.keys(seed)) localStorage.setItem(`iptv_${key}`, JSON.stringify(seed[key]));
    await StorageService.init();
    StorageService.markEpisodeWatched('x1', 's1', 'e1');
    StorageService.markEpisodeWatched('x2', 's1', 'e1');

    StorageService.forgetAccountData(['x1'], ['ch1'], ['http://host/a']);

    expect(StorageService.getFavorites()).toEqual(['ch2']);
    expect(StorageService.getAudioPref('ch1')).toBeNull();
    expect(StorageService.getAudioPref('vod:x1:vod:10')).toBeNull();
    expect(StorageService.getAudioPref('vod:x2:vod:10')).toEqual(track);
    expect(StorageService.getSubtitlePref('vod:x1:episode:5')).toBeNull();
    expect(StorageService.getSubtitlePref('ch2')).toEqual(subtitle);
    expect(StorageService.getSubtitleOffset('ch1')).toBe(0);
    expect(StorageService.getSubtitleOffset('ch2')).toBe(2);
    expect(StorageService.getResumeList('x1')).toEqual([]);
    expect(StorageService.getResumeList('x2')).toHaveLength(1);
    expect(StorageService.getWatchlist('x1', 'vod')).toEqual([]);
    expect(StorageService.getWatchlist('x2', 'vod')).toHaveLength(1);
    expect(StorageService.getPickedOnlineSub('x1', 'vod', '10')).toBeNull();
    expect(StorageService.getPickedOnlineSub('x2', 'vod', '10')).toEqual(pick);
    expect(StorageService.getWatchedEpisodes('x1', 's1')).toEqual([]);
    expect(StorageService.getWatchedEpisodes('x2', 's1')).toEqual(['e1']);
    expect(StorageService.getAllCatchupProgress().map(entry => entry.channelKey)).toEqual(['ch2']);
    expect(StorageService.getRecentlyWatchedLive().map(entry => entry.channelKey)).toEqual(['ch2']);
    expect(StorageService.getChannelCustomization()).toEqual({
      ...customization, overrides: { ch2: { name: 'Charlie' } }, order: ['ch2'],
    });
    expect(StorageService.getEpgOffsets()).toEqual({ 'http://host/b': 15 });
    expect(StorageService.getSelectedXtreamAccountId()).toBeNull();

    await StorageService.flush();
    const keys = async (store: Parameters<typeof loadUserRecords>[0]) =>
      (await loadUserRecords(store)).map(item => item.key).sort();
    expect(await keys('favorites')).toEqual(['favorite:ch2']);
    expect(await keys('playback-progress')).toEqual([
      'catchup:ch2|5000', 'resume:x2|vod|10', 'watched:x2|s1',
    ]);
    expect(await keys('watchlist')).toEqual(['watch:x2|vod|10']);
    expect(await keys('online-sub-picks')).toEqual(['pick:x2|vod|10']);
    expect(await keys('recently-watched')).toEqual(['live:ch2']);
    const channelState = await keys('channel-state');
    expect(channelState.filter(key => key.includes('ch1') || key.includes('x1'))).toEqual([]);
    expect(channelState).toEqual(expect.arrayContaining([
      'audio:ch2', 'audio:vod:x2:vod:10', 'custom:channel:ch2', 'offset:ch2', 'subtitle:ch2',
    ]));
  });
});
