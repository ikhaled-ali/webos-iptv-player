// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

const clock = vi.hoisted(() => ({ time: '20:36', listeners: [] as Array<(time: string) => void> }));
vi.mock('../utils/clock', () => ({
  clockTime: () => clock.time,
  onClockTick: (listener: (time: string) => void) => {
    clock.listeners.push(listener);
    return () => undefined;
  },
}));

import { resetStatusWeatherForTests, setStatusWeather, StatusClock } from './status-clock';

const tickClock = (time: string) => {
  clock.time = time;
  clock.listeners.forEach(listener => listener(time));
};

describe('StatusClock', () => {
  afterEach(() => {
    resetStatusWeatherForTests();
    document.body.innerHTML = '';
  });

  it('shows the same weather beside the time in every clock', () => {
    const first = new StatusClock(document.body.appendChild(document.createElement('div')));
    const second = new StatusClock(document.body.appendChild(document.createElement('div')));
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    const temps = () => Array.from(document.querySelectorAll('.status-clock-weather-temp'), el => el.textContent);
    expect(temps()).toEqual([]);

    setStatusWeather({ temperature: 21, unit: 'C', condition: 'clear', isDay: true });
    expect(temps()).toEqual(['21°', '21°']);
    expect(document.querySelectorAll('.status-clock-time')[1]?.textContent).toBe('20:36');
  });

  it('keeps its stale time while paused', () => {
    const root = document.body.appendChild(document.createElement('div'));
    const status = new StatusClock(root);
    const time = () => root.querySelector('.status-clock-time')?.textContent;

    status.setActive(false);
    tickClock('20:37');
    expect(time()).toBe('20:36');
    status.setActive(true);
    expect(time()).toBe('20:37');
  });
});
