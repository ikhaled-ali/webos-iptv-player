import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  launchParamsObject,
  normalizeLaunchQuery,
  parseLaunchSearchQuery,
  routeLaunchParams,
} from './launch-intent';
import { CONFIG } from '../config';

afterEach(() => vi.restoreAllMocks());

describe('launchParamsObject', () => {
  it('parses a cold-launch JSON string and passes a relaunch object through', () => {
    expect(launchParamsObject('{"query":"Alpha"}')).toEqual({ query: 'Alpha' });
    expect(launchParamsObject({ query: 'Alpha' })).toEqual({ query: 'Alpha' });
  });

  it('rejects empty, malformed, and non-object params', () => {
    expect(launchParamsObject(undefined)).toBeNull();
    expect(launchParamsObject('')).toBeNull();
    expect(launchParamsObject('not json')).toBeNull();
    expect(launchParamsObject('"Alpha"')).toBeNull();
    expect(launchParamsObject('[1]')).toBeNull();
    expect(launchParamsObject(42)).toBeNull();
  });
});

describe('normalizeLaunchQuery', () => {
  it('trims, collapses whitespace, and drops control characters', () => {
    expect(normalizeLaunchQuery('  Alpha \n\t News  ')).toBe('Alpha News');
    expect(normalizeLaunchQuery('ch1\u0000ch2')).toBe('ch1 ch2');
  });

  it('caps the length', () => {
    const long = 'a'.repeat(CONFIG.SEARCH.LAUNCH_QUERY_MAX_LENGTH + 50);
    expect(normalizeLaunchQuery(long)).toHaveLength(CONFIG.SEARCH.LAUNCH_QUERY_MAX_LENGTH);
  });

  it('rejects blank and non-string values', () => {
    expect(normalizeLaunchQuery('   ')).toBeNull();
    expect(normalizeLaunchQuery(7)).toBeNull();
    expect(normalizeLaunchQuery(null)).toBeNull();
    expect(normalizeLaunchQuery({ text: 'Alpha' })).toBeNull();
  });
});

describe('parseLaunchSearchQuery', () => {
  it('reads the query from a JSON string or an object', () => {
    expect(parseLaunchSearchQuery(JSON.stringify({ query: 'Bravo' }))).toBe('Bravo');
    expect(parseLaunchSearchQuery({ query: ' Bravo ' })).toBe('Bravo');
  });

  it('returns null when no query is present', () => {
    expect(parseLaunchSearchQuery({})).toBeNull();
    expect(parseLaunchSearchQuery({ query: '' })).toBeNull();
    expect(parseLaunchSearchQuery({ reminderChannelKey: 'ch1' })).toBeNull();
    expect(parseLaunchSearchQuery('not json')).toBeNull();
  });
});

describe('routeLaunchParams', () => {
  function handlers(reminderHandled = false) {
    return {
      reminder: vi.fn((_raw: unknown) => reminderHandled),
      search: vi.fn((_query: string) => undefined),
    };
  }

  it('routes a query to search on cold launch and relaunch', () => {
    const cold = handlers();
    expect(routeLaunchParams('{"query":"Charlie"}', 'launch', cold)).toBe('search');
    expect(cold.search).toHaveBeenCalledWith('Charlie');

    const warm = handlers();
    expect(routeLaunchParams({ query: 'Charlie' }, 'relaunch', warm)).toBe('search');
    expect(warm.search).toHaveBeenCalledWith('Charlie');
  });

  it('lets a handled reminder win over a query', () => {
    const h = handlers(true);
    expect(routeLaunchParams({ reminderChannelKey: 'ch1', query: 'Alpha' }, 'relaunch', h)).toBe('reminder');
    expect(h.reminder).toHaveBeenCalledWith({ reminderChannelKey: 'ch1', query: 'Alpha' });
    expect(h.search).not.toHaveBeenCalled();
  });

  it('falls through to search when the reminder channel is gone', () => {
    const h = handlers(false);
    expect(routeLaunchParams({ reminderChannelKey: 'gone', query: 'Alpha' }, 'launch', h)).toBe('search');
    expect(h.search).toHaveBeenCalledWith('Alpha');
  });

  it('does nothing for params without a reminder or a query', () => {
    for (const raw of [undefined, '', '{}', 'not json', { query: '  ' }]) {
      const h = handlers();
      expect(routeLaunchParams(raw, 'launch', h)).toBe('none');
      expect(h.search).not.toHaveBeenCalled();
    }
  });

  it('logs the search route without the query text', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    routeLaunchParams({ query: 'Delta' }, 'relaunch', handlers());
    expect(log).toHaveBeenCalledWith(
      '[Launch]',
      'Launch opened search',
      'event=launch.search',
      'via=relaunch',
      'length=5',
    );
  });
});
