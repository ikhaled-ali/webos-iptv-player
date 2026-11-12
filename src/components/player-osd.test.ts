// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../config';
import { StorageService } from '../services/storage-service';
import type { Channel, Programme } from '../types';
import type { DvrState } from '../utils/dvr';
import { PlayerOsd, type PlayerOsdOptions, type PlayerOsdSnapshot } from './player-osd';

const clock = vi.hoisted(() => ({
  time: '20:36',
  listeners: [] as Array<(time: string) => void>,
}));
vi.mock('../utils/clock', () => ({
  clockTime: () => clock.time,
  onClockTick: (listener: (time: string) => void) => {
    clock.listeners.push(listener);
    return () => {};
  },
}));

// A minute turning: every clock subscribed so far hears it.
function tickClock(time: string): void {
  clock.time = time;
  clock.listeners.forEach(listener => listener(time));
}

const CHANNEL: Channel = {
  id: 'ch1',
  name: 'Alpha',
  logo: 'http://host/logo',
  group: 'Group 1',
  url: 'http://host/a',
  extras: null,
  playlistIds: [],
  catchup: '',
  catchupSource: '',
  catchupDays: 0,
};

const PROGRAMME: Programme = {
  start: new Date('2026-01-01T10:00:00Z'),
  stop: new Date('2026-01-01T11:00:00Z'),
  title: 'Programme 1',
  description: 'Description 1',
  category: 'Category 1',
  icon: 'http://host/icon',
};

function playback(duration: number, position = 0, paused = false) {
  return { duration, position, paused };
}

function snapshot(overrides: Partial<PlayerOsdSnapshot> = {}): PlayerOsdSnapshot {
  return {
    playback: null,
    channel: CHANNEL,
    channelNumber: 1,
    catchup: null,
    vodTitle: null,
    vodHasNext: false,
    vodInIntro: false,
    vodHasInfo: false,
    vodHasEpisodes: false,
    upNextSeconds: 0,
    dvr: null,
    nowPlaying: null,
    streamInfo: null,
    ...overrides,
  };
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    right: left + width,
    top,
    bottom: top + height,
    width,
    height,
  } as DOMRect;
}

describe('PlayerOsd', () => {
  let container: HTMLElement;
  let state: PlayerOsdSnapshot;
  let callbacks: PlayerOsdOptions;
  let osd: PlayerOsd;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    container = document.createElement('div');
    container.innerHTML = '<div id="player-osd"></div><time class="osd-clock hidden"></time>';
    document.body.appendChild(container);
    state = snapshot();
    callbacks = {
      getSnapshot: () => state,
      canAutoReveal: () => true,
      isCovered: () => false,
      canSeek: () => true,
      onSeekFraction: vi.fn(),
      onPauseToggle: vi.fn(),
      onGoLive: vi.fn(),
      onPlayNext: vi.fn(),
      onCancelNext: vi.fn(),
      onSeekStep: vi.fn(),
      onNextEpisode: vi.fn(),
      onSkipIntro: vi.fn(),
      onShowInfo: vi.fn(),
      onShowEpisodes: vi.fn(),
      onOpenMenu: vi.fn(),
      onSurfaceClick: vi.fn(),
    };
    osd = new PlayerOsd(container, callbacks);
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('shows, hides, auto-reveals, and stays visible while paused', () => {
    state = snapshot({ playback: playback(120), vodTitle: 'Video 1' });

    osd.show();
    expect(osd.isVisible()).toBe(true);
    expect(container.querySelector('#player-osd')?.classList.contains('hidden')).toBe(false);
    vi.advanceTimersByTime(CONFIG.PLAYER.DEFAULT_PLAYER_OSD_TIMEOUT_MS);
    expect(osd.isVisible()).toBe(false);

    container.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true,
      clientX: 12,
      clientY: 34,
    }));
    expect(osd.isVisible()).toBe(true);
    expect(osd.pointerPosition()).toEqual({ x: 12, y: 34 });

    state = { ...state, playback: playback(120, 0, true) };
    osd.resetTimer();
    vi.advanceTimersByTime(CONFIG.PLAYER.DEFAULT_PLAYER_OSD_TIMEOUT_MS);
    expect(osd.isVisible()).toBe(true);

    osd.clearPointer();
    osd.hide();
    expect(osd.pointerPosition()).toEqual({ x: null, y: null });
    expect(container.querySelector('#player-osd')?.classList.contains('hidden')).toBe(true);
  });

  it('keeps the time current only while the OSD is up', () => {
    clock.time = '20:36';
    const clockEl = container.querySelector('.osd-clock') as HTMLElement;
    expect(clockEl.classList.contains('hidden')).toBe(true);

    osd.show();
    expect(clockEl.textContent).toBe('20:36');
    expect(clockEl.closest('#player-osd')).toBeNull();
    tickClock('20:37');
    expect(clockEl.textContent).toBe('20:37');

    osd.hide();
    tickClock('20:38');
    expect(clockEl.classList.contains('hidden')).toBe(true);
    expect(clockEl.textContent).toBe('20:37');
    osd.show();
    expect(clockEl.textContent).toBe('20:38');
  });

  it('uses the configured auto-hide timeout', () => {
    StorageService.setPlayerOsdTimeoutMs(3000);
    osd.show();
    vi.advanceTimersByTime(2999);
    expect(osd.isVisible()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(osd.isVisible()).toBe(false);
  });

  it('renders representative Live, catch-up, VOD, and up-next layouts', () => {
    state = snapshot({
      playback: playback(120, 30),
      nowPlaying: PROGRAMME,
      streamInfo: {
        resolution: { tier: 'hd', label: 'Info 1' },
        hdr: 'HDR',
        drm: 'PlayReady',
        fps: '30',
        videoCodec: 'Codec 1',
        audioCodec: 'Codec 2',
        audio: 'Track 1',
        subtitle: 'Track 2',
      },
    });
    osd.show();
    expect(container.textContent).toContain('Alpha');
    expect(container.textContent).toContain('Programme 1');
    expect(container.textContent).toContain('Info 1');
    expect(container.textContent).toContain('HDR');
    expect(container.textContent).toContain('PlayReady');
    expect(container.textContent).toContain('30fps');
    expect(container.textContent).toContain('Codec 1');
    expect(container.textContent).toContain('Audio Track: Track 1');
    expect(container.querySelector('[data-menu]')).toBeNull(); // Blue opens it on live

    state = snapshot({
      playback: playback(120, 30),
      catchup: {
        start: 1_000_000,
        end: 1_000_120,
        title: 'Programme 3',
        description: 'Description 3',
        icon: '',
      },
    });
    osd.render();
    expect(container.textContent).toContain('Programme 3');
    expect(container.querySelector('[data-seekbar]')).not.toBeNull();
    expect(container.querySelector('[data-menu]')).toBeNull();

    state = snapshot({ playback: playback(120, 30), channel: null, vodTitle: 'Video 1' });
    osd.render();
    expect(container.querySelector('.osd-channel-name')?.textContent).toContain('Video 1');
    expect(container.querySelector<HTMLElement>('.osd-progress-bar')?.style.width).toBe('25%');
    expect(container.querySelector('[data-menu]')).not.toBeNull();

    state = { ...state, vodTitle: 'Video 2', upNextSeconds: 5 };
    osd.render();
    expect(container.textContent).toContain('Video 2');
    expect(container.querySelector('[data-next-play]')).not.toBeNull();
    expect(container.querySelector('[data-next-cancel]')).not.toBeNull();
  });

  it('does not repeat an audio-track prefix already present in the name', () => {
    state = snapshot({
      streamInfo: {
        resolution: null,
        hdr: '',
        drm: '',
        fps: '',
        videoCodec: '',
        audioCodec: '',
        audio: 'Audio Track 1',
        subtitle: '',
      },
    });

    osd.show();

    expect(container.textContent).toContain('Audio Track 1');
    expect(container.textContent).not.toContain('Audio Track: Audio Track 1');
  });

  it('refreshes progress and switches an open Live OSD to the DVR layout', () => {
    state = snapshot({ playback: playback(Infinity, 30), nowPlaying: PROGRAMME });
    osd.show();
    expect(container.querySelector('[data-golive]')).toBeNull();

    const dvr: DvrState = {
      start: 0,
      end: 60,
      length: 60,
      position: 30,
      fraction: 0.5,
      behindLive: 30,
      atLiveEdge: false,
    };
    state = { ...state, dvr };
    osd.refreshProgress();
    expect(container.querySelector('[data-golive]')).not.toBeNull();
    expect(container.querySelector<HTMLElement>('.osd-progress-bar')?.style.width).toBe('50%');

    state = { ...state, dvr: { ...dvr, fraction: 0.75, behindLive: 15 } };
    osd.refreshProgress();
    expect(container.querySelector<HTMLElement>('.osd-progress-bar')?.style.width).toBe('75%');
    expect(container.querySelector('.osd-dvr-behind')?.textContent).toBe('-0:15');
  });

  it('routes pointer seeks and control clicks through callbacks', () => {
    state = snapshot({
      playback: playback(120, 30),
      catchup: {
        start: 1_000_000,
        end: 1_000_120,
        title: 'Programme 1',
        description: '',
        icon: '',
      },
    });
    osd.show();

    const seekbar = container.querySelector('[data-seekbar]') as HTMLElement;
    seekbar.getBoundingClientRect = () => rect(100, 50, 400, 20);
    container.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      clientX: 400,
      clientY: 60,
    }));
    expect(callbacks.onSeekFraction).toHaveBeenCalledWith(0.75);

    const pause = container.querySelector('[data-playpause]') as HTMLElement;
    pause.getBoundingClientRect = () => rect(10, 10, 30, 30);
    container.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      clientX: 20,
      clientY: 20,
    }));
    expect(callbacks.onPauseToggle).toHaveBeenCalledOnce();

    state = snapshot({
      playback: playback(120, 30),
      channel: null,
      vodTitle: 'Video 2',
      upNextSeconds: 5,
    });
    osd.render();
    const playNext = container.querySelector('[data-next-play]') as HTMLElement;
    playNext.getBoundingClientRect = () => rect(50, 100, 80, 30);
    container.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      clientX: 60,
      clientY: 110,
    }));
    expect(callbacks.onPlayNext).toHaveBeenCalledOnce();
  });

  it('draws movie controls on the video, and the live panel again for a channel', () => {
    state = snapshot({ playback: playback(120, 30), channel: null, vodTitle: 'Video 1' });
    osd.show();
    const root = container.querySelector('#player-osd')!;
    expect(root.classList.contains('osd-vod')).toBe(true);
    expect(root.querySelector('[data-rewind]')?.getAttribute('aria-label')).toBe('Rewind');
    expect(root.querySelector('[data-playpause]')?.getAttribute('aria-label')).toBe('Pause');
    expect(root.querySelector('[data-forward]')?.getAttribute('aria-label')).toBe('Fast forward');
    expect(root.querySelector('[data-forward] text')?.textContent).toBe(String(CONFIG.PLAYER.SEEK_STEP));
    expect(root.querySelector('.osd-vod-time')?.textContent).toBe('0:30 / 2:00');
    expect(root.querySelector('[data-next-episode]')).toBeNull();

    state = { ...state, vodHasNext: true };
    osd.render();
    expect(root.querySelector('[data-next-episode]')?.getAttribute('aria-label')).toBe('Next episode');

    state = snapshot();
    osd.render();
    expect(root.classList.contains('osd-vod')).toBe(false);
  });

  it('lets the pointer pick rewind, fast forward and Next episode', () => {
    state = snapshot({ playback: playback(120, 30), channel: null, vodTitle: 'Video 1', vodHasNext: true });
    osd.show();
    const click = (selector: string, left: number) => {
      const el = container.querySelector(selector) as HTMLElement;
      el.getBoundingClientRect = () => rect(left, 100, 60, 60);
      container.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: left + 10, clientY: 110 }));
    };
    click('[data-rewind]', 0);
    click('[data-forward]', 200);
    click('[data-next-episode]', 400);
    expect(callbacks.onSeekStep).toHaveBeenNthCalledWith(1, -1);
    expect(callbacks.onSeekStep).toHaveBeenNthCalledWith(2, 1);
    expect(callbacks.onNextEpisode).toHaveBeenCalledOnce();
  });

  it('offers Skip intro only inside the intro, by pointer and by key', () => {
    state = snapshot({ playback: playback(120, 30), channel: null, vodTitle: 'Video 1' });
    osd.show();
    expect(container.querySelector('[data-skip-intro]')).toBeNull();

    state = { ...state, vodInIntro: true };
    osd.refreshProgress();
    const button = container.querySelector('[data-skip-intro]') as HTMLElement;
    expect(button).not.toBeNull();
    button.getBoundingClientRect = () => rect(400, 100, 160, 60);
    container.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 410, clientY: 110 }));
    expect(callbacks.onSkipIntro).toHaveBeenCalledOnce();

    expect(osd.focusControl('skipintro')).toBe(true);
    osd.handleKey('select');
    expect(callbacks.onSkipIntro).toHaveBeenCalledTimes(2);

    state = { ...state, vodInIntro: false };
    osd.refreshProgress();
    expect(container.querySelector('[data-skip-intro]')).toBeNull();
    expect(osd.focusedControl()).toBeNull();
  });

  it('shows the clock outside the OSD panel, with the OSD', () => {
    const clockEl = container.querySelector('.osd-clock') as HTMLElement;
    expect(clockEl.parentElement).toBe(container);
    for (const vodTitle of ['Video 1', null]) {
      state = snapshot({ playback: playback(120, 30), vodTitle });
      osd.show();
      expect(clockEl.classList.contains('hidden')).toBe(false);
      expect(clockEl.textContent).toBe('20:36');
      osd.hide();
      expect(clockEl.classList.contains('hidden')).toBe(true);
    }
  });

  it('lights a control a remote key drove, then lets it go', () => {
    state = snapshot({ playback: playback(120, 30), channel: null, vodTitle: 'Video 1' });
    osd.show();
    osd.flash('rewind');
    expect(container.querySelector('[data-rewind]')?.classList.contains('is-pressed')).toBe(true);
    vi.advanceTimersByTime(300);
    expect(container.querySelector('[data-rewind]')?.classList.contains('is-pressed')).toBe(false);
  });

  it('reuses keyed programme icons and removes failed URLs until cleared', () => {
    state = snapshot({
      catchup: {
        start: 1_000_000,
        end: 1_000_120,
        title: 'Programme 1',
        description: '',
        icon: 'http://host/icon',
      },
    });
    osd.show();
    const first = container.querySelector('.osd-programme-icon');
    expect(first).not.toBeNull();

    osd.render();
    expect(container.querySelector('.osd-programme-icon')).toBe(first);

    first?.dispatchEvent(new Event('error'));
    expect(container.querySelector('.osd-programme-icon')).toBeNull();
    osd.render();
    expect(container.querySelector('.osd-programme-icon')).toBeNull();

    osd.clearFailedIcons();
    osd.render();
    expect(container.querySelector('.osd-programme-icon')).not.toBeNull();
  });
});
