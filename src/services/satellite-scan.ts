import { createLogger } from '../utils/logger';
import { BroadcastService } from './broadcast-service';
import { lunaRequest, type LunaRequestHandle } from './luna';
import { appDirectory, readAppFile, rootExec, shellQuote } from './root-exec';
import { normalizeTransponderList, type Transponder } from './broadcast-normalize';

// The TV's satellite setup and scanning, as LG's own Channel Tuning app
// drives it (com.webos.service.utp.channel/scan on webOS 10): satellite
// configurations with their LNB and DiSEqC, a manual tune on a broadcast for
// signal finding, saving one transponder's services, and the automatic scan.
// Every call needs a broadcast the app opened (a `tv://` video's mediaId).

const log = createLogger('SatelliteScan');

const SCAN = 'luna://com.webos.service.utp.channel/scan';
const IEPG = 'luna://com.webos.service.iepg';
// The live scan feed: a root subscription writes the latest tuning status
// and each finished transponder to files in the app folder, which the app
// reads, since the TV gives these updates only to a subscriber it allows.
const FEED_DIR = 'broadcast-cache';
const FEED_LATEST = 'scan-live.json';
const FEED_DONE = 'scan-done.log';
const FEED_MARK = 'getDvbSatelliteTuningStatus';
// The bracket keeps pkill -f from matching (and killing) its own shell,
// whose command line holds the pattern too.
const FEED_KILL = "pkill -f 'getDvbSatelliteTuningStatu[s]'";
// iepg/deleteChannel takes ids in batches.
const DELETE_BATCH = 100;
const BROADCAST = 'luna://com.webos.service.utp.broadcast';
// The id LG's app gives a transponder typed in by hand.
const USER_TRANSPONDER_ID = 24575;
// A typed frequency within this of a listed transponder is that transponder.
const SAME_TRANSPONDER_MHZ = 3;
// Listed symbol rates round differently; another transponder differs by far more.
const SAME_SYMBOL_RATE = 50;
// The picture frees the tuner a moment after it stops; until then a scan
// is refused with "No resource".
const START_ATTEMPTS = 8;
const START_RETRY_MS = 1000;
// The scan types the TV takes back; its support* fields are read-only.
const SCAN_TYPE_KEYS = ['terrestrial', 'terrestrialUHD', 'cable', 'satellite'];

function scanTypes(value: Raw): Raw {
  const types: Raw = {};
  for (const key of SCAN_TYPE_KEYS) if (typeof value[key] === 'boolean') types[key] = value[key];
  return types;
}

export type Polarization = 'H' | 'V';
export type TransmissionSystem = 'DVB-S' | 'DVB-S2';

export interface LnbFrequency {
  type: string;
  min: number;
  max: number;
}

// LG's LNB choices, in its order; "9750/10600" is the universal Ku-band LNB.
export const LNB_PRESETS: ReadonlyArray<LnbFrequency & { label: string }> = [
  { type: 'KU_BAND', min: 9750, max: 10600, label: '9750/10600' },
  { type: 'KU_BAND', min: 9750, max: 10750, label: '9750/10750' },
  { type: 'KU_BAND', min: 9750, max: 9750, label: '9750' },
  { type: 'KU_BAND', min: 10600, max: 10600, label: '10600' },
  { type: 'KU_BAND', min: 10750, max: 10750, label: '10750' },
  { type: 'KU_BAND', min: 11300, max: 11300, label: '11300' },
  { type: 'C_BAND', min: 5150, max: 5150, label: '5150' },
];

export const DISEQC_PORTS = ['OFF_DISEQC', 'A_DISEQC', 'B_DISEQC', 'C_DISEQC', 'D_DISEQC'] as const;
export type DiseqcPort = typeof DISEQC_PORTS[number];

// LG's 22kHz tone choices, in its order, as its satellite settings label them.
export const TONES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'OFF_22KHZTONE', label: '' },
  { value: 'A_22KHZTONE', label: '22kHz' },
  { value: 'B_22KHZTONE', label: '0Hz' },
];

// A universal LNB picks its band with the tone itself, so LG's settings
// leave the tone alone for one.
export function toneLocked(config: SatelliteConfig): boolean {
  return config.lnb.min !== config.lnb.max;
}

export interface SatelliteConfig {
  id: number;
  satelliteId: number;
  satelliteName: string;
  lnb: LnbFrequency;
  diseqc: string;
  tone: string;
  lnbPower: boolean;
  selected: boolean;
  networkSearch: boolean;
  blindSearch: boolean;
  skipScrambled: boolean;
  supportsNetworkSearch: boolean;
  supportsBlindSearch: boolean;
  supportsSkipScrambled: boolean;
  // The TV's own records, sent back with only our changes applied.
  scanInfo: Record<string, unknown>;
  scanOption: Record<string, unknown>;
}

export interface TuneRequest {
  frequency: number;
  polarization: Polarization;
  symbolRate: number;
  system: TransmissionSystem;
}

export interface SignalReading {
  locked: boolean;
  strength: number;
  quality: number;
  ber: number | null;
  level: number | null;
}

export interface TuningStatus {
  // LOCK, UNLOCK, COMPLETED, … as the TV says it (without "TUNE_").
  state: string;
  configurationId: number;
  tv: number;
  radio: number;
  transponder: Transponder | null;
}

export interface ScanReportEntry {
  satelliteName: string;
  tv: number;
  radio: number;
  channels: number;
}

// What the scan subscriptions report as they change.
export interface ScanEvent {
  scanning?: boolean;
  progress?: number;
  report?: ScanReportEntry[];
}

function reportOf(status: Raw): ScanReportEntry[] | undefined {
  if (!Array.isArray(status.configurationList)) return undefined;
  return status.configurationList.map(record).map((config) => {
    const counts = Array.isArray(config.serviceTypeInfoList) ? config.serviceTypeInfoList.map(record) : [];
    const count = (type: string) => counts.filter(entry => entry.serviceType === type)
      .reduce((sum, entry) => sum + num(entry.virtualChannelNum), 0);
    return {
      satelliteName: typeof config.satelliteName === 'string' ? config.satelliteName : '',
      tv: count('SERVICETYPE_DIGITAL_TV'),
      radio: count('SERVICETYPE_DIGITAL_RADIO'),
      channels: counts.reduce((sum, entry) => sum + num(entry.virtualChannelNum), 0),
    };
  });
}

// What the live feed says: the transponder being tuned, and every finished
// one with the running totals the TV reported as it finished.
export interface ScanFeed {
  current: TuningStatus | null;
  completed: TuningStatus[];
}

function parseFeedLine(line: string): TuningStatus | null {
  const start = line.indexOf('{');
  if (start < 0) return null;
  try {
    return tuningStatus(JSON.parse(line.slice(start)));
  } catch {
    return null;
  }
}

export interface ScanState {
  scanning: boolean;
  progress: number;
  tv: number;
  radio: number;
  transponder: Transponder | null;
  report: ScanReportEntry[] | null;
}

type Raw = Record<string, unknown>;

function record(value: unknown): Raw {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Raw : {};
}

function num(value: unknown): number {
  return typeof value === 'number' && isFinite(value) ? value : 0;
}

function bool(value: unknown): boolean {
  return value === true;
}

function normalizeConfig(value: unknown): SatelliteConfig | null {
  const raw = record(value);
  const info = record(raw.satelliteInfo);
  const scanInfo = record(raw.scanInfo);
  const scanOption = record(raw.scanOption);
  if (typeof raw.configurationId !== 'number' || typeof info.satelliteId !== 'number') return null;
  const lnb = record(scanInfo.lnbFrequency);
  return {
    id: raw.configurationId,
    satelliteId: info.satelliteId,
    satelliteName: typeof info.satelliteName === 'string' ? info.satelliteName : '',
    lnb: { type: typeof lnb.type === 'string' ? lnb.type : 'KU_BAND', min: num(lnb.min), max: num(lnb.max) },
    diseqc: typeof scanInfo.diseqc === 'string' ? scanInfo.diseqc : 'OFF_DISEQC',
    tone: typeof scanInfo.twentytwoKhzTone === 'string' ? scanInfo.twentytwoKhzTone : 'OFF_22KHZTONE',
    lnbPower: scanInfo.lnbPower !== false,
    selected: bool(scanOption.isSelected),
    networkSearch: bool(scanOption.networkSearch),
    blindSearch: bool(scanOption.blindSearch),
    skipScrambled: bool(scanOption.skipScrambleProgram),
    supportsNetworkSearch: bool(scanOption.supportNetworkSearch),
    supportsBlindSearch: bool(scanOption.supportBlindSearch),
    supportsSkipScrambled: bool(scanOption.supportSkipScrambleProgram),
    scanInfo,
    scanOption,
  };
}

function lnbScanInfo(config: SatelliteConfig): Raw {
  return {
    ...config.scanInfo,
    lnbFrequency: config.lnb,
    diseqc: config.diseqc,
    twentytwoKhzTone: toneLocked(config) ? 'OFF_22KHZTONE' : config.tone,
    lnbPower: config.lnbPower,
  };
}

function transponderRecord(request: TuneRequest, id: number): Raw {
  return {
    transponderId: id,
    frequency: request.frequency,
    polarisation: request.polarization === 'H' ? 'HORIZONTAL_POLARISATION' : 'VERTICAL_POLARISATION',
    symbolRate: request.symbolRate,
    transmissionSystem: request.system === 'DVB-S2' ? 'TRANSMISSIONSYSTEM_DVBS2' : 'TRANSMISSIONSYSTEM_DVBS',
    homeTp: false,
    tkgsPid: 0,
  };
}

// Whether a listed transponder is the one the request describes. The TV
// tunes a listed record by its id with its own symbol rate and system, so a
// record that differs in either is another transponder, however close.
export function sameTransponder(transponder: Transponder, request: TuneRequest): boolean {
  return Math.abs(transponder.frequency - request.frequency) <= SAME_TRANSPONDER_MHZ
    && transponder.polarization === request.polarization
    && (!transponder.symbolRate || Math.abs(transponder.symbolRate - request.symbolRate) <= SAME_SYMBOL_RATE)
    && (!transponder.system || transponder.system === request.system);
}

// A listed transponder the request names, so the TV tunes its own record.
export function matchTransponder(list: readonly Transponder[], request: TuneRequest): Transponder | null {
  let best: Transponder | null = null;
  for (const transponder of list) {
    if (!sameTransponder(transponder, request)) continue;
    const distance = Math.abs(transponder.frequency - request.frequency);
    if (!best || distance < Math.abs(best.frequency - request.frequency)) best = transponder;
  }
  return best;
}

function tuningStatus(value: unknown): TuningStatus | null {
  const info = record(record(value).tuneFullInfo);
  if (!Object.keys(info).length) return null;
  const counts = Array.isArray(info.serviceTypeInfoList) ? info.serviceTypeInfoList.map(record) : [];
  const count = (type: string) => counts
    .filter(entry => entry.serviceType === type)
    .reduce((sum, entry) => sum + num(entry.virtualChannelNum), 0);
  const transponders = normalizeTransponderList({ transponderList: info.transponder ? [info.transponder] : [] });
  return {
    state: typeof info.tuneState === 'string' ? info.tuneState.replace('TUNE_', '') : '',
    configurationId: num(info.configurationId),
    tv: count('SERVICETYPE_DIGITAL_TV'),
    radio: count('SERVICETYPE_DIGITAL_RADIO'),
    transponder: transponders[0] ?? null,
  };
}

export const SatelliteScan = {
  async configurations(): Promise<SatelliteConfig[] | null> {
    const reply = await BroadcastService.request(SCAN, 'getDvbSatelliteConfigurationList', {});
    if (!reply) return null;
    const list = Array.isArray(reply.configurationList) ? reply.configurationList : [];
    return list.map(normalizeConfig).filter((config): config is SatelliteConfig => config !== null)
      .sort((a, b) => a.id - b.id);
  },

  async transponders(config: SatelliteConfig): Promise<Transponder[]> {
    const reply = await BroadcastService.request(SCAN, 'getDvbSatelliteTransponderList', {
      satelliteId: config.satelliteId, lnbFrequency: config.scanInfo.lnbFrequency ?? config.lnb,
    });
    return reply ? normalizeTransponderList(reply).sort((a, b) => a.frequency - b.frequency) : [];
  },

  // Tunes the broadcast to a transponder without saving anything.
  async tune(broadcastId: string, config: SatelliteConfig, request: TuneRequest, known: readonly Transponder[]): Promise<boolean> {
    const match = matchTransponder(known, request);
    const reply = await BroadcastService.request(SCAN, 'setDvbSatelliteManualTuning', {
      broadcastId,
      configurationId: config.id,
      transponder: transponderRecord(request, match ? match.id : USER_TRANSPONDER_ID),
    });
    if (!reply) log.warn('Manual tune refused', 'event=satellite.scan.tune_failed');
    return reply !== null;
  },

  async cancelTune(broadcastId: string): Promise<void> {
    await BroadcastService.request(SCAN, 'cancelDvbSatelliteManualTuning', { broadcastId });
  },

  // The tuner's signal. (getDvbSatelliteTuningStatus only updates for a
  // subscriber, which a root call cannot be, so it is not read here.)
  async signal(broadcastId: string): Promise<SignalReading | null> {
    const [signalReply] = await BroadcastService.requestMany(BROADCAST, ['getSignalStatus'], { broadcastId });
    const tuner = record(signalReply.signal);
    return Object.keys(tuner).length ? {
      locked: tuner.locked === true,
      strength: Math.max(0, Math.min(100, num(tuner.strength))),
      quality: Math.max(0, Math.min(100, num(tuner.quality))),
      ber: typeof tuner.ber === 'number' ? tuner.ber : null,
      level: typeof tuner.signalLevel === 'number' ? tuner.signalLevel : null,
    } : null;
  },

  // A broadcast opened for scanning, as LG's Channel Tuning app opens one;
  // the app must open it itself, since the TV only gives its tuner to the
  // app in front. The scan starts on it as opened: putting a channel on it
  // first turns it into a viewing broadcast, where a scan "starts" and does
  // nothing (measured on webOS 10.3).
  async openScanBroadcast(): Promise<string | null> {
    const palm = (window as unknown as { PalmSystem?: { windowId?: string } }).PalmSystem;
    const reply = await BroadcastService.request(BROADCAST, 'open', {
      options: { appId: __APP_ID__, windowId: palm && palm.windowId ? palm.windowId : '', purpose: 'SCAN' },
    });
    return reply && typeof reply.broadcastId === 'string' ? reply.broadcastId : null;
  },

  async closeBroadcast(broadcastId: string): Promise<void> {
    await BroadcastService.request(BROADCAST, 'close', { broadcastId });
  },

  // Adds the services of one transponder to the TV's list ("TP scan").
  async saveTransponder(
    broadcastId: string,
    config: SatelliteConfig,
    request: TuneRequest,
    known: readonly Transponder[],
  ): Promise<'ok' | 'failed'> {
    const match = matchTransponder(known, request);
    const params = {
      broadcastId,
      configurationId: config.id,
      transponder: transponderRecord(request, match ? match.id : USER_TRANSPONDER_ID),
    };
    await BroadcastService.request(SCAN, 'setDvbSatelliteManualTuning', params);
    const reply = await BroadcastService.request(SCAN, 'saveDvbSatelliteManualTuning', params);
    if (reply) {
      log.info('Transponder saved', 'event=satellite.scan.tp_saved');
      return 'ok';
    }
    log.warn('Transponder save failed', 'event=satellite.scan.tp_failed');
    return 'failed';
  },

  // Writes a configuration's LNB settings back, as LG's satellite settings do.
  async saveLnb(config: SatelliteConfig): Promise<boolean> {
    const reply = await BroadcastService.request(SCAN, 'setDvbSatelliteScanInfo',
      { configurationId: config.id, scanInfo: lnbScanInfo(config) });
    if (reply) config.scanInfo = lnbScanInfo(config);
    else log.warn('LNB settings not saved', 'event=satellite.scan.lnb_failed');
    return reply !== null;
  },

  // Writes a configuration's LNB settings and scan options back.
  async updateConfig(config: SatelliteConfig): Promise<boolean> {
    const scanInfo = lnbScanInfo(config);
    const scanOption = {
      ...config.scanOption,
      isSelected: config.selected,
      networkSearch: config.supportsNetworkSearch && config.networkSearch,
      blindSearch: config.supportsBlindSearch && config.blindSearch,
      skipScrambleProgram: config.supportsSkipScrambled && config.skipScrambled,
    };
    const [info, option] = await Promise.all([
      BroadcastService.request(SCAN, 'setDvbSatelliteScanInfo', { configurationId: config.id, scanInfo }),
      BroadcastService.request(SCAN, 'setDvbSatelliteScanOption', { configurationId: config.id, scanOption }),
    ]);
    const ok = info !== null && option !== null;
    if (!ok) log.warn('Satellite setup not saved', 'event=satellite.scan.config_failed');
    return ok;
  },

  // Starts the automatic scan of the selected configurations, satellite
  // only; on success, the scan types to put back when it ends, else the
  // TV's reason.
  async startScan(broadcastId: string): Promise<{ restore: Raw } | { error: string }> {
    const previous = await BroadcastService.request(SCAN, 'getAutoScanChannelType', {});
    const before = previous ? scanTypes(record(previous.scanChannelType)) : {};
    if (before.satellite !== true || before.terrestrial === true || before.cable === true) {
      await BroadcastService.request(SCAN, 'setAutoScanChannelType', {
        scanChannelType: { ...before, terrestrial: false, terrestrialUHD: false, cable: false, satellite: true },
      });
    }
    let reply = await BroadcastService.requestDetailed(SCAN, 'startAutoScan', { broadcastId });
    for (let attempt = 1; !reply.response && /no resource/i.test(reply.error) && attempt < START_ATTEMPTS; attempt++) {
      await new Promise(resolve => setTimeout(resolve, START_RETRY_MS));
      reply = await BroadcastService.requestDetailed(SCAN, 'startAutoScan', { broadcastId });
    }
    if (!reply.response) {
      // The TV's own words; no ids or URLs reach the log.
      const reason = reply.error.replace(/[0-9a-f-]{20,}/gi, '').replace(/[^A-Za-z ]/g, '').trim().slice(0, 40);
      log.warn('Scan refused', 'event=satellite.scan.start_failed', `reason=${reason.replace(/ /g, '_') || 'none'}`);
      if (Object.keys(before).length) await BroadcastService.request(SCAN, 'setAutoScanChannelType', { scanChannelType: before });
      return { error: reply.error };
    }
    log.info('Scan started', 'event=satellite.scan.started');
    return { restore: before };
  },

  async scanState(broadcastId: string): Promise<ScanState> {
    const [progress, status, tuning] = await Promise.all([
      BroadcastService.request(SCAN, 'getAutoScanProgress', { broadcastId }),
      BroadcastService.request(SCAN, 'getAutoScanStatus', {}),
      BroadcastService.request(SCAN, 'getDvbSatelliteTuningStatus', { broadcastId }),
    ]);
    const tune = tuningStatus(tuning);
    const report = status ? reportOf(status) ?? null : null;
    return {
      scanning: !!status && status.autoScanning === true,
      progress: Math.max(0, Math.min(100, num(progress ? progress.progress : 0))),
      tv: tune ? tune.tv : 0,
      radio: tune ? tune.radio : 0,
      transponder: tune ? tune.transponder : null,
      report,
    };
  },

  // The scan's status and progress as they change. They update only for a
  // subscriber (a one-off query keeps answering "not scanning"), and the app
  // may subscribe itself, as LG's Channel Tuning app does.
  watchScan(broadcastId: string, onEvent: (event: ScanEvent) => void): { cancel(): void } {
    const handles: LunaRequestHandle[] = [
      lunaRequest<Raw & { returnValue?: boolean }>(SCAN, {
        method: 'getAutoScanStatus',
        subscribe: true,
        onSuccess: (reply) => {
          if (typeof reply.autoScanning === 'boolean') {
            onEvent({ scanning: reply.autoScanning, report: reportOf(reply) });
          }
        },
      }),
      lunaRequest<Raw & { returnValue?: boolean }>(SCAN, {
        method: 'getAutoScanProgress',
        parameters: { broadcastId },
        subscribe: true,
        onSuccess: (reply) => {
          if (typeof reply.progress === 'number') onEvent({ progress: Math.max(0, Math.min(100, reply.progress)) });
        },
      }),
    ];
    return { cancel: () => handles.forEach(handle => handle.cancel()) };
  },

  // Starts the live feed for a scan on `broadcastId`; false without root.
  async startFeed(broadcastId: string): Promise<boolean> {
    const dir = appDirectory();
    if (!dir) return false;
    const folder = `${dir}/${FEED_DIR}`;
    const latest = `${folder}/${FEED_LATEST}`;
    const done = `${folder}/${FEED_DONE}`;
    const subscribe = `luna-send -i -a com.webos.app.livetv ${shellQuote(`${SCAN}/${FEED_MARK}`)} ${
      shellQuote(JSON.stringify({ broadcastId, subscribe: true }))}`;
    const loop = `script -q -c ${shellQuote(subscribe)} /dev/null | while IFS= read -r l; do `
      + `printf '%s\n' "$l" > ${shellQuote(latest)}; `
      + `case "$l" in *TUNE_COMPLETED*) printf '%s\n' "$l" >> ${shellQuote(done)};; esac; done`;
    // A feed left from an earlier scan goes first, in its own call: this
    // command names the subscription, so a pkill in it would match itself.
    await rootExec(FEED_KILL);
    const result = await rootExec(`mkdir -p ${shellQuote(folder)}; rm -f ${shellQuote(latest)} ${
      shellQuote(done)}; nohup sh -c ${shellQuote(loop)} > /dev/null 2>&1 & echo feed`);
    if (!result.ok) log.warn('Scan feed not started', 'event=satellite.scan.feed_failed');
    return result.ok;
  },

  async readFeed(): Promise<ScanFeed> {
    const [latest, done] = await Promise.all([
      readAppFile(`${FEED_DIR}/${FEED_LATEST}`),
      readAppFile(`${FEED_DIR}/${FEED_DONE}`),
    ]);
    const completed: TuningStatus[] = [];
    for (const line of (done ?? '').split('\n')) {
      const status = parseFeedLine(line);
      if (status) completed.push(status);
    }
    return { current: latest ? parseFeedLine(latest) : null, completed };
  },

  async stopFeed(): Promise<void> {
    await rootExec(FEED_KILL);
  },

  // Removes channels from the TV's list, as LG's channel editor deletes them.
  async deleteChannels(ids: readonly string[]): Promise<boolean> {
    let ok = true;
    for (let i = 0; i < ids.length; i += DELETE_BATCH) {
      const reply = await BroadcastService.request(IEPG, 'deleteChannel', { channelId: ids.slice(i, i + DELETE_BATCH) });
      ok = ok && reply !== null;
    }
    if (!ok) log.warn('Channels not deleted', 'event=satellite.scan.delete_failed');
    return ok;
  },

  async stopScan(broadcastId: string): Promise<void> {
    await BroadcastService.request(SCAN, 'stopAutoScan', { broadcastId });
  },

  async restoreScanTypes(previous: Raw): Promise<void> {
    const types = scanTypes(previous);
    if (Object.keys(types).length) {
      await BroadcastService.request(SCAN, 'setAutoScanChannelType', { scanChannelType: types });
    }
  },
};
