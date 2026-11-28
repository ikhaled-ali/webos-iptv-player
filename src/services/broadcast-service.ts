import type { Channel } from '../types';
import { createLogger } from '../utils/logger';
import { EpgService } from './epg-service';
import { isLunaAvailable, lunaRequest, type LunaResponse } from './luna';
import { rootLunaBatch, rootLunaCall } from './root-exec';
import { sampleChannels, samplePrograms } from './broadcast-sample';
import { BroadcastCache } from './broadcast-cache';
import { applyOrder } from './broadcast-order';
import { StorageService } from './storage-service';
import {
  currentChannelId,
  normalizeChannelList,
  normalizeProgramList,
  normalizeTransponderList,
  type BroadcastChannel,
  type BroadcastProgram,
  type Transponder,
} from './broadcast-normalize';

export type { BroadcastChannel, BroadcastProgram, Transponder } from './broadcast-normalize';

// Measured on webOS 10.3 (a 2025 OLED); the TV has no
// com.webos.service.tv.channel. The channel list, program info, and Live TV
// come from the API adapter behind LG's second-screen API, whose tv/* methods
// sit in groups apps don't get (secondscreen.all, system.remote), so they run
// as root through Homebrew Channel on behalf of the Live TV app. The picture
// is a `tv://` <video>: its mediaId is the broadcast id, and the app tunes
// that broadcast through utp.broadcast with its own identity.

const log = createLogger('Broadcast');

const API_ADAPTER = 'luna://com.webos.service.apiadapter';
const UTP_BROADCAST = 'luna://com.webos.service.utp.broadcast';
const APP_MANAGER = 'luna://com.webos.applicationManager';
const SATELLITE_SCAN = 'luna://com.webos.service.utp.channel/scan';
const LEGACY_CHANNEL = 'luna://com.webos.service.legacybroadcast.channel';
const SETTINGS = 'luna://com.webos.settingsservice';
const APP_ID = __APP_ID__;
export const LIVE_TV_APP_ID = 'com.webos.app.livetv';

const PROGRAM_METHODS = ['tv/getChannelProgramInfo', 'tv/getChannelCurrentProgramInfo'];
const DIRECT_TIMEOUT_MS = 10000;
const PROGRAM_TTL_MS = 60000;
const TUNE_RETRIES = 3;
const TUNE_RETRY_MS = 500;
// After this many channels without a program answer, the TV has no guide
// for us; stop asking it and use the XMLTV guide alone.
const PROGRAM_GIVE_UP = 3;

export type BroadcastRoute = 'direct' | 'root' | 'sample';
export type SignalState = 'good' | 'bad';

// What the tuner and decoder report for the playing channel; each field is
// null or empty when the TV did not say.
export interface BroadcastStats {
  locked: boolean | null;
  // 0-100, as the TV's own signal screen shows them.
  strength: number | null;
  quality: number | null;
  signal: SignalState | null;
  videoGood: boolean | null;
  width: number;
  height: number;
  fps: number;
  interlaced: boolean;
  hdr: string;
  codec: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function percent(value: unknown): number | null {
  return typeof value === 'number' && isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : null;
}

// "codec h264 mpeg4avc" and the like, as viewers know them.
export function codecLabel(raw: string): string {
  const text = raw.toLowerCase();
  if (/hevc|h\.?265/.test(text)) return 'HEVC';
  if (/h\.?264|avc/.test(text)) return 'H.264';
  if (/mpeg-?2/.test(text)) return 'MPEG-2';
  if (/avs\s*3/.test(text)) return 'AVS3';
  if (/avs/.test(text)) return 'AVS';
  return '';
}

// `unsupported`: no tuner service here (desktop, Simulator);
// `no-root`: the TV refuses the app and Homebrew Channel is unreachable.
export type LoadFailure = 'unsupported' | 'no-root' | 'no-channels' | 'no-satellite' | 'failed';

export type ChannelLoad =
  | { ok: true; route: BroadcastRoute; channels: BroadcastChannel[]; currentId: string | null }
  | { ok: false; reason: LoadFailure };

type Reply =
  | { ok: true; response: Record<string, unknown> }
  | { ok: false; unavailable: boolean; missing: boolean; error: string };

function missingService(text: string): boolean {
  return /unknown (?:service|method)|does not exist|not found|no such/i.test(text);
}

// The bus refusing our identity, as opposed to the service refusing the call.
function refused(text: string): boolean {
  return /not permitted|denied|permission/i.test(text) || missingService(text);
}

function failedReply(response: Record<string, unknown>): string | null {
  if (response.returnValue === false) return typeof response.errorText === 'string' ? response.errorText : 'failed';
  return null;
}

function directCall(uri: string, method: string, params: Record<string, unknown>): Promise<Reply> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (reply: Reply): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(reply);
    };
    const request = lunaRequest<LunaResponse & Record<string, unknown>>(uri, {
      method,
      parameters: params,
      onSuccess: (response) => finish({ ok: true, response }),
      onFailure: (response) => {
        const error = response.errorText ?? 'failed';
        finish({ ok: false, unavailable: false, missing: missingService(error), error });
      },
    });
    if (settled) return;
    timer = setTimeout(() => {
      request.cancel();
      finish({ ok: false, unavailable: false, missing: false, error: 'timeout' });
    }, DIRECT_TIMEOUT_MS);
  });
}

// A satellite channel as the IPTV channel shape the XMLTV guide matches by name.
function guideChannel(channel: BroadcastChannel): Channel {
  return {
    id: channel.id, name: channel.name, logo: '', group: '', url: '', extras: null,
    playlistIds: [], catchup: '', catchupSource: '', catchupDays: 0,
  };
}

class BroadcastServiceImpl {
  private route: BroadcastRoute | null = null;
  // Methods that refused the app's identity; they go straight to root. The
  // TV decides per method (utp.broadcast lets the app read the picture and
  // tune, but not the signal meters).
  private readonly rootOnly = new Set<string>();
  private programMethod: string | null = null;
  private programMisses = 0;
  private readonly programCache = new Map<string, { at: number; programs: BroadcastProgram[] }>();
  // Sample channels deleted in the channel manager, until the app restarts.
  private readonly sampleRemoved = new Set<string>();

  get activeRoute(): BroadcastRoute | null { return this.route; }

  private setRoute(route: BroadcastRoute): void {
    if (this.route === route) return;
    this.route = route;
    log.info('Broadcast route chosen', 'event=satellite.route', `route=${route}`);
  }

  private async call(
    service: string,
    method: string,
    params: Record<string, unknown>,
    spool?: string,
  ): Promise<Reply & { via?: 'direct' | 'root' }> {
    let direct: Reply | null = null;
    const route = `${service}/${method}`;
    if (!this.rootOnly.has(route)) {
      direct = await directCall(service, method, params);
      if (direct.ok) return { ...direct, via: 'direct' };
      if (!refused(direct.error)) return direct;
      this.rootOnly.add(route);
    }
    const root = await rootLunaCall(`${service}/${method}`, params, LIVE_TV_APP_ID, spool);
    if (root.response) {
      const error = failedReply(root.response);
      if (error) return { ok: false, unavailable: false, missing: missingService(error), error };
      return { ok: true, response: root.response, via: 'root' };
    }
    return {
      ok: false,
      unavailable: root.unavailable,
      missing: !!direct && !direct.ok && direct.missing,
      error: root.error,
    };
  }

  // One call through the same route logic, for the satellite tools.
  async request(service: string, method: string, params: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const reply = await this.call(service, method, params);
    return reply.ok ? reply.response : null;
  }

  // One call that also says why it failed, for messages that show the TV's reason.
  async requestDetailed(
    service: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<{ response: Record<string, unknown> | null; error: string }> {
    const reply = await this.call(service, method, params);
    return reply.ok ? { response: reply.response, error: '' } : { response: null, error: reply.error };
  }

  // Several calls with the same parameters, the root ones in a single exec.
  requestMany(service: string, methods: string[], params: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
    return this.callMany(service, methods, params);
  }

  // Explore the section with a synthetic lineup, where no tuner answers.
  useSample(): void {
    this.setRoute('sample');
    this.programCache.clear();
  }

  private sampleList(): BroadcastChannel[] {
    return sampleChannels().filter(channel => !this.sampleRemoved.has(channel.id));
  }

  removeSample(ids: readonly string[]): boolean {
    for (const id of ids) this.sampleRemoved.add(id);
    return true;
  }

  // The lineup as the Satellite section numbers it, from what is already
  // known here (no TV call); empty before the section was ever used.
  knownLineup(): BroadcastChannel[] {
    const list = this.route === 'sample' ? this.sampleList() : BroadcastCache.channels();
    return list && list.length ? applyOrder(list, StorageService.getSatelliteOrder()).channels : [];
  }

  async loadChannels(): Promise<ChannelLoad> {
    if (this.route === 'sample') return { ok: true, route: 'sample', channels: this.sampleList(), currentId: null };
    if (!isLunaAvailable()) return { ok: false, reason: 'unsupported' };
    const reply = await this.call(API_ADAPTER, 'tv/getChannelList', {}, 'channels');
    if (!reply.ok) {
      const reason: LoadFailure = reply.unavailable ? (reply.missing ? 'unsupported' : 'no-root') : 'failed';
      log.warn('Channel list failed', 'event=satellite.load.failed', `reason=${reason}`);
      return { ok: false, reason };
    }
    this.setRoute(reply.via ?? 'root');
    const all = normalizeChannelList(reply.response);
    if (!all.length) return { ok: false, reason: 'no-channels' };
    const channels = all.filter(channel => channel.source === 'satellite');
    if (!channels.length) {
      log.info('No satellite channels', 'event=satellite.load.empty', `others=${String(all.length)}`);
      return { ok: false, reason: 'no-satellite' };
    }
    // Answers only while a broadcast is open, such as Live TV's.
    const current = await this.call(API_ADAPTER, 'tv/getCurrentChannel', {});
    return {
      ok: true,
      route: this.route ?? 'root',
      channels,
      currentId: current.ok ? currentChannelId(current.response) : null,
    };
  }

  // Tunes the broadcast a `tv://` video opened (its mediaId).
  async tune(channel: BroadcastChannel, broadcastId: string): Promise<boolean> {
    if (this.route === 'sample') return true;
    let reply = await this.call(UTP_BROADCAST, 'changeChannel', { broadcastId, channelId: channel.id });
    // The TV refuses a tune to the channel the broadcast is already on (a
    // reopened broadcast resumes the last one), which is as good as done.
    if (!reply.ok && await this.onChannel(broadcastId, channel)) return true;
    // A broadcast that just opened can refuse its first tune for a moment.
    for (let retry = 0; !reply.ok && !reply.unavailable && retry < TUNE_RETRIES; retry++) {
      await new Promise(resolve => setTimeout(resolve, TUNE_RETRY_MS));
      reply = await this.call(UTP_BROADCAST, 'changeChannel', { broadcastId, channelId: channel.id });
    }
    if (!reply.ok) {
      log.warn('Tune failed', 'event=satellite.tune.failed', `reason=${reply.unavailable ? 'no_root' : 'refused'}`);
    }
    return reply.ok;
  }

  private async onChannel(broadcastId: string, channel: BroadcastChannel): Promise<boolean> {
    return await this.currentChannelId(broadcastId) === channel.id;
  }

  // The channel a broadcast is on.
  async currentChannelId(broadcastId: string): Promise<string | null> {
    const current = await this.call(UTP_BROADCAST, 'getCurrentChannel', { broadcastId });
    return current.ok ? currentChannelId(current.response) : null;
  }

  // Several methods with the same parameters: each tried directly until the
  // TV refuses it, the refused ones together as root in a single exec.
  private async callMany(
    service: string,
    methods: string[],
    params: Record<string, unknown>,
  ): Promise<Array<Record<string, unknown>>> {
    const replies: Array<Record<string, unknown>> = methods.map(() => ({}));
    const viaRoot: number[] = [];
    await Promise.all(methods.map(async (method, index) => {
      const route = `${service}/${method}`;
      if (this.rootOnly.has(route)) {
        viaRoot.push(index);
        return;
      }
      const direct = await directCall(service, method, params);
      if (direct.ok) replies[index] = direct.response;
      else if (refused(direct.error)) {
        this.rootOnly.add(route);
        viaRoot.push(index);
      }
    }));
    if (viaRoot.length) {
      const root = await rootLunaBatch(viaRoot.map(index => `${service}/${methods[index]}`), params, LIVE_TV_APP_ID);
      viaRoot.forEach((index, at) => {
        const reply = root.replies[at];
        if (reply && !failedReply(reply)) replies[index] = reply;
      });
    }
    return replies;
  }

  // The picture and whether it is coming: cheap, so it is polled often.
  async pictureStats(broadcastId: string): Promise<Partial<BroadcastStats>> {
    const [info, state] = await this.callMany(UTP_BROADCAST, ['getVideoInfo', 'getChannelState'], { broadcastId });
    const video = record(record(info.videoInfo).video);
    const channel = record(state.channelState);
    const num = (value: unknown) => (typeof value === 'number' && isFinite(value) ? value : 0);
    const stats: Partial<BroadcastStats> = {
      signal: channel.videoSignalState === 'good' ? 'good' : channel.videoSignalState === 'bad' ? 'bad' : null,
    };
    if (record(info.videoInfo).video) {
      stats.width = num(video.width);
      stats.height = num(video.height);
      stats.fps = num(video.frameRate);
      stats.interlaced = video.scanType === 'VIDEO_INTERLACED';
      stats.hdr = typeof video.hdrType === 'string' && video.hdrType !== 'none' ? video.hdrType.toUpperCase() : '';
    }
    return stats;
  }

  // Signal strength and quality, and the codec when asked: the TV keeps
  // these to root on webOS 10, so they are polled less often.
  async receptionStats(broadcastId: string, withCodec: boolean): Promise<Partial<BroadcastStats>> {
    const methods = withCodec ? ['getSignalStatus', 'getVideoStatus'] : ['getSignalStatus'];
    const [signal, status] = await this.callMany(UTP_BROADCAST, methods, { broadcastId });
    const tuner = record(signal.signal);
    const stats: Partial<BroadcastStats> = {};
    if (signal.signal) {
      stats.locked = typeof tuner.locked === 'boolean' ? tuner.locked : null;
      stats.strength = percent(tuner.strength);
      stats.quality = percent(tuner.quality);
    }
    const decoder = record(status ? status.videoInfo : undefined);
    if (typeof decoder.isGoodVideo === 'boolean') stats.videoGood = decoder.isGoodVideo;
    if (typeof decoder.vdecCodec === 'string') stats.codec = codecLabel(decoder.vdecCodec);
    return stats;
  }

  // Every transponder of the scanned satellites, from the TV's satellite
  // setup; the channel list only carries each channel's transponder id.
  async transponders(): Promise<Transponder[] | null> {
    if (this.route === 'sample') return [];
    const [scanned, configs] = await Promise.all([
      this.call(LEGACY_CHANNEL, 'getScannedSatelliteList', {}),
      this.call(SATELLITE_SCAN, 'getDvbSatelliteConfigurationList', {}),
    ]);
    if (!scanned.ok || !configs.ok) return null;
    const lnb = new Map<number, unknown>();
    const configList = configs.response.configurationList;
    for (const config of Array.isArray(configList) ? configList : []) {
      const info = record(record(config).satelliteInfo);
      const scan = record(record(config).scanInfo);
      if (typeof info.satelliteId === 'number' && scan.lnbFrequency) lnb.set(info.satelliteId, scan.lnbFrequency);
    }
    const satellites = scanned.response.scannedSatelliteList;
    const all: Transponder[] = [];
    for (const satellite of Array.isArray(satellites) ? satellites : []) {
      const id = record(satellite).satelliteId;
      if (typeof id !== 'number' || !lnb.has(id)) continue;
      const reply = await this.call(SATELLITE_SCAN, 'getDvbSatelliteTransponderList', {
        satelliteId: id, lnbFrequency: lnb.get(id),
      });
      if (reply.ok) all.push(...normalizeTransponderList(reply.response));
    }
    log.info('Transponders read', 'event=satellite.transponders', `count=${String(all.length)}`);
    return all;
  }

  // The TV's per-app aspect ratio: "original" keeps a 4:3-flagged service
  // pillarboxed, "16x9" fills the screen as Live TV does. Apps may not set
  // it themselves, so it goes as root.
  async appAspect(): Promise<string | null> {
    const reply = await this.call(SETTINGS, 'getSystemSettings', { category: 'aspectRatio', app_id: APP_ID });
    const value = reply.ok ? record(reply.response.settings).arcPerApp : null;
    return typeof value === 'string' ? value : null;
  }

  async setAppAspect(value: string): Promise<boolean> {
    const reply = await this.call(SETTINGS, 'setSystemSettings', {
      category: 'aspectRatio', app_id: APP_ID, settings: { arcPerApp: value },
    });
    if (!reply.ok) log.warn('Aspect change failed', 'event=satellite.aspect.failed', `value=${value}`);
    return reply.ok;
  }

  // The TV's Live TV app on this channel.
  async launchLiveTv(channel: BroadcastChannel): Promise<boolean> {
    const open = await this.call(API_ADAPTER, 'tv/openChannel', { channelId: channel.id });
    if (open.ok) return true;
    const params = { id: LIVE_TV_APP_ID, params: { channelId: channel.id } };
    const launch = await this.call(APP_MANAGER, 'launch', params);
    if (!launch.ok) log.warn('Live TV launch failed', 'event=satellite.livetv.failed');
    return launch.ok;
  }

  cachedPrograms(channel: BroadcastChannel, now = Date.now()): BroadcastProgram[] | null {
    if (this.route === 'sample') return samplePrograms(channel, now);
    const cached = this.programCache.get(channel.id);
    if (!cached || now - cached.at > PROGRAM_TTL_MS) return null;
    return cached.programs.filter(program => program.end > now);
  }

  async programs(channel: BroadcastChannel): Promise<BroadcastProgram[]> {
    const now = Date.now();
    const cached = this.cachedPrograms(channel, now);
    if (cached) return cached;
    let programs: BroadcastProgram[] = [];
    if (this.programMisses < PROGRAM_GIVE_UP || this.programMethod) {
      const methods = this.programMethod
        ? [this.programMethod, ...PROGRAM_METHODS.filter(method => method !== this.programMethod)]
        : PROGRAM_METHODS;
      for (const method of methods) {
        const reply = await this.call(API_ADAPTER, method, { channelId: channel.id });
        if (!reply.ok) continue;
        programs = normalizeProgramList(reply.response).filter(program => program.end > now);
        if (programs.length) {
          this.programMethod = method;
          break;
        }
      }
      if (!programs.length && !this.programMethod) this.programMisses++;
    }
    if (!programs.length) programs = this.guidePrograms(channel, now);
    this.programCache.set(channel.id, { at: now, programs });
    return programs;
  }

  // The loaded XMLTV guide, matched to the channel by name.
  private guidePrograms(channel: BroadcastChannel, now: number): BroadcastProgram[] {
    const id = EpgService.findChannelId(guideChannel(channel));
    if (!id) return [];
    const current = EpgService.getNowPlaying(id);
    const upcoming = EpgService.getUpcoming(id, 5);
    return (current ? [current, ...upcoming] : upcoming)
      .filter(program => program.stop.getTime() > now)
      .map(program => ({
        title: program.title,
        start: program.start.getTime(),
        end: program.stop.getTime(),
        description: program.description,
      }));
  }
}

export const BroadcastService = new BroadcastServiceImpl();
