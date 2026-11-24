import { describe, expect, it } from 'vitest';
import type { Channel, Programme, Reminder, ResumeEntry, SeriesItem, VodItem } from '../types';
import {
  buildHomeModel, HOME_ROW_ITEMS, pickHomeCatalog, topBy, watchlistTitle, type HomeChannel, type HomeSources,
} from './home';

const channel = (id: string): Channel => ({
  id, name: id, logo: '', group: 'Alpha', url: `http://host/${id}`, extras: null, playlistIds: [],
} as unknown as Channel);

const tuned = (id: string, channelIndex: number): HomeChannel => ({ channel: channel(id), channelIndex });

const program = (title: string): Programme => ({
  title, start: new Date(0), stop: new Date(1000), description: '', category: '', icon: '',
});

const resume = (itemId: string): ResumeEntry => ({
  accountId: 'a1', kind: 'vod', itemId, name: itemId, poster: '', ext: 'mp4',
  position: 60, duration: 600, updatedAt: 1,
});

const movie = (streamId: string, rating: string, addedAt?: number): VodItem => ({
  accountId: 'a1', streamId, name: streamId, poster: '', rating, categoryId: 'c1',
  containerExtension: 'mp4', addedAt,
});

const show = (seriesId: string, addedAt?: number): SeriesItem => ({
  accountId: 'a1', seriesId, name: seriesId, poster: '', rating: '', categoryId: 'c1', addedAt,
});

const reminder = (startMs: number): Reminder => ({
  channelKey: 'k1', channelName: 'ch1', title: 'Track 1', startMs, stopMs: startMs + 60_000,
});

function sources(overrides: Partial<HomeSources> = {}): HomeSources {
  return {
    recent: () => [tuned('ch1', 0), tuned('ch3', 2)],
    favorites: () => [tuned('ch2', 1)],
    nowPlaying: (ch) => (ch.id === 'ch1' ? program('Track 1') : null),
    resume: () => [resume('m1')],
    watchlist: () => [{
      accountId: 'a1', kind: 'series', itemId: 's9', name: 's9', poster: '', rating: '', categoryId: 'c1', addedAt: 2,
    }],
    catalog: () => ({ topRated: [movie('m2', '8')], recentlyAdded: [{ kind: 'series', item: show('s1', 5) }] }),
    loadCatalog: () => undefined,
    reminders: () => [reminder(5000)],
    hasXtream: () => true,
    playingIndex: () => -1,
    remove: () => undefined,
    ...overrides,
  };
}

describe('buildHomeModel', () => {
  it('lists recently watched channels newest first, with what is on now', () => {
    const model = buildHomeModel(sources(), 0);
    expect(model.recent.items.map(item => item.channel.id)).toEqual(['ch1', 'ch3']);
    expect(model.recent.items[0].now?.title).toBe('Track 1');
    expect(model.recent.items[1].now).toBeNull();
  });

  it('shows Continue watching only with an Xtream account', () => {
    expect(buildHomeModel(sources(), 0).resume.items).toHaveLength(1);
    expect(buildHomeModel(sources({ hasXtream: () => false }), 0).resume.items).toEqual([]);
  });

  it('shows the Watchlist only with an Xtream account', () => {
    expect(buildHomeModel(sources(), 0).watchlist.items.map(entry => entry.itemId)).toEqual(['s9']);
    expect(buildHomeModel(sources({ hasXtream: () => false }), 0).watchlist.items).toEqual([]);
  });

  it('opens a Watchlist entry as its catalog title', () => {
    const series = watchlistTitle({
      accountId: 'a1', kind: 'series', itemId: 's9', name: 's9', poster: '', rating: '', categoryId: 'c1', addedAt: 2,
    });
    expect(series).toEqual({ kind: 'series', item: {
      accountId: 'a1', seriesId: 's9', name: 's9', poster: '', rating: '', categoryId: 'c1',
    } });
    const film = watchlistTitle({
      accountId: 'a1', kind: 'vod', itemId: 'm9', name: 'm9', poster: '', rating: '', categoryId: 'c1', addedAt: 2,
    });
    expect(film.kind === 'vod' && film.item.containerExtension).toBe('mp4');
  });

  it('shows the catalog rows only with an Xtream account', () => {
    const xtream = buildHomeModel(sources(), 0);
    expect(xtream.topRated.items.map(item => item.streamId)).toEqual(['m2']);
    expect(xtream.recentlyAdded.items).toHaveLength(1);

    const m3u = buildHomeModel(sources({ hasXtream: () => false }), 0);
    expect(m3u.topRated.items).toEqual([]);
    expect(m3u.recentlyAdded.items).toEqual([]);
  });

  it('hides the catalog rows until the catalog loads', () => {
    const model = buildHomeModel(sources({ catalog: () => null }), 0);
    expect(model.topRated.items).toEqual([]);
    expect(model.recentlyAdded.items).toEqual([]);
  });

  it('caps every row and marks the ones with more for See all', () => {
    const many = Array.from({ length: HOME_ROW_ITEMS + 1 }, (_, i) => tuned(`ch${String(i)}`, i));
    const model = buildHomeModel(sources({
      recent: () => many,
      favorites: () => many.slice(0, HOME_ROW_ITEMS),
      resume: () => many.map((_, i) => resume(`m${String(i)}`)),
    }), 0);
    expect(model.recent.items).toHaveLength(HOME_ROW_ITEMS);
    expect(model.recent.more).toBe(true);
    expect(model.resume.items).toHaveLength(HOME_ROW_ITEMS);
    expect(model.resume.more).toBe(true);
    expect(model.favorites.items).toHaveLength(HOME_ROW_ITEMS);
    expect(model.favorites.more).toBe(false);
    expect(model.reminders.more).toBe(false);
  });
});

describe('topBy', () => {
  it('keeps the n highest, highest first, ties in input order', () => {
    const items = [3, 9, 1, 9, 5, 7];
    expect(topBy(items.map((v, i) => ({ v, i })), item => item.v, 3).map(item => item.i))
      .toEqual([1, 3, 5]);
  });

  it('skips items without a value', () => {
    expect(topBy([1, 2, 3], v => (v === 2 ? null : v), 5)).toEqual([3, 1]);
  });
});

describe('pickHomeCatalog', () => {
  it('ranks movies by rating and ignores unrated ones', () => {
    const rows = pickHomeCatalog([movie('m1', '6.5'), movie('m2', ''), movie('m3', '8.1'), movie('m4', '0')], []);
    expect(rows.topRated.map(item => item.streamId)).toEqual(['m3', 'm1']);
  });

  it('mixes movies and series, newest first, and ignores titles without a date', () => {
    const rows = pickHomeCatalog(
      [movie('m1', '', 100), movie('m2', '')],
      [show('s1', 300), show('s2', 200)],
    );
    expect(rows.recentlyAdded.map(title =>
      title.kind === 'vod' ? title.item.streamId : title.item.seriesId)).toEqual(['s1', 's2', 'm1']);
  });

  it('picks enough to fill a row and still know there are more', () => {
    const movies = Array.from({ length: 50 }, (_, i) => movie(`m${String(i)}`, String(i + 1)));
    expect(pickHomeCatalog(movies, []).topRated.length).toBeGreaterThan(HOME_ROW_ITEMS);
  });
});
