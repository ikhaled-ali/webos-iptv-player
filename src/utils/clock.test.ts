import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clockTime, onClockTick } from './clock';
import { setDisplayTz } from './time';

describe('clock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setDisplayTz('device', null);
    vi.setSystemTime(new Date(2026, 0, 5, 20, 36, 40));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the time of day in the Guide format', () => {
    expect(clockTime()).toBe('20:36');
  });

  it('ticks on each minute boundary, not a minute after subscribing', () => {
    const listener = vi.fn();
    const stop = onClockTick(listener);

    vi.advanceTimersByTime(19_000);
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(listener).toHaveBeenLastCalledWith('20:37');
    vi.advanceTimersByTime(60_000);
    expect(listener).toHaveBeenLastCalledWith('20:38');
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
  });

  it('stops ticking once the last listener leaves', () => {
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = onClockTick(first);
    const stopSecond = onClockTick(second);
    stopFirst();

    vi.advanceTimersByTime(20_000);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    stopSecond();
    expect(vi.getTimerCount()).toBe(0);
  });
});
