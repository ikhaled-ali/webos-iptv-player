// Pure normalizers for the TV's broadcast channel and program responses.
// Field names vary by webOS release and by country build, so every field is
// read tolerantly and anything unexpected falls back rather than throws.

export type BroadcastSource = 'satellite' | 'antenna' | 'cable' | 'other';
export type BroadcastKind = 'tv' | 'radio';

export interface BroadcastChannel {
  // The TV's own channelId, which every tune and program call takes. It
  // changes when channels are rescanned.
  id: string;
  // The service's broadcast identity (transport stream, service, network,
  // and TV or radio), which survives a rescan: order and favorites key on it.
  serviceKey: string;
  // The number the TV shows, for sorting and direct entry (0 when none).
  number: number;
  numberLabel: string;
  name: string;
  kind: BroadcastKind;
  source: BroadcastSource;
  // The satellite it was scanned from, as the TV names it ('' when unknown).
  satellite: string;
  // The transponder frequency in MHz (0 when unknown).
  frequency: number;
  // The TV's transponder id (its physicalNumber), 0 when unknown.
  transponderId: number;
  hd: boolean;
  scrambled: boolean;
  locked: boolean;
  logo: string;
}

export interface BroadcastProgram {
  title: string;
  start: number;
  end: number;
  description: string;
}

type Raw = Record<string, unknown>;

function isRaw(value: unknown): value is Raw {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && isFinite(value)) return String(value);
  return '';
}

function flag(raw: Raw, ...names: string[]): boolean {
  for (const name of names) {
    const value = raw[name];
    if (value === true || value === 1 || value === 'true') return true;
  }
  return false;
}

function firstArray(raw: Raw, ...names: string[]): unknown[] {
  for (const name of names) {
    const value = raw[name];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function sourceOf(raw: Raw): BroadcastSource {
  const mode = `${str(raw.channelMode)} ${str(raw.channelModeName)} ${str(raw.channelType)} ${
    str(raw.channelTypeName)}`.toLowerCase();
  if (str(raw.satelliteName) || mode.indexOf('satellite') !== -1) return 'satellite';
  if (mode.indexOf('cable') !== -1) return 'cable';
  if (mode.indexOf('terrestrial') !== -1 || mode.indexOf('antenna') !== -1) return 'antenna';
  return 'other';
}

function kindOf(raw: Raw): BroadcastKind {
  if (flag(raw, 'Radio', 'isRadio', 'radio')) return 'radio';
  const type = `${str(raw.channelType)} ${str(raw.channelTypeName)}`.toLowerCase();
  if (type.indexOf('radio') !== -1) return 'radio';
  if (typeof raw.serviceType === 'string') return raw.serviceType.toLowerCase().indexOf('radio') !== -1 ? 'radio' : 'tv';
  return typeof raw.serviceType === 'number' && RADIO_SERVICE_TYPES.indexOf(raw.serviceType) !== -1 ? 'radio' : 'tv';
}

// DVB service types that carry sound only: digital radio (0x02), FM radio
// (0x07), and advanced codec digital radio (0x0A), which many satellite
// radio services use.
const RADIO_SERVICE_TYPES = [0x02, 0x07, 0x0a];

// LG serves logos as http(s) URLs or as absolute paths on the TV; anything
// else would only resolve against the app.
function logoOf(raw: Raw): string {
  const value = str(raw.imgUrl) || str(raw.imgUrl2) || str(raw.logo);
  if (/^https?:\/\//i.test(value)) return value;
  if (value.charAt(0) === '/') return `file://${value}`;
  return '';
}

function numberOf(raw: Raw): { number: number; label: string } {
  const label = str(raw.channelNumber) || str(raw.displayNumber) || str(raw.majorNumber);
  const parsed = parseInt(label, 10);
  return { number: isFinite(parsed) && parsed > 0 ? parsed : 0, label };
}

export function normalizeChannel(value: unknown): BroadcastChannel | null {
  if (!isRaw(value)) return null;
  const id = str(value.channelId) || str(value.id);
  if (!id) return null;
  // Channels the user deleted in the TV's channel manager stay in the list as
  // invisible; the TV's own list leaves them out too.
  if (flag(value, 'Invisible', 'invisible', 'hidden', 'isInvisible')) return null;
  const { number, label } = numberOf(value);
  const name = str(value.channelName) || str(value.name) || label;
  if (!name) return null;
  const signal = str(value.signalChannelId);
  const kind = kindOf(value);
  return {
    id,
    serviceKey: `${kind}:${signal || id}`,
    number,
    numberLabel: label,
    name,
    kind,
    source: sourceOf(value),
    satellite: str(value.satelliteName),
    frequency: typeof value.Frequency === 'number' && value.Frequency > 0 ? value.Frequency : 0,
    transponderId: typeof value.physicalNumber === 'number' && value.physicalNumber > 0 ? value.physicalNumber : 0,
    hd: flag(value, 'HDTV', 'isHDTV', 'isUHD', 'isHEVCChannel') || /\b(?:u?hd|4k)\b/i.test(name),
    // `descrambled` is set on every service, scrambled or not (webOS 10.3).
    scrambled: flag(value, 'scrambled', 'isScrambled'),
    locked: flag(value, 'locked', 'isLocked'),
    logo: logoOf(value),
  };
}

export function compareChannels(a: BroadcastChannel, b: BroadcastChannel): number {
  // LG numbers TV and radio apart (both have a 1), so TV comes first, as in
  // the TV's own list; unnumbered channels sort last, then by name.
  if (a.kind !== b.kind) return a.kind === 'tv' ? -1 : 1;
  const an = a.number || Number.MAX_SAFE_INTEGER;
  const bn = b.number || Number.MAX_SAFE_INTEGER;
  if (an !== bn) return an - bn;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export function normalizeChannelList(response: unknown): BroadcastChannel[] {
  if (!isRaw(response)) return [];
  const list = firstArray(response, 'channelList', 'channels', 'list', 'channelInfoList');
  const seen = new Set<string>();
  const channels: BroadcastChannel[] = [];
  for (const item of list) {
    const channel = normalizeChannel(item);
    if (!channel || seen.has(channel.id)) continue;
    seen.add(channel.id);
    channels.push(channel);
  }
  return channels.sort(compareChannels);
}

// LG times come as "YYYY,MM,DD,HH,MM,SS" (localStartTime is local, startTime
// UTC), as epoch seconds or milliseconds, or as ISO strings.
export function parseTvTime(value: unknown, utc: boolean): number | null {
  if (typeof value === 'number' && isFinite(value) && value > 0) {
    return value < 1e11 ? value * 1000 : value;
  }
  const text = str(value);
  if (!text) return null;
  const parts = text.split(/[,\s:/-]+/).map(part => parseInt(part, 10));
  if (parts.length >= 5 && parts.every(part => isFinite(part)) && parts[0] > 1970) {
    const [year, month, day, hour, minute, second = 0] = parts;
    return utc
      ? Date.UTC(year, month - 1, day, hour, minute, second)
      : new Date(year, month - 1, day, hour, minute, second).getTime();
  }
  const parsed = Date.parse(text);
  return isFinite(parsed) ? parsed : null;
}

function timeOf(raw: Raw, local: string, utcName: string, plain: string): number | null {
  return parseTvTime(raw[local], false) ?? parseTvTime(raw[utcName], true) ?? parseTvTime(raw[plain], false);
}

export function normalizeProgram(value: unknown): BroadcastProgram | null {
  if (!isRaw(value)) return null;
  const title = str(value.programName) || str(value.title) || str(value.name);
  const start = timeOf(value, 'localStartTime', 'startTime', 'start');
  let end = timeOf(value, 'localEndTime', 'endTime', 'end');
  if (end === null && start !== null && typeof value.duration === 'number' && value.duration > 0) {
    end = start + value.duration * 1000;
  }
  if (!title || start === null || end === null || end <= start) return null;
  return {
    title,
    start,
    end,
    description: str(value.description) || str(value.programDescription) || str(value.shortDescription),
  };
}

export function normalizeProgramList(response: unknown): BroadcastProgram[] {
  if (!isRaw(response)) return [];
  let list = firstArray(response, 'programList', 'programs', 'programInfoList');
  if (!list.length && isRaw(response.program)) list = [response.program];
  if (!list.length && (response.programName || response.title)) list = [response];
  const programs: BroadcastProgram[] = [];
  for (const item of list) {
    const program = normalizeProgram(item);
    if (program) programs.push(program);
  }
  return programs.sort((a, b) => a.start - b.start);
}

export function currentChannelId(response: unknown): string | null {
  if (!isRaw(response)) return null;
  const id = str(response.channelId) || (isRaw(response.channel) ? str(response.channel.channelId) : '');
  return id || null;
}

// A satellite transponder as the TV's satellite setup lists it.
export interface Transponder {
  id: number;
  frequency: number;
  // H, V, L, or R ('' when unknown).
  polarization: string;
  symbolRate: number;
  // DVB-S or DVB-S2 ('' when unknown).
  system: string;
}

const POLARIZATION: Record<string, string> = {
  HORIZONTAL_POLARISATION: 'H',
  VERTICAL_POLARISATION: 'V',
  LEFT_POLARISATION: 'L',
  RIGHT_POLARISATION: 'R',
};

export function normalizeTransponder(value: unknown): Transponder | null {
  if (!isRaw(value) || typeof value.transponderId !== 'number') return null;
  const system = str(value.transmissionSystem).replace('TRANSMISSIONSYSTEM_', '');
  return {
    id: value.transponderId,
    frequency: typeof value.frequency === 'number' ? value.frequency : 0,
    polarization: POLARIZATION[str(value.polarisation)] ?? '',
    symbolRate: typeof value.symbolRate === 'number' ? value.symbolRate : 0,
    system: system === 'DVBS2' ? 'DVB-S2' : system === 'DVBS' ? 'DVB-S' : '',
  };
}

export function normalizeTransponderList(response: unknown): Transponder[] {
  if (!isRaw(response)) return [];
  const list: Transponder[] = [];
  for (const item of firstArray(response, 'transponderInfoList', 'transponderList')) {
    const transponder = normalizeTransponder(item);
    if (transponder) list.push(transponder);
  }
  return list;
}

// "11977 V 27500 DVB-S2", the way receivers write a transponder.
export function transponderLabel(transponder: Transponder): string {
  return [
    transponder.frequency ? String(transponder.frequency) : '',
    transponder.polarization,
    transponder.symbolRate ? String(transponder.symbolRate) : '',
    transponder.system,
  ].filter(Boolean).join(' ');
}
