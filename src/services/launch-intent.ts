import { CONFIG } from '../config';
import { createLogger } from '../utils/logger';

const log = createLogger('Launch');

// Keys a launcher may carry a search query under, in priority order.
const QUERY_KEYS = ['query'] as const;

export type LaunchVia = 'launch' | 'relaunch';
export type LaunchRoute = 'reminder' | 'search' | 'none';

export interface LaunchRouteHandlers {
  // True when the params named a reminder channel and it was handled.
  reminder: (raw: unknown) => boolean;
  search: (query: string) => void;
}

// A cold launch hands the params over as a JSON string, a relaunch as an object.
export function launchParamsObject(raw: unknown): Record<string, unknown> | null {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return null;
    try { obj = JSON.parse(raw); } catch { return null; }
  }
  return obj && typeof obj === 'object' && !Array.isArray(obj)
    ? obj as Record<string, unknown>
    : null;
}

export function normalizeLaunchQuery(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > CONFIG.SEARCH.LAUNCH_QUERY_MAX_LENGTH
    ? text.slice(0, CONFIG.SEARCH.LAUNCH_QUERY_MAX_LENGTH).trim()
    : text;
}

export function parseLaunchSearchQuery(raw: unknown): string | null {
  const params = launchParamsObject(raw);
  if (!params) return null;
  for (const key of QUERY_KEYS) {
    const query = normalizeLaunchQuery(params[key]);
    if (query) return query;
  }
  return null;
}

// A reminder's channel wins over a query; params naming neither change nothing.
export function routeLaunchParams(raw: unknown, via: LaunchVia, handlers: LaunchRouteHandlers): LaunchRoute {
  if (handlers.reminder(raw)) return 'reminder';
  const query = parseLaunchSearchQuery(raw);
  if (!query) return 'none';
  log.info('Launch opened search', 'event=launch.search', `via=${via}`, `length=${String(query.length)}`);
  handlers.search(query);
  return 'search';
}
