// What the TV's signal finder and the phone page agree on: the relay
// brokers, the topics, and the two messages. The phone page bundles this
// module too, so it imports nothing app-specific.

export const FINDER_SHARE_VERSION = 1;

// Public MQTT brokers reachable over secure WebSocket, tried in order. The
// QR names the one that answered, so both ends use the same broker.
export const FINDER_BROKERS: readonly string[] = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
];

// The phone page, published to GitHub Pages by .github/workflows/github-pages.yml.
export const FINDER_VIEWER_URL = 'https://ikhaled-ali.github.io/webos-iptv-player/finder/';

const TOPIC_ROOT = 'iplayer/finder/';
const ID_PATTERN = /^[0-9a-f]{32}$/;
const MAX_TEXT = 120;

export type FinderLock = 'locked' | 'nolock' | 'searching';

export type ViewerLabelKey =
  | 'title' | 'strength' | 'quality' | 'ber' | 'transponder'
  | 'locked' | 'noLock' | 'searching'
  | 'waiting' | 'stopped' | 'stale' | 'sound' | 'peak' | 'resetPeak';

export type ViewerLabels = Record<ViewerLabelKey, string>;

// Shown until the TV's own labels arrive, in its language. They match
// the English catalog (finder-share-protocol.test.ts checks it).
export const FALLBACK_LABELS: ViewerLabels = {
  title: 'Signal finder',
  strength: 'Signal strength',
  quality: 'Signal quality',
  ber: 'Bit error rate',
  transponder: 'Transponder',
  locked: 'Locked',
  noLock: 'No lock',
  searching: 'Searching',
  waiting: 'Waiting for the TV…',
  stopped: 'The TV stopped sharing.',
  stale: 'No readings from the TV.',
  sound: 'Sound',
  peak: 'Peak',
  resetPeak: 'Reset',
};

// Retained, so a phone that opens late learns at once whether the TV shares.
export interface StatusMessage {
  v: number;
  on: boolean;
  labels: ViewerLabels;
}

export interface ReadingMessage {
  v: number;
  lock: FinderLock;
  strength: number | null;
  quality: number | null;
  ber: number | null;
  satellite: string;
  transponder: string;
}

export function statusTopic(id: string): string {
  return `${TOPIC_ROOT}${id}/status`;
}

export function readingTopic(id: string): string {
  return `${TOPIC_ROOT}${id}/reading`;
}

export function shareFilter(id: string): string {
  return `${TOPIC_ROOT}${id}/+`;
}

export function isShareId(id: string): boolean {
  return ID_PATTERN.test(id);
}

// The id rides in the fragment, which the browser never sends to the host.
export function viewerUrl(base: string, broker: number, id: string): string {
  return `${base}#b=${String(broker)}&t=${id}`;
}

export function parseViewerHash(hash: string): { broker: number; id: string } | null {
  const params: Record<string, string> = {};
  for (const part of hash.replace(/^#/, '').split('&')) {
    const at = part.indexOf('=');
    if (at > 0) params[part.slice(0, at)] = part.slice(at + 1);
  }
  const broker = /^\d+$/.test(params.b ?? '') ? parseInt(params.b, 10) : -1;
  const id = (params.t ?? '').toLowerCase();
  if (broker < 0 || broker >= FINDER_BROKERS.length || !isShareId(id)) return null;
  return { broker, id };
}

export function signalLevel(value: number | null): 'good' | 'fair' | 'poor' | 'none' {
  if (value === null) return 'none';
  return value >= 60 ? 'good' : value >= 30 ? 'fair' : 'poor';
}

// Anyone who learns a share id can publish to its topics, so the phone
// takes only well-formed messages, with bounded text.
function text(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, MAX_TEXT) : '';
}

function percent(value: unknown): number | null {
  return typeof value === 'number' && isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : null;
}

function object(json: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(json);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function parseStatus(json: string): StatusMessage | null {
  const value = object(json);
  if (!value || value.v !== FINDER_SHARE_VERSION || typeof value.on !== 'boolean') return null;
  const given = value.labels && typeof value.labels === 'object' ? value.labels as Record<string, unknown> : {};
  const labels = { ...FALLBACK_LABELS };
  for (const key of Object.keys(FALLBACK_LABELS) as ViewerLabelKey[]) {
    const label = text(given[key]);
    if (label) labels[key] = label;
  }
  return { v: FINDER_SHARE_VERSION, on: value.on, labels };
}

export function parseReading(json: string): ReadingMessage | null {
  const value = object(json);
  if (!value || value.v !== FINDER_SHARE_VERSION) return null;
  const lock = value.lock === 'locked' || value.lock === 'nolock' || value.lock === 'searching' ? value.lock : null;
  if (!lock) return null;
  const ber = typeof value.ber === 'number' && isFinite(value.ber) && value.ber >= 0 ? value.ber : null;
  return {
    v: FINDER_SHARE_VERSION,
    lock,
    strength: percent(value.strength),
    quality: percent(value.quality),
    ber,
    satellite: text(value.satellite),
    transponder: text(value.transponder),
  };
}
