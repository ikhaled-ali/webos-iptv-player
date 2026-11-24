import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlaylistEntry, SeriesItem, VodItem } from '../types';
import { CONFIG } from '../config';

const catalog = vi.hoisted(() => ({
  movies: [] as VodItem[],
  series: [] as SeriesItem[],
}));

vi.mock('../services/xtream-catalog', () => ({
  loadAllVodStreams: vi.fn(() => Promise.resolve(catalog.movies)),
  loadAllSeries: vi.fn(() => Promise.resolve(catalog.series)),
}));

import { loadAllVodStreams } from '../services/xtream-catalog';
import { liveHomeSources } from './home';

const account = { id: 'a1', name: 'Alpha', url: 'http://host', source: 'xtream' } as PlaylistEntry;

const movie = (streamId: string, rating: string): VodItem => ({
  accountId: 'a1', streamId, name: streamId, poster: '', rating, categoryId: 'c1', containerExtension: 'mp4',
});

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('liveHomeSources catalog picks', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(loadAllVodStreams).mockClear();
  });

  it('keeps the Top rated and Recently added picks for an hour', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    catalog.movies = [movie('m1', '7')];
    const sources = liveHomeSources(() => account, () => -1);
    const onReady = vi.fn();

    sources.loadCatalog(onReady);
    await settle();
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(sources.catalog()?.topRated.map(item => item.streamId)).toEqual(['m1']);

    catalog.movies = [movie('m2', '9')];
    vi.setSystemTime(1_000_000 + CONFIG.XTREAM.HOME_PICKS_TTL_MS - 1);
    sources.loadCatalog(onReady);
    await settle();
    expect(loadAllVodStreams).toHaveBeenCalledTimes(1);
    expect(sources.catalog()?.topRated.map(item => item.streamId)).toEqual(['m1']);

    vi.setSystemTime(1_000_000 + CONFIG.XTREAM.HOME_PICKS_TTL_MS);
    sources.loadCatalog(onReady);
    await settle();
    expect(loadAllVodStreams).toHaveBeenCalledTimes(2);
    expect(onReady).toHaveBeenCalledTimes(2);
    expect(sources.catalog()?.topRated.map(item => item.streamId)).toEqual(['m2']);
  });
});
