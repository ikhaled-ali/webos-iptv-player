// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel } from '../types';
import { Focus } from '../navigation/focus-scope';
import { HomeView, type HomeChannel, type HomeSources } from './home';

const channel = (id: string): Channel => ({
  id, name: id, logo: '', group: 'Alpha', url: `http://host/${id}`, extras: null, playlistIds: [],
} as unknown as Channel);

const tuned = (id: string, channelIndex: number): HomeChannel => ({ channel: channel(id), channelIndex });

function sources(): HomeSources {
  return {
    recent: () => [tuned('ch1', 0), tuned('ch2', 1), tuned('ch3', 2)],
    favorites: () => [],
    nowPlaying: () => null,
    resume: () => [],
    watchlist: () => [],
    catalog: () => null,
    loadCatalog: () => undefined,
    reminders: () => [],
    hasXtream: () => false,
    playingIndex: () => -1,
  } as unknown as HomeSources;
}

describe('HomeView pointer', () => {
  let container: HTMLElement;
  let home: HomeView;

  beforeEach(() => {
    document.body.innerHTML = '<div id="view-home"></div>';
    container = document.getElementById('view-home')!;
    home = new HomeView(container, {
      sources: sources(),
      onRevealTabBar: vi.fn(),
      onBack: vi.fn(),
      onPlayChannel: vi.fn(),
      onOpenGuide: vi.fn(),
      onOpenResume: vi.fn(),
      onOpenTitle: vi.fn(),
      onSeeAll: vi.fn(),
    });
    Focus.setBase(() => home.focusScope);
    home.open();
    Focus.flush();
  });

  afterEach(() => Focus.uninstall());

  const tiles = (): HTMLElement[] => Array.from(container.querySelectorAll<HTMLElement>('[data-focusable]'));

  it('moves focus to the tile the pointer hovers', () => {
    const [first, , third] = tiles();
    expect(first.classList.contains('focused')).toBe(true);

    third.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    Focus.flush();

    expect(third.classList.contains('focused')).toBe(true);
    expect(container.querySelectorAll('.focused')).toHaveLength(1);
  });
});

describe('HomeView long press', () => {
  let container: HTMLElement;
  let home: HomeView;
  let recent: HomeChannel[];
  const remove = vi.fn();

  beforeEach(() => {
    recent = [tuned('ch1', 0), tuned('ch2', 1)];
    remove.mockReset().mockImplementation((item: { row: string; channel?: Channel }) => {
      recent = recent.filter(entry => entry.channel !== item.channel);
    });
    document.body.innerHTML = '<div id="view-home"></div>';
    container = document.getElementById('view-home')!;
    home = new HomeView(container, {
      sources: {
        ...sources(),
        recent: () => recent,
        favorites: () => [tuned('ch9', 9)],
        remove,
      } as HomeSources,
      onRevealTabBar: vi.fn(),
      onBack: vi.fn(),
      onPlayChannel: vi.fn(),
      onOpenGuide: vi.fn(),
      onOpenResume: vi.fn(),
      onOpenTitle: vi.fn(),
      onSeeAll: vi.fn(),
    });
    Focus.setBase(() => home.focusScope);
    home.open();
    Focus.flush();
  });

  afterEach(() => Focus.uninstall());

  const focusedKey = () => container.querySelector<HTMLElement>('.focused')?.dataset.key;
  const confirmRemoval = () => {
    Focus.owner()!.handle('left');
    Focus.owner()!.handle('select');
    Focus.flush();
  };

  it('offers removal only on the rows that can drop an item', () => {
    expect(container.querySelector('[data-home-row="recent"] [data-long-press]')).not.toBeNull();
    expect(container.querySelector('[data-home-row="favorites"] [data-long-press]')).toBeNull();
  });

  it('removes a held tile after confirmation and focuses the one beside it', () => {
    const second = container.querySelectorAll<HTMLElement>('[data-home-row="recent"] [data-long-press]')[1].dataset.key;
    home.handleAction('long_select');
    expect(Focus.owner()?.id).toBe('prompt.home.remove');
    confirmRemoval();

    expect(remove).toHaveBeenCalledWith({ row: 'recent', channel: expect.objectContaining({ id: 'ch1' }) });
    expect(focusedKey()).toBe(second);
  });

  it('drops a row the moment it empties and moves focus to the next row', () => {
    home.handleAction('long_select');
    confirmRemoval();
    home.handleAction('long_select');
    confirmRemoval();

    expect(container.querySelector('[data-home-row="recent"]')).toBeNull();
    expect(focusedKey()).toMatch(/^favorites:/);
  });

  it('keeps the tile when the prompt is canceled', () => {
    const first = focusedKey();
    home.handleAction('long_select');
    Focus.owner()!.handle('back');
    Focus.flush();

    expect(remove).not.toHaveBeenCalled();
    expect(focusedKey()).toBe(first);
  });
});

describe('HomeView leaving for the tab bar', () => {
  let container: HTMLElement;
  let home: HomeView;

  beforeEach(() => {
    document.body.innerHTML = '<div id="view-home"></div>';
    container = document.getElementById('view-home')!;
    home = new HomeView(container, {
      sources: { ...sources(), favorites: () => [tuned('ch9', 9)] } as HomeSources,
      onRevealTabBar: vi.fn(),
      onBack: vi.fn(),
      onPlayChannel: vi.fn(),
      onOpenGuide: vi.fn(),
      onOpenResume: vi.fn(),
      onOpenTitle: vi.fn(),
      onSeeAll: vi.fn(),
    });
    Focus.setBase(() => home.focusScope);
    home.open();
    Focus.flush();
  });

  afterEach(() => Focus.uninstall());

  const view = () => container.querySelector<HTMLElement>('.home-view')!;
  const tracks = () => Array.from(container.querySelectorAll<HTMLElement>('.home-rail-track'));
  const scrollAway = () => {
    view().scrollTop = 300;
    tracks().forEach(track => { track.scrollLeft = 200; });
  };

  it('Up scrolls Home back to its top and leaves the rows where they were', () => {
    scrollAway();
    home.handleAction('up');
    expect(view().scrollTop).toBe(0);
    expect(tracks().map(track => track.scrollLeft)).toEqual([200, 200]);
  });

  it('Left scrolls the rows back to their first tiles and leaves Home where it was', () => {
    const focused = container.querySelector<HTMLElement>('.focused');
    scrollAway();
    home.handleAction('left');
    expect(view().scrollTop).toBe(300);
    expect(tracks().map(track => track.scrollLeft)).toEqual([0, 0]);
    expect(container.querySelector('.focused')).toBe(focused);
  });
});
