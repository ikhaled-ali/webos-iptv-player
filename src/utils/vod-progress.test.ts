import { describe, expect, it } from 'vitest';
import type { ResumeEntry } from '../types';
import { latestPerSeries, upNextResume, vodFinished } from './vod-progress';

const entry = (over: Partial<ResumeEntry>): ResumeEntry => ({
  accountId: 'x1', kind: 'episode', itemId: 'e1', name: 'Series One — S1E1', poster: '', ext: 'mp4',
  position: 100, duration: 1800, updatedAt: 1000, ...over,
});

describe('vodFinished', () => {
  it('counts the last 5% or the last 30 seconds, whichever is longer, as finished', () => {
    expect(vodFinished(7200 - 361, 7200)).toBe(false);
    expect(vodFinished(7200 - 360, 7200)).toBe(true); // 5% of a 2-hour film
    expect(vodFinished(300 - 31, 300)).toBe(false);
    expect(vodFinished(300 - 30, 300)).toBe(true); // the 30-second floor
  });

  it('never finishes a title of unknown length', () => {
    expect(vodFinished(5000, 0)).toBe(false);
    expect(vodFinished(5000, NaN)).toBe(false);
  });
});

describe('latestPerSeries', () => {
  it('keeps the newest episode of each series and every movie', () => {
    const s1 = { kind: 'series' as const, itemId: 's1' };
    const s2 = { kind: 'series' as const, itemId: 's2' };
    const list = [
      entry({ itemId: 'e3', watchlistOwner: s1 }),
      entry({ itemId: 'f1', watchlistOwner: s2 }),
      entry({ itemId: 'e1', watchlistOwner: s1 }),
      entry({ itemId: 'legacy' }),
      entry({ kind: 'vod', itemId: 'm1' }),
    ];
    expect(latestPerSeries(list).map(e => e.itemId)).toEqual(['e3', 'f1', 'legacy', 'm1']);
  });
});

describe('upNextResume', () => {
  it('lists the next episode at the start with the rest of the queue', () => {
    const owner = { kind: 'series' as const, itemId: 's1' };
    const next = {
      url: 'http://host/a', title: 'Series One — S1E2', poster: 'http://host/p', accountId: 'x1',
      itemId: 'e2', kind: 'episode' as const, categoryId: 'c1', subtitles: [],
      searchMeta: { season: 1, episode: 2 }, watchlistOwner: owner,
    };
    const rest = [{ ...next, itemId: 'e3' }];
    expect(upNextResume(next, rest, 'mkv')).toMatchObject({
      itemId: 'e2', name: 'Series One — S1E2', ext: 'mkv', position: 0, duration: 0,
      upNext: true, episodeQueue: rest, watchlistOwner: owner, categoryId: 'c1',
      searchMeta: { season: 1, episode: 2 },
    });
  });
});
