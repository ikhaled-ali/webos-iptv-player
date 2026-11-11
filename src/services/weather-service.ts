import { fetchWithTimeout } from '../utils/fetch-helper';
import { createLogger } from '../utils/logger';

// webOS gives apps no weather or location API, so the TV's public IP locates
// it (GeoJS) and Open-Meteo supplies the current conditions; neither needs a key.
export const GEO_URL = 'https://get.geojs.io/v1/ip/geo.json';
export const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

const REFRESH_MS = 30 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 10000;
// Countries that report air temperature in Fahrenheit.
const FAHRENHEIT_COUNTRIES = ['US', 'LR', 'MM', 'BS', 'BZ', 'KY', 'PW', 'FM', 'MH'];

export type WeatherCondition =
  | 'clear' | 'partly-cloudy' | 'cloudy' | 'fog'
  | 'drizzle' | 'rain' | 'snow' | 'thunderstorm';

export interface Weather {
  temperature: number;
  unit: 'C' | 'F';
  condition: WeatherCondition;
  isDay: boolean;
}

interface Location {
  latitude: number;
  longitude: number;
  unit: 'C' | 'F';
}

type WeatherListener = (weather: Weather) => void;

const log = createLogger('Weather');

// WMO weather interpretation codes, as Open-Meteo reports them.
export function weatherCondition(code: number): WeatherCondition {
  if (code <= 1) return 'clear';
  if (code === 2) return 'partly-cloudy';
  if (code === 3) return 'cloudy';
  if (code === 45 || code === 48) return 'fog';
  if (code >= 51 && code <= 57) return 'drizzle';
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code >= 95) return 'thunderstorm';
  return 'cloudy';
}

export function unitForCountry(countryCode: string | undefined): 'C' | 'F' {
  return FAHRENHEIT_COUNTRIES.indexOf((countryCode || '').toUpperCase()) >= 0 ? 'F' : 'C';
}

function finite(value: unknown): number | null {
  const n = typeof value === 'string' ? parseFloat(value) : value;
  return typeof n === 'number' && isFinite(n) ? n : null;
}

async function fetchLocation(): Promise<Location> {
  const response = await fetchWithTimeout(GEO_URL, {}, TIMEOUT_MS);
  const body = await response.json() as { latitude?: unknown; longitude?: unknown; country_code?: string };
  const latitude = finite(body.latitude);
  const longitude = finite(body.longitude);
  if (latitude === null || longitude === null) throw new Error('location');
  return { latitude, longitude, unit: unitForCountry(body.country_code) };
}

async function fetchCurrent(location: Location): Promise<Weather> {
  const url = `${FORECAST_URL}?latitude=${location.latitude.toFixed(2)}`
    + `&longitude=${location.longitude.toFixed(2)}`
    + '&current=temperature_2m,weather_code,is_day'
    + (location.unit === 'F' ? '&temperature_unit=fahrenheit' : '');
  const response = await fetchWithTimeout(url, {}, TIMEOUT_MS);
  const body = await response.json() as {
    current?: { temperature_2m?: unknown; weather_code?: unknown; is_day?: unknown };
  };
  const temperature = finite(body.current?.temperature_2m);
  const code = finite(body.current?.weather_code);
  if (temperature === null || code === null) throw new Error('forecast');
  return {
    temperature: Math.round(temperature),
    unit: location.unit,
    condition: weatherCondition(code),
    isDay: body.current?.is_day !== 0,
  };
}

let location: Location | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let listener: WeatherListener | null = null;
let running = false;

// The IP's location is looked up once per session; only the forecast repeats.
export async function fetchWeather(): Promise<Weather> {
  if (!location) {
    try {
      location = await fetchLocation();
    } catch (err) {
      log.warn('Weather location failed', 'event=weather.failed', 'step=location');
      throw err;
    }
  }
  try {
    return await fetchCurrent(location);
  } catch (err) {
    log.warn('Weather forecast failed', 'event=weather.failed', 'step=forecast');
    throw err;
  }
}

async function poll(): Promise<void> {
  timer = null;
  let delay = REFRESH_MS;
  try {
    const weather = await fetchWeather();
    listener?.(weather);
  } catch {
    // The last reading stays on screen; a failed first one shows nothing.
    delay = RETRY_MS;
  }
  if (running) timer = setTimeout(() => { void poll(); }, delay);
}

export function startWeather(onWeather: WeatherListener): void {
  listener = onWeather;
  if (running) return;
  running = true;
  void poll();
}

export function stopWeather(): void {
  running = false;
  listener = null;
  if (timer !== null) clearTimeout(timer);
  timer = null;
}

export function resetWeatherForTests(): void {
  stopWeather();
  location = null;
}
