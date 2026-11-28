// What the TV's signal finder and the phone page agree on: the relay
// brokers, the topics, and the messages. The phone page bundles this
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
const MAX_SATELLITES = 64;
const MAX_TRANSPONDERS = 2000;
const MAX_OPTIONS = 16;
const MAX_ID = 0x7fffffff;
const REQ_PATTERN = /^[0-9a-f]{8,32}$/;

export type FinderLock = 'locked' | 'nolock' | 'searching';

export type ViewerLabelKey =
  | 'title' | 'strength' | 'quality' | 'ber' | 'transponder'
  | 'locked' | 'noLock' | 'searching'
  | 'waiting' | 'stopped' | 'stale' | 'sound' | 'peak' | 'resetPeak'
  | 'satellite' | 'lnb' | 'diseqc' | 'tone' | 'lnbPower' | 'newTransponder' | 'frequency' | 'symbolRate'
  | 'polarization' | 'horizontal' | 'vertical' | 'system' | 'off'
  | 'send' | 'cancel' | 'sending' | 'applied' | 'notApplied' | 'noAnswer';

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
  satellite: 'Satellite',
  lnb: 'LNB frequency',
  diseqc: 'DiSEqC port',
  tone: '22kHz tone',
  lnbPower: 'LNB power',
  newTransponder: 'New transponder',
  frequency: 'Frequency (MHz)',
  symbolRate: 'Symbol rate (kS/s)',
  polarization: 'Polarization',
  horizontal: 'Horizontal',
  vertical: 'Vertical',
  system: 'Transmission',
  off: 'Off',
  send: 'Send to TV',
  cancel: 'Cancel',
  sending: 'Sending…',
  applied: 'The TV is tuning to these settings.',
  notApplied: 'The TV couldn’t use these settings.',
  noAnswer: 'The TV didn’t answer. Try again.',
};

// The finder's number fields, on the TV and the phone alike.
export const FREQUENCY_RANGE = { min: 3000, max: 13000 } as const;
export const SYMBOL_RATE_RANGE = { min: 1000, max: 45000 } as const;

export type SharedPolarization = 'H' | 'V';
export type SharedSystem = 'DVB-S' | 'DVB-S2';

export interface SharedForm {
  frequency: number;
  polarization: SharedPolarization;
  symbolRate: number;
  system: SharedSystem;
}

// A listed transponder, kept short: [id, frequency, polarization, symbol
// rate, system]. A symbol rate of 0 or an empty system is one the TV's
// list leaves out.
export type SharedTransponder = [number, number, SharedPolarization, number, SharedSystem | ''];

export interface SharedOption {
  value: string;
  label: string;
}

export interface SharedLnb {
  label: string;
  // A universal LNB picks its band with the 22kHz tone itself.
  universal: boolean;
}

export interface SharedSatellite {
  id: number;
  name: string;
  // An index into `lnbs`; -1 for an LNB the TV has that is none of them.
  lnb: number;
  lnbLabel: string;
  diseqc: string;
  tone: string;
  lnbPower: boolean;
  // The transponder the satellite tunes: its listed id, or 0 for a new one.
  form: SharedForm;
  tp: number;
  tps: SharedTransponder[];
}

// Retained, so a phone that opens late can edit what the TV shows. `ack`
// answers the phone's last apply.
export interface SettingsMessage {
  v: number;
  satellite: number;
  satellites: SharedSatellite[];
  lnbs: SharedLnb[];
  diseqcs: SharedOption[];
  tones: SharedOption[];
  ack?: { req: string; ok: boolean };
}

// The phone's settings for the TV to tune. `lnb` -1 keeps the TV's LNB.
export interface ApplyMessage {
  v: number;
  req: string;
  satellite: number;
  lnb: number;
  diseqc: string;
  tone: string;
  lnbPower: boolean;
  form: SharedForm;
}

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

export function settingsTopic(id: string): string {
  return `${TOPIC_ROOT}${id}/settings`;
}

export function applyTopic(id: string): string {
  return `${TOPIC_ROOT}${id}/apply`;
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

function int(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && isFinite(value) && Math.floor(value) === value && value >= min && value <= max
    ? value : null;
}

function list(value: unknown, max: number): unknown[] {
  return Array.isArray(value) ? value.slice(0, max) : [];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function polarization(value: unknown): SharedPolarization | null {
  return value === 'H' || value === 'V' ? value : null;
}

function system(value: unknown): SharedSystem | null {
  return value === 'DVB-S' || value === 'DVB-S2' ? value : null;
}

export function parseForm(value: unknown): SharedForm | null {
  const form = record(value);
  const frequency = int(form.frequency, FREQUENCY_RANGE.min, FREQUENCY_RANGE.max);
  const symbolRate = int(form.symbolRate, SYMBOL_RATE_RANGE.min, SYMBOL_RATE_RANGE.max);
  const pol = polarization(form.polarization);
  const sys = system(form.system);
  if (frequency === null || symbolRate === null || !pol || !sys) return null;
  return { frequency, polarization: pol, symbolRate, system: sys };
}

function parseOptions(value: unknown): SharedOption[] {
  const options: SharedOption[] = [];
  for (const item of list(value, MAX_OPTIONS)) {
    const option = record(item);
    const key = text(option.value);
    if (key) options.push({ value: key, label: text(option.label) });
  }
  return options;
}

function parseTransponder(value: unknown): SharedTransponder | null {
  if (!Array.isArray(value)) return null;
  const id = int(value[0], 1, MAX_ID);
  const frequency = int(value[1], FREQUENCY_RANGE.min, FREQUENCY_RANGE.max);
  const pol = polarization(value[2]);
  const symbolRate = value[3] === 0 ? 0 : int(value[3], SYMBOL_RATE_RANGE.min, SYMBOL_RATE_RANGE.max);
  if (id === null || frequency === null || !pol || symbolRate === null) return null;
  return [id, frequency, pol, symbolRate, system(value[4]) ?? ''];
}

function parseSatellite(value: unknown, lnbs: number): SharedSatellite | null {
  const item = record(value);
  const id = int(item.id, 0, MAX_ID);
  const form = parseForm(item.form);
  if (id === null || !form || typeof item.lnbPower !== 'boolean') return null;
  const tps: SharedTransponder[] = [];
  for (const entry of list(item.tps, MAX_TRANSPONDERS)) {
    const tp = parseTransponder(entry);
    if (tp) tps.push(tp);
  }
  const tp = int(item.tp, 0, MAX_ID) ?? 0;
  return {
    id,
    name: text(item.name),
    lnb: int(item.lnb, 0, lnbs - 1) ?? -1,
    lnbLabel: text(item.lnbLabel),
    diseqc: text(item.diseqc),
    tone: text(item.tone),
    lnbPower: item.lnbPower,
    form,
    tp: tps.some(entry => entry[0] === tp) ? tp : 0,
    tps,
  };
}

export function parseSettings(json: string): SettingsMessage | null {
  const value = object(json);
  if (!value || value.v !== FINDER_SHARE_VERSION) return null;
  const lnbs = list(value.lnbs, MAX_OPTIONS).map((item) => {
    const lnb = record(item);
    return { label: text(lnb.label), universal: lnb.universal === true };
  });
  const satellites: SharedSatellite[] = [];
  for (const item of list(value.satellites, MAX_SATELLITES)) {
    const satellite = parseSatellite(item, lnbs.length);
    if (satellite) satellites.push(satellite);
  }
  const current = int(value.satellite, 0, MAX_ID);
  if (current === null || !satellites.some(item => item.id === current)) return null;
  const message: SettingsMessage = {
    v: FINDER_SHARE_VERSION,
    satellite: current,
    satellites,
    lnbs,
    diseqcs: parseOptions(value.diseqcs),
    tones: parseOptions(value.tones),
  };
  const ack = record(value.ack);
  if (typeof ack.req === 'string' && REQ_PATTERN.test(ack.req) && typeof ack.ok === 'boolean') {
    message.ack = { req: ack.req, ok: ack.ok };
  }
  return message;
}

// The TV takes only a well-formed apply; whether it names a satellite and
// options the TV has is the TV's own check.
export function parseApply(json: string): ApplyMessage | null {
  const value = object(json);
  if (!value || value.v !== FINDER_SHARE_VERSION) return null;
  const req = typeof value.req === 'string' && REQ_PATTERN.test(value.req) ? value.req : null;
  const satellite = int(value.satellite, 0, MAX_ID);
  const lnb = int(value.lnb, -1, MAX_OPTIONS - 1);
  const form = parseForm(value.form);
  const diseqc = text(value.diseqc);
  const tone = text(value.tone);
  if (!req || satellite === null || lnb === null || !form || !diseqc || !tone || typeof value.lnbPower !== 'boolean') {
    return null;
  }
  return { v: FINDER_SHARE_VERSION, req, satellite, lnb, diseqc, tone, lnbPower: value.lnbPower, form };
}
