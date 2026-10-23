// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const scope = window as unknown as Record<string, unknown>;
beforeEach(() => { vi.resetModules(); delete scope.__Hls; delete scope.__mpegts; });
afterEach(() => {
  delete scope.__Hls; delete scope.__mpegts;
  document.querySelector('script[src="js/player-libs.js"]')?.remove();
  vi.useRealTimers();
});

describe('optional player loading', () => {
  it('shares one request and reuses the loaded libraries', async () => {
    const { loadPlayerLibraries } = await import('./player-libs-loader');
    const first = loadPlayerLibraries();
    const second = loadPlayerLibraries();
    expect(first).toBe(second);
    expect(document.querySelectorAll('script[src="js/player-libs.js"]')).toHaveLength(1);
    scope.__Hls = {}; scope.__mpegts = {};
    document.querySelector('script[src="js/player-libs.js"]')!.dispatchEvent(new Event('load'));
    await first;
    await loadPlayerLibraries();
    expect(document.querySelectorAll('script[src="js/player-libs.js"]')).toHaveLength(1);
  });

  it('times out without leaving retries permanently stuck', async () => {
    vi.useFakeTimers();
    const { loadPlayerLibraries } = await import('./player-libs-loader');
    const loading = loadPlayerLibraries();
    const rejected = expect(loading).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(10000);
    await rejected;
    expect(document.querySelector('script[src="js/player-libs.js"]')).toBeNull();
    const retry = loadPlayerLibraries();
    scope.__Hls = {}; scope.__mpegts = {};
    document.querySelector('script[src="js/player-libs.js"]')!.dispatchEvent(new Event('load'));
    await retry;
  });
});
