import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FORECAST_URL, GEO_URL, fetchWeather, resetWeatherForTests, startWeather,
  unitForCountry, weatherCondition,
} from './weather-service';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

const GEO = { latitude: '10.5', longitude: '-20.25', country_code: 'l1' };
const FORECAST = { current: { temperature_2m: 12.6, weather_code: 61, is_day: 1 } };

describe('weatherCondition', () => {
  it('maps WMO codes to a condition', () => {
    expect(weatherCondition(0)).toBe('clear');
    expect(weatherCondition(2)).toBe('partly-cloudy');
    expect(weatherCondition(3)).toBe('cloudy');
    expect(weatherCondition(45)).toBe('fog');
    expect(weatherCondition(53)).toBe('drizzle');
    expect(weatherCondition(81)).toBe('rain');
    expect(weatherCondition(75)).toBe('snow');
    expect(weatherCondition(95)).toBe('thunderstorm');
  });
});

describe('unitForCountry', () => {
  it('uses Fahrenheit only where the country does', () => {
    expect(unitForCountry('US')).toBe('F');
    expect(unitForCountry('us')).toBe('F');
    expect(unitForCountry('l1')).toBe('C');
    expect(unitForCountry(undefined)).toBe('C');
  });
});

describe('fetchWeather', () => {
  beforeEach(() => resetWeatherForTests());
  afterEach(() => {
    resetWeatherForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('locates the IP once, then reads the current conditions there', async () => {
    const fetchMock = vi.fn(async (url: string) => (url === GEO_URL ? json(GEO) : json(FORECAST)));
    vi.stubGlobal('fetch', fetchMock);

    expect(await fetchWeather()).toEqual({ temperature: 13, unit: 'C', condition: 'rain', isDay: true });
    await fetchWeather();

    const urls = fetchMock.mock.calls.map(([url]) => url);
    expect(urls.filter((u) => u === GEO_URL)).toHaveLength(1);
    expect(urls[1]).toContain(`${FORECAST_URL}?latitude=10.50&longitude=-20.25`);
    expect(urls[1]).not.toContain('fahrenheit');
  });

  it('asks for Fahrenheit where the country uses it', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      (url === GEO_URL ? json({ ...GEO, country_code: 'US' }) : json(FORECAST)));
    vi.stubGlobal('fetch', fetchMock);

    expect((await fetchWeather()).unit).toBe('F');
    expect(fetchMock.mock.calls[1][0]).toContain('temperature_unit=fahrenheit');
  });

  it('logs the failed step', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      (url === GEO_URL ? json(GEO) : json({ current: {} }))));

    await expect(fetchWeather()).rejects.toThrow();
    expect(warn.mock.calls.some((args) => {
      const line = args.join(' ');
      return line.includes('event=weather.failed') && line.includes('step=forecast');
    })).toBe(true);
  });

  it('retries a failed first reading sooner than the regular refresh', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let fail = true;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (fail) throw new Error('offline');
      return url === GEO_URL ? json(GEO) : json(FORECAST);
    }));
    const onWeather = vi.fn();

    startWeather(onWeather);
    await vi.advanceTimersByTimeAsync(0);
    expect(onWeather).not.toHaveBeenCalled();

    fail = false;
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(onWeather).toHaveBeenCalledWith(expect.objectContaining({ temperature: 13 }));
  });
});
