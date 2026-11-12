import { describe, expect, it, vi } from 'vitest';
import {
  channelLoadFraction,
  fractionOf,
  LoadProgressTracker,
  percentOf,
} from './load-progress';

const progress = (fields: Partial<Parameters<typeof channelLoadFraction>[0]>) => ({
  sourceNumber: 1,
  sourceCount: 1,
  inputBytes: 0,
  channelsProcessed: 0,
  channelsKept: 0,
  ...fields,
});

describe('fractionOf', () => {
  it('divides done by total and clamps to 0..1', () => {
    expect(fractionOf(3, 12)).toBe(0.25);
    expect(fractionOf(15, 12)).toBe(1);
    expect(fractionOf(-1, 12)).toBe(0);
  });

  it('reads an unknown or empty total as nothing done', () => {
    expect(fractionOf(4, 0)).toBe(0);
    expect(fractionOf(Number.NaN, 4)).toBe(0);
  });
});

describe('channelLoadFraction', () => {
  it('measures an Xtream source by channels kept against its Live catalog', () => {
    expect(channelLoadFraction(progress({ channelsKept: 900, sourceChannelsKept: 250, expectedChannels: 1000 }))).toBe(0.25);
  });

  it('measures an M3U source by bytes read against the response length', () => {
    expect(channelLoadFraction(progress({ inputBytes: 512, totalBytes: 2048 }))).toBe(0.25);
  });

  it('prefers the channel total over the byte total', () => {
    expect(channelLoadFraction(progress({
      sourceChannelsKept: 10, expectedChannels: 20, inputBytes: 1, totalBytes: 100,
    }))).toBe(0.5);
  });

  it('weighs every source equally and counts finished ones in full', () => {
    expect(channelLoadFraction(progress({
      sourceNumber: 2, sourceCount: 4, channelsKept: 150, sourceChannelsKept: 50, expectedChannels: 100,
    }))).toBe(0.375);
  });

  it('moves only per source when a source has no known total', () => {
    expect(channelLoadFraction(progress({ sourceNumber: 2, sourceCount: 2, inputBytes: 9000 }))).toBe(0.5);
    expect(channelLoadFraction(progress({ inputBytes: 9000 }))).toBe(0);
  });

  it('caps a source that overshoots its total, such as a compressed length', () => {
    expect(channelLoadFraction(progress({ inputBytes: 5000, totalBytes: 1000 }))).toBe(1);
  });
});

describe('percentOf', () => {
  it('floors the fraction and holds a loading row below 100', () => {
    expect(percentOf({ part: 'movies', fraction: 0.456, status: 'loading' })).toBe(45);
    expect(percentOf({ part: 'movies', fraction: 1, status: 'loading' })).toBe(99);
  });

  it('shows a finished row as 100 whatever its fraction', () => {
    expect(percentOf({ part: 'series', fraction: 0.2, status: 'done' })).toBe(100);
  });

  it('keeps where a failed row stopped', () => {
    expect(percentOf({ part: 'series', fraction: 0.3, status: 'failed' })).toBe(30);
  });
});

describe('LoadProgressTracker', () => {
  it('starts every row at zero and settles once none is loading', () => {
    const tracker = new LoadProgressTracker();
    const session = tracker.start(['channels', 'movies']);
    expect(tracker.rows()).toEqual([
      { part: 'channels', fraction: 0, status: 'loading' },
      { part: 'movies', fraction: 0, status: 'loading' },
    ]);
    expect(tracker.settled).toBe(false);
    tracker.settle(session, 'channels', true);
    expect(tracker.settled).toBe(false);
    tracker.settle(session, 'movies', false);
    expect(tracker.settled).toBe(true);
    expect(tracker.rows().map(percentOf)).toEqual([100, 0]);
  });

  it('never moves a row backward', () => {
    const tracker = new LoadProgressTracker();
    const session = tracker.start(['channels']);
    tracker.update(session, 'channels', 0.6);
    tracker.update(session, 'channels', 0.4);
    expect(tracker.rows()[0].fraction).toBe(0.6);
  });

  it('ignores updates once a row settled', () => {
    const tracker = new LoadProgressTracker();
    const session = tracker.start(['series']);
    tracker.settle(session, 'series', false);
    tracker.update(session, 'series', 0.9);
    tracker.settle(session, 'series', true);
    expect(tracker.rows()[0]).toEqual({ part: 'series', fraction: 0, status: 'failed' });
  });

  it('ignores an older session after a new load starts', () => {
    const tracker = new LoadProgressTracker();
    const old = tracker.start(['channels', 'movies']);
    const current = tracker.start(['channels']);
    tracker.update(old, 'channels', 0.8);
    tracker.settle(old, 'channels', true);
    tracker.drop(old, 'channels');
    expect(tracker.isCurrent(old)).toBe(false);
    expect(tracker.isCurrent(current)).toBe(true);
    expect(tracker.rows()).toEqual([{ part: 'channels', fraction: 0, status: 'loading' }]);
  });

  it('drops a row that will not load and settles without it', () => {
    const tracker = new LoadProgressTracker();
    const session = tracker.start(['channels', 'movies']);
    tracker.settle(session, 'channels', true);
    tracker.drop(session, 'movies');
    expect(tracker.rows().map(row => row.part)).toEqual(['channels']);
    expect(tracker.settled).toBe(true);
  });

  it('clears every row on cancel', () => {
    const tracker = new LoadProgressTracker();
    const session = tracker.start(['channels']);
    tracker.cancel(session);
    expect(tracker.rows()).toEqual([]);
    expect(tracker.isCurrent(session)).toBe(false);
  });

  it('notifies listeners on each change but not on a no-op', () => {
    const tracker = new LoadProgressTracker();
    const listener = vi.fn();
    tracker.onChange(listener);
    const session = tracker.start(['channels']);
    tracker.update(session, 'channels', 0.5);
    tracker.update(session, 'channels', 0.5);
    tracker.settle(session, 'channels', true);
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
