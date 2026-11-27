import { createLogger } from '../utils/logger';
import { BroadcastService } from './broadcast-service';
import { BroadcastCache } from './broadcast-cache';
import { applyOrder } from './broadcast-order';
import { StorageService } from './storage-service';
import type { BroadcastChannel } from './broadcast-normalize';
import {
  SatelliteScan,
  type SatelliteConfig,
  type ScanEvent,
  type ScanFeed,
  type ScanReportEntry,
} from './satellite-scan';

// One satellite scan for the whole app. It runs in the background on a
// broadcast of its own, so the viewer can use every other section while it
// does; only the tuner's users (the Satellite section, the signal finder,
// the transponder scan) wait for it. The Satellite scan tool shows it.

const log = createLogger('SatelliteScanSession');

// A scan that never reports running within this, once preparing is done,
// did not start; until it reports stopping after running it is never
// treated as finished, since closing its broadcast aborts it.
const START_TIMEOUT_MS = 60000;
// Each step before the scan starts gives up after this.
const STEP_TIMEOUT_MS = 30000;
const FEED_POLL_MS = 1000;
// The TV writes what the scan finds into its list as it goes; reading the
// whole list is heavy, so it is read this often.
const ADDED_POLL_MS = 8000;
// The TV writes its new list a moment after the scan reports done.
const LIST_ATTEMPTS = 4;
const LIST_DELAY_MS = 2500;

export type ScanSessionPhase = 'idle' | 'running' | 'stopping' | 'finishing' | 'done' | 'failed';
export type OrderMode = 'keep' | 'reset';

export interface ScanOptions {
  network: boolean;
  blind: boolean;
  freeOnly: boolean;
  // Not a TV option: radio services are removed once the scan ends.
  skipRadio: boolean;
}

export interface ScanSessionState {
  phase: ScanSessionPhase;
  progress: number;
  feed: ScanFeed | null;
  report: ScanReportEntry[];
  added: BroadcastChannel[] | null;
  error: string;
  stoppedByUser: boolean;
  startedAt: number;
  // Radio is removed at the end, so its counts are not shown.
  skipRadio: boolean;
  // Of `added`, the services the lineup did not have before the scan.
  fresh: string[];
  // Old services the finished scan no longer found, removed from the list.
  removed: number;
}

function idleState(): ScanSessionState {
  return {
    phase: 'idle', progress: 0, feed: null, report: [], added: null, error: '', stoppedByUser: false, startedAt: 0, skipRadio: false, fresh: [], removed: 0,
  };
}

function bounded<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, () => {
      clearTimeout(timer);
      resolve(fallback);
    });
  });
}

// The lineup's services now; with `keepOrder`, its order is recorded too, so
// the Satellite section keeps it even if it was never opened since.
export async function captureLineup(keepOrder: boolean): Promise<Set<string>> {
  const load = await BroadcastService.loadChannels();
  if (!load.ok || load.route === 'sample') {
    log.warn('Channel order not captured', 'event=satellite.scan.order_skipped',
      `reason=${load.ok ? 'sample' : load.reason}`);
    return new Set();
  }
  if (keepOrder) {
    const lineup = applyOrder(load.channels, StorageService.getSatelliteOrder());
    if (lineup.changed) StorageService.setSatelliteOrder(lineup.order);
  }
  BroadcastCache.saveChannels(load.channels);
  return new Set(load.channels.map(channel => channel.serviceKey));
}

class ScanSession {
  state: ScanSessionState = idleState();
  private readonly listeners = new Set<() => void>();
  private run = 0;
  private broadcastId: string | null = null;
  private watch: { cancel(): void } | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private feedTimer: ReturnType<typeof setTimeout> | null = null;
  private addedTimer: ReturnType<typeof setTimeout> | null = null;
  private restore: Record<string, unknown> | null = null;
  private seenRunning = false;
  private before = new Set<string>();
  private skipRadio = false;
  private orderMode: OrderMode = 'keep';
  private satelliteNames = new Map<number, string>();
  private scanned = new Set<string>();
  private trace = { opened: false, accepted: false, events: 0, first: '' };

  // Scanning, or still saving what it found: the tuner is not free.
  get busy(): boolean {
    const phase = this.state.phase;
    return phase === 'running' || phase === 'stopping' || phase === 'finishing';
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(): void {
    this.listeners.forEach(listener => listener());
  }

  private set(patch: Partial<ScanSessionState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  // The caller frees the tuner first (its picture); everything after that
  // happens here, as LG's Channel Tuning app does it.
  async start(configs: SatelliteConfig[], options: ScanOptions, orderMode: OrderMode): Promise<void> {
    if (this.busy) return;
    const run = ++this.run;
    this.seenRunning = false;
    this.skipRadio = options.skipRadio;
    this.orderMode = orderMode;
    this.satelliteNames = new Map(configs.map(config => [config.id, config.satelliteName]));
    this.scanned = new Set(configs.filter(config => config.selected).map(config => config.satelliteName));
    this.trace = { opened: false, accepted: false, events: 0, first: '' };
    this.state = { ...idleState(), phase: 'running', startedAt: Date.now(), skipRadio: options.skipRadio };
    this.emit();
    this.before = await bounded(captureLineup(orderMode === 'keep'), STEP_TIMEOUT_MS, new Set<string>());
    for (const config of configs) {
      config.networkSearch = options.network;
      config.blindSearch = options.blind;
      config.skipScrambled = options.freeOnly;
      await bounded(SatelliteScan.updateConfig(config), STEP_TIMEOUT_MS, false);
    }
    if (run !== this.run || this.state.phase !== 'running') return;
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      if (!this.seenRunning && this.state.phase === 'running') this.finish(true);
    }, START_TIMEOUT_MS);
    const id = await bounded(SatelliteScan.openScanBroadcast(), STEP_TIMEOUT_MS, null);
    this.trace.opened = !!id;
    this.broadcastId = id;
    // Watching before starting: the TV says "running" the moment the scan
    // starts, before startAutoScan even answers.
    if (id) this.watch = SatelliteScan.watchScan(id, event => this.take(event, run));
    const result = id ? await SatelliteScan.startScan(id) : { error: '' };
    this.trace.accepted = 'restore' in result;
    if (run !== this.run) return;
    // Started after the guard gave up: it runs, so it is watched again.
    if ('restore' in result && (this.state.phase as ScanSessionPhase) === 'failed') this.set({ phase: 'running' });
    if (this.state.phase !== 'running') return;
    if (!('restore' in result)) {
      this.state = { ...this.state, error: result.error };
      this.finish(true);
      return;
    }
    this.restore = result.restore;
    this.pollAdded(run);
    if (id && await SatelliteScan.startFeed(id)) this.pollFeed(run);
  }

  async stop(): Promise<void> {
    const id = this.broadcastId;
    if (!id || this.state.phase !== 'running') return;
    this.set({ phase: 'stopping', stoppedByUser: true });
    await SatelliteScan.stopScan(id);
    // A scan that never reported running has nothing to wait for.
    if (!this.seenRunning) this.finish(true);
  }

  // The result was seen; the tool shows its options again.
  dismiss(): void {
    if (this.state.phase === 'done' || this.state.phase === 'failed') this.set(idleState());
  }

  private pollFeed(run: number): void {
    this.feedTimer = setTimeout(() => {
      this.feedTimer = null;
      if (run !== this.run || (this.state.phase !== 'running' && this.state.phase !== 'stopping')) return;
      void SatelliteScan.readFeed().then((feed) => {
        if (run !== this.run) return;
        if (feed.current || feed.completed.length) this.set({ feed });
        this.pollFeed(run);
      });
    }, FEED_POLL_MS);
  }

  private pollAdded(run: number): void {
    this.addedTimer = setTimeout(() => {
      this.addedTimer = null;
      if (run !== this.run || (this.state.phase !== 'running' && this.state.phase !== 'stopping')) return;
      void BroadcastService.loadChannels().then((load) => {
        if (run !== this.run || (this.state.phase !== 'running' && this.state.phase !== 'stopping')) return;
        if (load.ok && load.route !== 'sample') this.set(this.found(load.channels));
        this.pollAdded(run);
      });
    }, ADDED_POLL_MS);
  }

  // What the scan found so far. A scan updates the services the TV already
  // had in place, so they are the channels on each transponder it finished
  // with channels, in the order it finished them, plus any it added anew.
  private found(channels: BroadcastChannel[]): Pick<ScanSessionState, 'added' | 'fresh'> {
    const rank = this.transpondersWithServices();
    const before = this.before;
    const position = (channel: BroadcastChannel) => rank.get(`${channel.satellite}|${String(channel.transponderId)}`);
    const added = channels
      .filter(channel => !(this.skipRadio && channel.kind === 'radio'))
      .filter(channel => position(channel) !== undefined || !before.has(channel.serviceKey))
      .map((channel, index) => ({ channel, index, at: position(channel) ?? rank.size }))
      .sort((a, b) => a.at - b.at || a.index - b.index)
      .map(entry => entry.channel);
    return { added, fresh: added.filter(channel => !before.has(channel.serviceKey)).map(channel => channel.serviceKey) };
  }

  // Each transponder the scan finished with services on it ("satellite|id"),
  // in the order it finished them. The TV reports running totals per
  // satellite, so a transponder found services when its total rose.
  private transpondersWithServices(): Map<string, number> {
    const feed = this.state.feed;
    const done = feed ? feed.completed.slice() : [];
    if (feed && feed.current && feed.current.state === 'COMPLETED') done.push(feed.current);
    const totals = new Map<number, number>();
    const rank = new Map<string, number>();
    done.forEach((status) => {
      const total = status.tv + status.radio;
      const before = totals.get(status.configurationId) ?? 0;
      totals.set(status.configurationId, total);
      const gained = total >= before ? total - before : total;
      const key = `${this.satelliteNames.get(status.configurationId) ?? ''}|${String(status.transponder ? status.transponder.id : 0)}`;
      if (status.transponder && gained > 0 && !rank.has(key)) rank.set(key, rank.size);
    });
    return rank;
  }

  // The TV merges a scan into its list, so services that are gone stay on
  // it. After a scan that ran to its end, a service on a scanned satellite
  // goes when its transponder gave the scan nothing; a satellite where the
  // scan found nothing at all is left alone, as that is a reception fault,
  // not an empty sky.
  private staleServices(channels: BroadcastChannel[]): BroadcastChannel[] {
    const found = this.transpondersWithServices();
    const live = new Set<string>();
    found.forEach((_rank, key) => live.add(key.slice(0, key.lastIndexOf('|'))));
    return channels.filter(channel => this.scanned.has(channel.satellite) && live.has(channel.satellite)
      && !found.has(`${channel.satellite}|${String(channel.transponderId)}`));
  }

  private take(event: ScanEvent, run: number): void {
    this.trace.events++;
    if (!this.trace.first && event.scanning !== undefined) this.trace.first = String(event.scanning);
    if (run !== this.run || (this.state.phase !== 'running' && this.state.phase !== 'stopping')) return;
    if (event.scanning === true || (event.progress !== undefined && event.progress > 0)) this.seenRunning = true;
    const patch: Partial<ScanSessionState> = {};
    if (event.progress !== undefined) patch.progress = event.progress;
    if (event.report) patch.report = event.report;
    this.state = { ...this.state, ...patch };
    if (event.scanning === false && this.seenRunning) this.finish(false);
    else this.emit();
  }

  private finish(neverStarted: boolean): void {
    if (neverStarted) {
      const trace = this.trace;
      log.warn('Scan never ran', 'event=satellite.scan.not_running', `opened=${String(trace.opened)}`,
        `accepted=${String(trace.accepted)}`, `events=${String(trace.events)}`, `first=${trace.first || 'none'}`);
    }
    this.watch?.cancel();
    this.watch = null;
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
    if (this.feedTimer) clearTimeout(this.feedTimer);
    this.feedTimer = null;
    if (this.addedTimer) clearTimeout(this.addedTimer);
    this.addedTimer = null;
    void SatelliteScan.stopFeed();
    if (this.restore) void SatelliteScan.restoreScanTypes(this.restore);
    this.restore = null;
    const id = this.broadcastId;
    this.broadcastId = null;
    if (id) void SatelliteScan.closeBroadcast(id);
    this.set({ phase: neverStarted ? 'failed' : 'finishing' });
    if (!neverStarted) void this.finishList(this.run);
  }

  // After the TV saved its new list: radio removed when asked, the order
  // reset when asked, and the services the scan added listed by name.
  private async finishList(run: number): Promise<void> {
    let load = await BroadcastService.loadChannels();
    for (let attempt = 1; attempt < LIST_ATTEMPTS && !load.ok; attempt++) {
      await new Promise(resolve => setTimeout(resolve, LIST_DELAY_MS));
      load = await BroadcastService.loadChannels();
    }
    if (run !== this.run) return;
    let channels = load.ok ? load.channels : [];
    let removed = 0;
    if (load.ok && !this.state.stoppedByUser) {
      const stale = this.staleServices(channels);
      if (stale.length && await SatelliteScan.deleteChannels(stale.map(channel => channel.id))) {
        const gone = new Set(stale.map(channel => channel.id));
        channels = channels.filter(channel => !gone.has(channel.id));
        removed = stale.length;
        log.info('Old channels removed', 'event=satellite.scan.stale_removed', `count=${String(removed)}`);
      }
    }
    if (this.skipRadio) {
      const radio = channels.filter(channel => channel.kind === 'radio');
      if (radio.length && await SatelliteScan.deleteChannels(radio.map(channel => channel.id))) {
        channels = channels.filter(channel => channel.kind !== 'radio');
      }
    }
    if (this.orderMode === 'reset') StorageService.setSatelliteOrder([]);
    this.set({ phase: 'done', removed, ...(load.ok ? this.found(channels) : {}) });
  }
}

export const SatelliteScanSession = new ScanSession();
