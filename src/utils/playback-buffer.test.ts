import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bufferedAhead, PlaybackBuffer, type BufferMedia } from './playback-buffer';

let ranges: number[][];
let media: BufferMedia;
let buffer: PlaybackBuffer;
let play: ReturnType<typeof vi.fn>;
let onError: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  ranges = [];
  media = {
    currentTime: 0, duration: Infinity, paused: true, readyState: 2,
    buffered: {
      get length() { return ranges.length; },
      start: index => ranges[index][0], end: index => ranges[index][1],
    },
    pause: vi.fn(() => { media.paused = true; }),
  };
  play = vi.fn(() => { media.paused = false; return Promise.resolve(); });
  onError = vi.fn();
  buffer = new PlaybackBuffer({
    startupSeconds: 6, recoverySeconds: 8, maxWaitMs: 12000,
    pollMs: 250, nativeGraceMs: 3000, onHolding: vi.fn(), onError,
  });
});

afterEach(() => { buffer.stop(); vi.useRealTimers(); });

describe('playback prebuffer', () => {
  it('waits for six seconds of contiguous playable media before starting', () => {
    buffer.start(media, play, false);
    ranges = [[0, 5]];
    vi.advanceTimersByTime(250);
    expect(play).not.toHaveBeenCalled();
    ranges = [[0, 6]];
    vi.advanceTimersByTime(250);
    expect(play).toHaveBeenCalledOnce();
    expect(buffer.holding).toBe(false);
  });

  it('refills eight seconds after a real interruption and does not fight user pause', () => {
    ranges = [[0, 6]];
    buffer.start(media, play, false);
    buffer.confirmPlaying();
    media.currentTime = 6;
    expect(buffer.recover()).toBe(true);
    expect(media.paused).toBe(true);
    ranges = [[0, 13]];
    vi.advanceTimersByTime(250);
    expect(play).toHaveBeenCalledOnce();
    ranges = [[0, 14]];
    vi.advanceTimersByTime(250);
    expect(play).toHaveBeenCalledTimes(2);
    buffer.confirmPlaying();
    media.paused = true;
    expect(buffer.recover()).toBe(false);
  });

  it('does not indefinitely hold native players that stop exposing progress while paused', () => {
    buffer.start(media, play, true);
    vi.advanceTimersByTime(3000);
    expect(play).toHaveBeenCalledOnce();
  });

  it('recognizes gradual native buffer growth instead of treating a slow connection as stopped', () => {
    buffer.start(media, play, true);
    for (let index = 1; index <= 20; index++) {
      ranges = [[0, index * 0.02]];
      vi.advanceTimersByTime(250);
    }
    expect(buffer.holding).toBe(true);
    expect(play).not.toHaveBeenCalled();
  });

  it('bounds waiting even when no media has arrived and leaves further recovery to the watchdog', () => {
    media.readyState = 0;
    buffer.start(media, play, false);
    vi.advanceTimersByTime(12000);
    expect(play).toHaveBeenCalledOnce();
    expect(buffer.recover()).toBe(false);
    buffer.confirmPlaying();
    expect(buffer.recover()).toBe(true);
    vi.advanceTimersByTime(12000);
    expect(buffer.recover()).toBe(false);
  });

  it('cancels automatic resume after a user pause or a channel change', () => {
    buffer.start(media, play, false);
    buffer.cancelWait();
    ranges = [[0, 30]];
    vi.advanceTimersByTime(30000);
    expect(play).not.toHaveBeenCalled();
    buffer.start(media, play, false);
    expect(play).toHaveBeenCalledOnce();
    buffer.stop();
    vi.advanceTimersByTime(30000);
    expect(play).toHaveBeenCalledOnce();
  });

  it('allows Play to bypass waiting and ignores a rejected play from a canceled session', async () => {
    let reject!: (error: Error) => void;
    play.mockReturnValueOnce(new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; }));
    buffer.start(media, play, false);
    buffer.release();
    expect(play).toHaveBeenCalledOnce();
    buffer.stop();
    reject(new Error('old playback'));
    await Promise.resolve();
    expect(onError).not.toHaveBeenCalled();
  });

  it('starts a short remaining clip without waiting for an impossible target', () => {
    media.currentTime = 9;
    media.duration = 10;
    ranges = [[9, 10]];
    buffer.start(media, play, false);
    expect(play).toHaveBeenCalledOnce();
  });

  it('measures nonzero live timestamps but never sums ranges across a media gap', () => {
    ranges = [[60, 66]];
    expect(bufferedAhead(media, true)).toBe(6);
    media.currentTime = 60;
    ranges = [[60, 62], [63, 70]];
    expect(bufferedAhead(media)).toBe(2);
    ranges = [[60, 62], [62.1, 70]];
    expect(bufferedAhead(media)).toBe(10);
  });
});
