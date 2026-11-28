import type { Action } from '../types';
import { SpatialNav } from '../navigation/spatial-nav';
import { Focus, type FocusScope } from '../navigation/focus-scope';
import { KeyHandler } from '../navigation/key-handler';
import { html, raw, type Safe } from '../utils/dom';
import { morph } from '../utils/morph';
import { t, tp, type TextMessageKey } from '../i18n';
import { transponderLabel, type BroadcastChannel, type Transponder } from '../services/broadcast-normalize';
import {
  DISEQC_PORTS,
  LNB_PRESETS,
  SatelliteScan,
  sameTransponder,
  selectedTpRecord,
  TONES,
  toneLocked,
  type SatelliteConfig,
  type SatelliteSetting,
  type SignalReading,
  type TuneRequest,
} from '../services/satellite-scan';
import { BroadcastService } from '../services/broadcast-service';
import { BroadcastCache } from '../services/broadcast-cache';
import {
  captureLineup,
  SatelliteScanSession,
  scanCounts,
  type OrderMode,
  type ScanOptions,
} from '../services/satellite-scan-session';
import { FinderShare, type FinderReading, type FinderSettings } from '../services/finder-share';
import {
  FREQUENCY_RANGE,
  signalLevel,
  SYMBOL_RATE_RANGE,
  type ApplyMessage,
  type SharedSatellite,
  type ViewerLabels,
} from '../services/finder-share-protocol';
import { InputMode } from '../navigation/input-mode';
import { qrDataUrl } from '../utils/qr';
import { BroadcastVideo } from './broadcast-video';
import { ConfirmationPrompt } from './confirmation-prompt';
import { toggleGroup, sourceToggle } from './toggle-controls';
import { dropdown } from './dropdown';
import { CONFIG } from '../config';
import { CHANNEL_MANAGER_ICON, CHECK_ICON, chevronLeftIcon, chevronRightIcon, SATELLITE_SCAN_ICON, SIGNAL_FINDER_ICON } from './icons';
import { SatelliteChannelManager } from './satellite-channel-manager';
import { showToast } from './toast';
import { createLogger } from '../utils/logger';

const log = createLogger('SatelliteTools');

// A field typed with the remote's digits commits once typing pauses.
const DIGIT_COMMIT_MS = 1500;
// A changed form retunes once the edits settle.
const RETUNE_DELAY_MS = 450;
// Readings refresh about as fast as a receiver's signal finder.
const READING_MS = 800;
// The picture follows once the tuner has locked.
const PICTURE_DELAY_MS = 2000;
// The phone's copy of the settings follows the TV's once edits settle.
const SHARE_SETTINGS_MS = 300;
// A saved transponder shows up in the TV's list within a few seconds.
const TP_COUNT_ATTEMPTS = 4;
const TP_COUNT_DELAY_MS = 2500;
export type SatelliteTool = 'finder' | 'scan' | 'manager';

export const SATELLITE_TOOLS: ReadonlyArray<{ id: SatelliteTool; label: TextMessageKey; hint: TextMessageKey; icon: string }> = [
  { id: 'finder', label: 'satelliteTools.signalFinder', hint: 'satelliteTools.signalFinderHint', icon: SIGNAL_FINDER_ICON },
  { id: 'scan', label: 'satelliteTools.channelScan', hint: 'satelliteTools.channelScanHint', icon: SATELLITE_SCAN_ICON },
  { id: 'manager', label: 'satelliteTools.channelManager', hint: 'satelliteTools.channelManagerHint', icon: CHANNEL_MANAGER_ICON },
];

type NumberField = 'frequency' | 'symbolRate';

const NUMBER_FIELDS: Record<NumberField, { min: number; max: number; step: number; digits: number }> = {
  frequency: { ...FREQUENCY_RANGE, step: 1, digits: 5 },
  symbolRate: { ...SYMBOL_RATE_RANGE, step: 1, digits: 5 },
};

// A scroller moves this far per Up or Down.
const SCROLL_STEP_PX = 132;
// A block scrolled in from below (the QR, the scan's list) stays clear of
// the screen's bottom edge, which overscan may crop.
export const SHARE_GUTTER_PX = 40;

// How far to scroll so a block shows whole with a gutter below it, without
// pushing its top out of view; 0 when it already shows.
export function revealDelta(view: { top: number; bottom: number }, box: { top: number; bottom: number }, gutter: number): number {
  return Math.max(0, Math.min(box.bottom + gutter - view.bottom, box.top - view.top));
}

// One Up or Down on the scan's button above its list of channels. Down
// first scrolls the page in one go until the whole list shows, keeping the
// button in view, then scrolls the list; Up scrolls the list back. Both
// zero: the list is at its end, and focus moves on.
export function logScrollStep(
  action: 'up' | 'down',
  page: { top: number; bottom: number },
  block: { top: number; bottom: number },
  button: { top: number },
  listTop: number,
  listMax: number,
): { page: number; list: number } {
  if (action === 'up') return { page: 0, list: listTop > 0 ? -Math.min(SCROLL_STEP_PX, listTop) : 0 };
  const reveal = revealDelta(page, { top: Math.min(button.top, block.top), bottom: block.bottom }, SHARE_GUTTER_PX);
  if (reveal > 0) return { page: reveal, list: 0 };
  return { page: 0, list: Math.min(SCROLL_STEP_PX, Math.max(0, listMax - listTop)) };
}

// A satellite's saved channels by the transponder they are on. The TV keeps
// channels apart from its transponder list, so deleting a transponder
// leaves its channels behind; those, and any whose transponder is not
// listed, are `orphans`. A channel names its transponder by id; one without
// an id goes by frequency, when only one listed transponder has it.
export function channelsByTransponder(
  channels: readonly BroadcastChannel[],
  satelliteName: string,
  transponders: readonly Transponder[],
): { on: Map<number, BroadcastChannel[]>; orphans: BroadcastChannel[] } {
  const ids = new Set(transponders.map(item => item.id));
  const on = new Map<number, BroadcastChannel[]>();
  const orphans: BroadcastChannel[] = [];
  for (const channel of channels) {
    if (channel.satellite !== satelliteName) continue;
    let id: number | null = channel.transponderId && ids.has(channel.transponderId) ? channel.transponderId : null;
    if (id === null && !channel.transponderId && channel.frequency) {
      const near = transponders.filter(item => Math.abs(item.frequency - channel.frequency) <= 3);
      if (near.length === 1) id = near[0].id;
    }
    if (id === null) {
      orphans.push(channel);
      continue;
    }
    const list = on.get(id);
    if (list) list.push(channel);
    else on.set(id, [channel]);
  }
  return { on, orphans };
}

// A found channel's kind, satellite, and transponder frequency.
export function addedDetail(channel: BroadcastChannel): string {
  return [
    channel.kind === 'radio' ? t('satellite.radio') : t('satellite.tv'),
    channel.satellite,
    channel.frequency ? `${String(channel.frequency)} MHz` : '',
  ].filter(Boolean).join(' · ');
}

function lnbIndex(config: SatelliteConfig): number {
  const at = LNB_PRESETS.findIndex(preset => preset.min === config.lnb.min && preset.max === config.lnb.max);
  return at < 0 ? 0 : at;
}

function lnbLabel(config: SatelliteConfig): string {
  const at = LNB_PRESETS.findIndex(preset => preset.min === config.lnb.min && preset.max === config.lnb.max);
  if (at >= 0) return LNB_PRESETS[at].label;
  return config.lnb.min === config.lnb.max ? String(config.lnb.min) : `${String(config.lnb.min)}/${String(config.lnb.max)}`;
}

function diseqcLabel(port: string): string {
  return port === 'OFF_DISEQC' ? t('common.off') : port.charAt(0);
}

// The transponder the TV last tuned for a satellite, as LG's settings keep it.
function storedForm(config: SatelliteConfig): TuneRequest | null {
  const selected = config.scanInfo.selectedTp as Record<string, unknown> | undefined;
  if (!selected || typeof selected.frequency !== 'number') return null;
  return {
    frequency: selected.frequency,
    polarization: selected.polarisation === 'VERTICAL_POLARISATION' ? 'V' : 'H',
    symbolRate: typeof selected.symbolRate === 'number' ? selected.symbolRate : 27500,
    system: selected.transmissionSystem === 'TRANSMISSIONSYSTEM_DVBS' ? 'DVB-S' : 'DVB-S2',
  };
}

// The finder names a listed transponder only when the TV would tune that
// record, so what the form shows is what gets tuned.
const formMatches = sameTransponder;

interface SatelliteToolsOptions {
  onRevealTabBar: (dir: 'up' | 'left') => void;
  onBack: () => void;
  // A scan or a delete changed the TV's channel list.
  onChannelsChanged: () => void;
  // The channel manager saved a new order.
  onOrderChanged: () => void;
}

/**
 * Satellite tools, opened from Settings and laid out like it: a signal
 * finder that tunes a transponder, shows its signal live, and adds its
 * channels, and a channel scan of whole satellites with each one's LNB,
 * DiSEqC port, and transponder list. A live tuner card (the picture, lock,
 * strength, quality, and bit error rate) stays beside the finder. Satellite
 * and transponder names come from the TV, through `html`.
 */
export class SatelliteTools {
  readonly focusScope: FocusScope;
  private readonly stage: HTMLElement;
  private readonly ui: HTMLElement;
  private readonly video: BroadcastVideo;
  private readonly nav: SpatialNav;
  private readonly prompt = new ConfirmationPrompt('prompt.satellite-tools');
  private readonly manager: SatelliteChannelManager;

  private active = false;
  private tool: SatelliteTool = 'finder';
  private configs: SatelliteConfig[] | null = null;
  private loadState: 'loading' | 'ready' | 'unavailable' = 'loading';
  private configIndex = 0;
  private readonly transponders = new Map<number, Transponder[]>();
  private form: TuneRequest = { frequency: 11000, polarization: 'H', symbolRate: 27500, system: 'DVB-S2' };
  private editing: { field: NumberField; text: string } | null = null;
  // The transponder menu's open state lives here: a render would drop a class.
  private menuOpen = false;
  // "New transponder" picked: the form stays a new one even where it matches.
  private newTp = false;
  private lnbTimer: ReturnType<typeof setTimeout> | null = null;
  // Satellites whose last tuned transponder the TV has yet to store.
  private readonly unsavedTp = new Set<SatelliteConfig>();
  private broadcastId: string | null = null;
  private tuned = false;
  private tuning = false;
  private signal: SignalReading | null = null;
  private tpResult: { tv: number; radio: number } | 'failed' | 'saving' | null = null;
  // Save to TV: the settings the TV did not keep, once read back.
  private saveResult: SatelliteSetting[] | 'failed' | 'saving' | null = null;
  private scanOptions: ScanOptions = { network: true, blind: false, freeOnly: false, skipRadio: false };
  private orderMode: OrderMode = 'keep';
  // A satellite's transponder list, opened from the Satellite scan.
  private tpManager: { configId: number; selected: Set<number> } | null = null;
  // Delete all channels is running.
  private wiping = false;
  // The delete button pressed, while its delete runs.
  private deleting: 'tpm-delete' | 'tpm-delete-all' | 'tpm-orphans' | null = null;
  // The TV's satellite channels, while a transponder list is open.
  private satChannels: BroadcastChannel[] | null = null;
  private unsubscribe: (() => void) | null = null;
  private unsubscribeShare: (() => void) | null = null;
  // The scan's phase at the last render, to notice it ending.
  private seenPhase = SatelliteScanSession.state.phase;
  private token = 0;
  private digitTimer: ReturnType<typeof setTimeout> | null = null;
  private retuneTimer: ReturnType<typeof setTimeout> | null = null;
  private readingTimer: ReturnType<typeof setTimeout> | null = null;
  private shareTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly container: HTMLElement, private readonly options: SatelliteToolsOptions) {
    this.stage = document.createElement('div');
    this.stage.className = 'sat-stage';
    this.ui = document.createElement('div');
    this.ui.className = 'sat-ui';
    container.appendChild(this.stage);
    container.appendChild(this.ui);
    this.video = new BroadcastVideo(this.stage, () => this.ui.querySelector<HTMLElement>('.sat-tools-slot'), () => {
      if (this.active) this.render();
    });
    this.focusScope = Focus.register({
      id: 'view.satellite-tools',
      root: container,
      leaveFor: { up: 'tabbar', left: 'tabbar' },
      reveal: key => (key === 'sat-tools-share' ? this.revealShareCard() : false),
      // A caret left in a field keeps the arrow keys from whatever owns them.
      onRelease: () => this.caretInput()?.blur(),
      defaultKey: () => {
        const el = this.nav.focused;
        return el && this.container.contains(el) ? el.dataset.key ?? null : null;
      },
    });
    this.nav = new SpatialNav(container, el => this.onFocus(el), { scope: this.focusScope });
    this.manager = new SatelliteChannelManager({
      nav: this.nav,
      prompt: this.prompt,
      ui: () => this.ui,
      render: () => this.render(),
      focusKey: key => this.refocus(key),
      onOrderChanged: () => this.options.onOrderChanged(),
      onChannelsChanged: () => this.options.onChannelsChanged(),
    });
    container.setAttribute('data-self-activate', '');
    container.addEventListener('click', (event: MouseEvent) => {
      const control = (event.target as HTMLElement).closest<HTMLElement>('[data-focusable]');
      if (!control || !this.container.contains(control)) return;
      this.nav.focus(control, 'pointer');
      this.activate(control);
    });
    // The global key handler leaves a text field its keys, so the field owns
    // its ways out; leaving commits what was typed.
    container.addEventListener('keydown', (event: KeyboardEvent) => {
      if (!this.manager.onFieldKey(event)) this.onFieldKey(event);
    });
    container.addEventListener('input', (event: Event) => {
      if (event.target instanceof HTMLInputElement) this.manager.onInput(event.target);
    });
    container.addEventListener('scroll', (event: Event) => {
      if (event.target instanceof HTMLElement && event.target.dataset.cmScroller) this.manager.onScroll(event.target);
    }, true);
    container.addEventListener('focusout', (event: FocusEvent) => {
      const input = event.target as HTMLInputElement;
      if (input.tagName === 'INPUT' && input.dataset.number) this.commitField(input);
    });
  }

  // --- Lifecycle -----------------------------------------------------------

  async open(tool: SatelliteTool): Promise<void> {
    this.active = true;
    // A scan in progress owns the tuner, and this screen shows it.
    this.tool = SatelliteScanSession.busy ? 'scan' : tool;
    this.seenPhase = SatelliteScanSession.state.phase;
    this.unsubscribe?.();
    this.unsubscribe = SatelliteScanSession.subscribe(() => this.onSessionChange());
    this.unsubscribeShare?.();
    this.unsubscribeShare = FinderShare.subscribe(() => this.onShareChange());
    FinderShare.onApply = message => this.applyFromPhone(message);
    const token = ++this.token;
    this.loadState = 'loading';
    this.tpResult = null;
    this.saveResult = null;
    this.tpManager = null;
    // The TV's lists may have changed since: a scan's network search adds
    // transponders, and LG's own settings edit them.
    this.transponders.clear();
    if (this.tool === 'manager') void this.manager.open();
    this.render();
    this.focusFirst();
    const configs = await SatelliteScan.configurations();
    if (token !== this.token || !this.active) return;
    if (!configs) {
      this.loadState = 'unavailable';
      this.render();
      if (this.tool !== 'manager') this.focusFirst();
      return;
    }
    this.configs = configs;
    this.loadState = 'ready';
    this.configIndex = Math.max(0, Math.min(this.configIndex, configs.length - 1));
    const config = this.config;
    if (config) {
      this.adoptSelectedTp(config);
      this.scanOptions = {
        network: config.networkSearch,
        blind: config.blindSearch,
        freeOnly: config.skipScrambled,
        skipRadio: this.scanOptions.skipRadio,
      };
    }
    if (this.tool !== 'manager') {
      this.render();
      this.focusFirst();
    }
    if (this.tool === 'scan') this.loadAllTransponders();
    else if (config) void this.loadTransponders(config);
    this.pollReading(token);
    if (this.tool === 'finder') await this.openPicture();
  }

  // The picture and live signal, once the tuner is free.
  private async openPicture(): Promise<void> {
    const token = this.token;
    if (this.broadcastId || this.tool !== 'finder' || SatelliteScanSession.busy) return;
    this.broadcastId = await this.video.prepare();
    if (token !== this.token || !this.active) return;
    // Switched to a tool without a picture, or a scan began, meanwhile.
    if ((this.tool as SatelliteTool) !== 'finder' || SatelliteScanSession.busy) {
      void this.releasePicture();
      return;
    }
    if (this.broadcastId) this.video.start();
    this.render();
    this.scheduleRetune(0);
  }

  private onSessionChange(): void {
    if (!this.active) return;
    const phase = SatelliteScanSession.state.phase;
    const ended = this.seenPhase !== phase && (phase === 'done' || phase === 'failed');
    this.seenPhase = phase;
    this.render();
    if (ended) {
      this.transponders.clear();
      if (this.tool === 'scan') this.loadAllTransponders();
      this.refocus('scan-done');
      void this.openPicture();
    }
  }

  // Leaving puts the broadcast back on its channel and frees it.
  close(): void {
    if (!this.active) return;
    this.active = false;
    this.token++;
    this.clearTimers();
    this.commitDigits(false);
    this.caretInput()?.blur();
    this.menuOpen = false;
    this.tpManager = null;
    this.manager.close();
    KeyHandler.setDigitSink(null);
    this.prompt.hide();
    // A scan goes on in the background; only this screen's picture stops.
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubscribeShare?.();
    this.unsubscribeShare = null;
    FinderShare.stop();
    FinderShare.onApply = null;
    this.saveTps();
    void this.releasePicture();
  }

  // The Satellite scan tool shows no picture; the finders do.
  private async releasePicture(): Promise<void> {
    const id = this.broadcastId;
    const tuned = this.tuned;
    this.tuned = false;
    this.broadcastId = null;
    this.signal = null;
    if (id && tuned) await SatelliteScan.cancelTune(id);
    this.video.stop();
  }

  dismissPrompt(): void {
    this.prompt.hide();
  }

  private clearTimers(): void {
    for (const timer of [this.digitTimer, this.retuneTimer, this.readingTimer, this.lnbTimer, this.shareTimer]) {
      if (timer) clearTimeout(timer);
    }
    this.lnbTimer = null;
    this.shareTimer = null;
    this.digitTimer = null;
    this.retuneTimer = null;
    this.readingTimer = null;
  }

  private get config(): SatelliteConfig | null {
    return this.configs ? this.configs[this.configIndex] ?? null : null;
  }

  // The finder starts on the transponder the TV last used for the satellite.
  private adoptSelectedTp(config: SatelliteConfig): void {
    this.newTp = false;
    this.form = storedForm(config) ?? this.form;
  }

  private async loadTransponders(config: SatelliteConfig): Promise<void> {
    if (this.transponders.has(config.id)) return;
    const list = await SatelliteScan.transponders(config);
    this.transponders.set(config.id, list);
    if (this.active) this.render();
  }

  private loadAllTransponders(): void {
    for (const config of this.configs ?? []) void this.loadTransponders(config);
  }

  private get knownTransponders(): Transponder[] {
    const config = this.config;
    return config ? this.transponders.get(config.id) ?? [] : [];
  }

  // --- Tuning --------------------------------------------------------------

  private scheduleRetune(delay = RETUNE_DELAY_MS): void {
    if (this.retuneTimer) clearTimeout(this.retuneTimer);
    this.retuneTimer = setTimeout(() => {
      this.retuneTimer = null;
      void this.retune();
    }, delay);
  }

  private async retune(): Promise<void> {
    const config = this.config;
    const id = this.broadcastId;
    if (!this.active || !config || !id || this.tool !== 'finder' || SatelliteScanSession.busy) return;
    const token = this.token;
    this.tuning = true;
    this.signal = null;
    this.tpResult = null;
    this.render();
    this.shareReading();
    const form = this.form;
    const ok = await SatelliteScan.tune(id, config, form, this.knownTransponders);
    if (token !== this.token || !this.active) return;
    this.tuning = false;
    this.tuned = this.tuned || ok;
    if (!ok) showToast(t('satellite.tuneFailed'));
    else this.rememberTp(config, form);
    this.render();
    if (ok) this.showPicture(token, id, config);
  }

  // The finder opens again on the transponder last tuned, as LG's settings
  // do; the TV stores it once the finder closes, not on every tune.
  private rememberTp(config: SatelliteConfig, form: TuneRequest): void {
    const selected = selectedTpRecord(form, this.transponders.get(config.id) ?? []);
    const stored = (config.scanInfo.selectedTp ?? {}) as Record<string, unknown>;
    if (Object.keys(selected).every(field => stored[field] === selected[field])) return;
    config.scanInfo = { ...config.scanInfo, selectedTp: selected };
    this.unsavedTp.add(config);
  }

  private saveTps(): void {
    for (const config of this.unsavedTp) void SatelliteScan.saveLnb(config);
    this.unsavedTp.clear();
  }

  // A manual tune locks the transponder but plays no service; once it
  // locks, a known TV channel on it plays, as a receiver's signal finder
  // shows the picture.
  private showPicture(token: number, broadcastId: string, config: SatelliteConfig): void {
    const form = this.form;
    const current = () => token === this.token && this.active && this.form === form;
    setTimeout(() => {
      if (!current() || !this.signal || !this.signal.locked) return;
      void this.channelsOnTransponder(config, form.frequency).then(async (candidates) => {
        log.info('Signal finder picture', 'event=satellite.scan.picture', `found=${String(candidates.length)}`);
        if (!candidates.length || !current()) return;
        // A manual tune holds the pipeline off services; leave it first. The
        // TV refuses a change to the channel it already names, which would
        // leave the picture stalled, so another channel on the mux plays.
        await SatelliteScan.cancelTune(broadcastId);
        const playing = await BroadcastService.currentChannelId(broadcastId);
        const channel = candidates.find(item => item.id !== playing) ?? candidates[0];
        if (current() && await BroadcastService.tune(channel, broadcastId) && current()) this.tuned = false;
      });
    }, PICTURE_DELAY_MS);
  }

  // The TV channels on a transponder, from the Satellite cache or, without
  // one, from the TV (stored for the section too).
  private async channelsOnTransponder(config: SatelliteConfig, frequency: number): Promise<BroadcastChannel[]> {
    await BroadcastCache.load();
    let list = BroadcastCache.channels();
    if (!list) {
      const load = await BroadcastService.loadChannels();
      if (load.ok && load.route !== 'sample') {
        BroadcastCache.saveChannels(load.channels);
        list = load.channels;
      }
    }
    return (list ?? []).filter(item => item.kind === 'tv' && item.satellite === config.satelliteName
      && Math.abs(item.frequency - frequency) <= 3);
  }

  private pollReading(token: number): void {
    this.readingTimer = setTimeout(() => {
      this.readingTimer = null;
      if (token !== this.token || !this.active) return;
      // The scan broadcast is left alone while it scans: a root call on it,
      // made as another app, can end the scan.
      const id = SatelliteScanSession.busy ? null : this.broadcastId;
      if (!id) {
        // The channel manager shows no reading.
        if (this.active && this.tool !== 'manager') this.render();
        this.shareReading();
        this.pollReading(token);
        return;
      }
      void SatelliteScan.signal(id).then((signal) => {
        if (token !== this.token || !this.active) return;
        this.signal = signal;
        this.render();
        this.shareReading();
        this.pollReading(token);
      });
    }, READING_MS);
  }

  // --- Transponder scan ----------------------------------------------------

  private async scanTransponder(): Promise<void> {
    const config = this.config;
    const id = this.broadcastId;
    if (!config || !id || this.tpResult === 'saving') return;
    this.commitDigits(false);
    this.tpResult = 'saving';
    this.render();
    await captureLineup(true);
    const result = await SatelliteScan.saveTransponder(id, config, this.form, this.knownTransponders);
    if (!this.active) return;
    this.tuned = true;
    if (result !== 'ok') {
      this.tpResult = 'failed';
      this.render();
      return;
    }
    // What the transponder now holds, counted from the TV's own list. The
    // TV writes it a moment after the save answers, so it is read again
    // until the transponder's channels appear.
    const form = this.form;
    let onTransponder: BroadcastChannel[] = [];
    for (let attempt = 0; attempt < TP_COUNT_ATTEMPTS && !onTransponder.length; attempt++) {
      await new Promise(resolve => setTimeout(resolve, TP_COUNT_DELAY_MS));
      const load = await BroadcastService.loadChannels();
      if (!this.active) return;
      onTransponder = load.ok ? load.channels.filter(channel => channel.satellite === config.satelliteName
        && Math.abs(channel.frequency - form.frequency) <= 3) : [];
    }
    this.tpResult = {
      tv: onTransponder.filter(channel => channel.kind === 'tv').length,
      radio: onTransponder.filter(channel => channel.kind === 'radio').length,
    };
    this.options.onChannelsChanged();
    this.render();
  }

  // --- Channel scan --------------------------------------------------------

  private confirmScan(): void {
    const configs = this.configs;
    if (!configs || !configs.some(config => config.selected)) return;
    this.prompt.show({
      title: t('satelliteTools.scanConfirmTitle'),
      message: [
        t('satelliteTools.scanConfirmBody'),
        t(this.orderMode === 'reset' ? 'satelliteTools.scanConfirmReset' : 'satelliteTools.scanConfirmKeep'),
        this.scanOptions.skipRadio ? t('satelliteTools.scanConfirmNoRadio') : '',
      ].filter(Boolean).join(' '),
      confirmLabel: t('satelliteTools.startScan'),
      cancelLabel: t('common.cancel'),
      onConfirm: () => { void this.startScan(); },
      onCancel: () => this.refocus('scan-start'),
    });
  }

  // The scan runs in the background; this screen only frees its picture first.
  private async startScan(): Promise<void> {
    const configs = this.configs;
    if (!configs || SatelliteScanSession.busy) return;
    await this.releasePicture();
    this.refocus('scan-stop');
    await SatelliteScanSession.start(configs, this.scanOptions, this.orderMode);
  }

  // --- Phone share ---------------------------------------------------------

  // The phone page shows the TV's own words, in the TV's language.
  private shareLabels(): ViewerLabels {
    return {
      title: t('satelliteTools.signalFinder'),
      strength: t('satellite.signalStrength'),
      quality: t('satellite.signalQuality'),
      ber: t('satelliteTools.ber'),
      transponder: t('satelliteTools.transponder'),
      locked: t('satelliteTools.locked'),
      noLock: t('satelliteTools.noLock'),
      searching: t('satelliteTools.searching'),
      waiting: t('finderShare.waiting'),
      stopped: t('finderShare.stopped'),
      stale: t('finderShare.stale'),
      sound: t('finderShare.sound'),
      peak: t('finderShare.peak'),
      resetPeak: t('common.reset'),
      satellite: t('satelliteTools.satellite'),
      lnb: t('satelliteTools.lnb'),
      diseqc: t('satelliteTools.diseqc'),
      tone: t('satelliteTools.tone'),
      lnbPower: t('satelliteTools.lnbPower'),
      newTransponder: t('satelliteTools.newTransponder'),
      frequency: t('satelliteTools.frequency'),
      symbolRate: t('satelliteTools.symbolRate'),
      polarization: t('satelliteTools.polarization'),
      horizontal: t('satelliteTools.horizontal'),
      vertical: t('satelliteTools.vertical'),
      system: t('satelliteTools.system'),
      off: t('common.off'),
      send: t('finderShare.send'),
      cancel: t('common.cancel'),
      sending: t('finderShare.sending'),
      applied: t('finderShare.applied'),
      notApplied: t('finderShare.notApplied'),
      noAnswer: t('finderShare.noAnswer'),
    };
  }

  private toggleShare(): void {
    if (FinderShare.active && FinderShare.state !== 'failed') {
      FinderShare.stop();
      return;
    }
    // The phone can pick any satellite, so it gets every transponder list.
    this.loadAllTransponders();
    void FinderShare.start(this.shareLabels()).then(() => this.shareReading());
  }

  private scheduleShareSettings(): void {
    if (this.shareTimer || FinderShare.state !== 'live' || this.tool !== 'finder') return;
    this.shareTimer = setTimeout(() => {
      this.shareTimer = null;
      const settings = this.shareSettings();
      if (settings && this.active && this.tool === 'finder') FinderShare.publishSettings(settings);
    }, SHARE_SETTINGS_MS);
  }

  // What the finder shows, for the phone to edit: every satellite with its
  // LNB setup, transponder list, and the transponder it tunes.
  private shareSettings(): FinderSettings | null {
    const current = this.config;
    if (!current || !this.configs || this.loadState !== 'ready') return null;
    const satellites = this.configs.map((config): SharedSatellite => {
      const known = this.transponders.get(config.id) ?? [];
      const form = config === current ? this.form : storedForm(config) ?? this.form;
      const match = config === current ? Number(this.selectedTp()) || 0
        : known.find(item => formMatches(item, form))?.id ?? 0;
      return {
        id: config.id,
        name: config.satelliteName,
        lnb: LNB_PRESETS.findIndex(preset => preset.min === config.lnb.min && preset.max === config.lnb.max),
        lnbLabel: lnbLabel(config),
        diseqc: config.diseqc,
        tone: config.tone,
        lnbPower: config.lnbPower,
        form: { ...form },
        tp: match,
        tps: known.map(item => [item.id, item.frequency, item.polarization === 'V' ? 'V' : 'H', item.symbolRate || 0,
          item.system === 'DVB-S' || item.system === 'DVB-S2' ? item.system : '']),
      };
    });
    return {
      satellite: current.id,
      satellites,
      lnbs: LNB_PRESETS.map(preset => ({ label: preset.label, universal: preset.min !== preset.max })),
      diseqcs: DISEQC_PORTS.map(port => ({ value: port, label: diseqcLabel(port) })),
      tones: TONES.map(tone => ({ value: tone.value, label: tone.label || t('common.off') })),
    };
  }

  // The phone's settings replace the form and the satellite's LNB setup, as
  // if picked with the remote; false when the finder can't tune them now.
  private applyFromPhone(message: ApplyMessage): boolean {
    const reason = this.phoneRejection(message);
    const configs = this.configs;
    if (reason || !configs) {
      log.warn('Phone settings rejected', 'event=satellite.share.rejected', `reason=${reason ?? 'busy'}`);
      return false;
    }
    const at = configs.findIndex(item => item.id === message.satellite);
    const config = configs[at];
    this.commitDigits(false);
    this.caretInput()?.blur();
    this.menuOpen = false;
    if (at !== this.configIndex) {
      this.configIndex = at;
      void this.loadTransponders(config);
    }
    this.newTp = false;
    this.form = { ...message.form };
    this.tpResult = null;
    this.saveResult = null;
    const preset = message.lnb >= 0 ? LNB_PRESETS[message.lnb] : null;
    const lnb = preset ? { type: preset.type, min: preset.min, max: preset.max } : config.lnb;
    const lnbSame = lnb.type === config.lnb.type && lnb.min === config.lnb.min && lnb.max === config.lnb.max
      && message.diseqc === config.diseqc && message.tone === config.tone && message.lnbPower === config.lnbPower;
    if (lnbSame) {
      this.render();
      this.scheduleRetune(0);
      return true;
    }
    config.lnb = lnb;
    config.diseqc = message.diseqc;
    config.tone = message.tone;
    config.lnbPower = message.lnbPower;
    // Saves the setup, then retunes on it.
    this.lnbChanged(config);
    return true;
  }

  private phoneRejection(message: ApplyMessage): string | null {
    if (!this.active || this.tool !== 'finder' || this.loadState !== 'ready' || SatelliteScanSession.busy
      || this.tpResult === 'saving' || this.saveResult === 'saving') return 'busy';
    if (!this.configs || !this.configs.some(item => item.id === message.satellite)) return 'satellite';
    if (message.lnb >= LNB_PRESETS.length || (DISEQC_PORTS as readonly string[]).indexOf(message.diseqc) < 0
      || !TONES.some(tone => tone.value === message.tone)) return 'invalid';
    return null;
  }

  private onShareChange(): void {
    if (!this.active) return;
    this.render();
    // The QR appears under the switch; asking for the switch again reveals
    // it. A pointer user scrolls for themselves.
    const toggle = this.nav.focused;
    if (FinderShare.state === 'live' && InputMode.current === 'keys' && toggle
      && toggle.dataset.key === 'sat-tools-share') this.nav.focus(toggle);
  }

  // Scrolls the share card into view as far as the switch above it allows;
  // false leaves the switch itself to the scope's own check.
  private revealShareCard(): boolean {
    const scroller = this.ui.querySelector<HTMLElement>('.sat-tools-scroll');
    const block = this.ui.querySelector<HTMLElement>('.sat-tools-share');
    if (!scroller || !block) return false;
    const below = revealDelta(scroller.getBoundingClientRect(), block.getBoundingClientRect(), SHARE_GUTTER_PX);
    if (below <= 0) return false;
    scroller.scrollTop += below;
    return true;
  }

  private liveLock(): 'locked' | 'nolock' | 'searching' {
    const signal = this.signal;
    return this.tuning ? 'searching' : signal && signal.locked ? 'locked' : signal ? 'nolock' : 'searching';
  }

  private shareReading(): void {
    if (FinderShare.state !== 'live') return;
    const config = this.config;
    const signal = this.tuning ? null : this.signal;
    const reading: FinderReading = {
      lock: this.liveLock(),
      strength: signal ? signal.strength : null,
      quality: signal ? signal.quality : null,
      ber: signal ? signal.ber : null,
      satellite: config ? config.satelliteName : '',
      transponder: transponderLabel({ id: 0, ...this.form }),
    };
    FinderShare.publish(reading);
  }

  // --- Keys ----------------------------------------------------------------

  handleAction(action: Action): void {
    if (this.prompt.visible) {
      this.prompt.handleAction(action);
      return;
    }
    const focused = this.nav.focused;
    if (this.menuOpen) {
      this.menuAction(action, focused);
      return;
    }
    if (this.tool === 'manager' && !SatelliteScanSession.busy && this.manager.handleAction(action, focused)) return;
    if (action === 'back') {
      if (this.editing) {
        this.editing = null;
        this.render();
        return;
      }
      if (this.tpManager) {
        this.closeTpManager();
        return;
      }
      this.options.onBack();
      return;
    }
    if (action === 'select' && focused) {
      this.activate(focused);
      return;
    }
    if ((action === 'left' || action === 'right') && focused && this.adjust(focused, action === 'left' ? -1 : 1)) return;
    // The scan's list takes no focus: Up and Down on its button scroll it
    // until its end, then focus moves on.
    if ((action === 'up' || action === 'down') && focused && focused.closest('.sat-tools-action')
      && this.scrollLog(focused, action)) return;
    if (action === 'up' || action === 'down' || action === 'left' || action === 'right') {
      if (!this.nav.move(action) && (action === 'up' || action === 'left')) this.options.onRevealTabBar(action);
    }
  }

  // Left and Right change a number field or a stepper in place.
  private adjust(el: HTMLElement, step: -1 | 1): boolean {
    const field = el.dataset.number as NumberField | undefined;
    if (field) {
      this.commitDigits(false);
      const spec = NUMBER_FIELDS[field];
      this.form = { ...this.form, [field]: Math.max(spec.min, Math.min(spec.max, this.form[field] + step * spec.step)) };
      this.formChanged();
      return true;
    }
    if (el.dataset.stepper === 'lnb') {
      const config = this.configs?.find(item => String(item.id) === el.dataset.config);
      if (!config) return true;
      const preset = LNB_PRESETS[(lnbIndex(config) + step + LNB_PRESETS.length) % LNB_PRESETS.length];
      config.lnb = { type: preset.type, min: preset.min, max: preset.max };
      this.lnbChanged(config);
      return true;
    }
    return false;
  }

  // Down first brings the whole list into the page, then scrolls the list
  // itself, so every press moves something on screen.
  private scrollLog(focused: HTMLElement, action: 'up' | 'down'): boolean {
    const page = this.ui.querySelector<HTMLElement>('.sat-tools-scroll');
    const block = this.ui.querySelector<HTMLElement>('.sat-tools-log');
    const list = this.ui.querySelector<HTMLElement>('[data-scroller]');
    if (!page || !block || !list) return false;
    const step = logScrollStep(action, page.getBoundingClientRect(), block.getBoundingClientRect(),
      focused.getBoundingClientRect(), list.scrollTop, list.scrollHeight - list.clientHeight);
    if (step.page) page.scrollTop += step.page;
    if (step.list) list.scrollTop += step.list;
    return step.page !== 0 || step.list !== 0;
  }

  private formChanged(): void {
    this.tpResult = null;
    this.saveResult = null;
    this.render();
    this.scheduleRetune();
  }

  private activate(el: HTMLElement): void {
    if (el.getAttribute('aria-disabled') === 'true') return;
    if (this.tool === 'manager' && this.manager.activate(el)) return;
    if (el.tagName === 'INPUT') {
      this.commitDigits(false);
      (el as HTMLInputElement).focus();
      return;
    }
    if (el.hasAttribute('data-dropdown-trigger')) {
      this.setMenu(!this.menuOpen);
      return;
    }
    if (el.classList.contains('dropdown-option')) {
      this.pickTransponder(el.dataset.dropdownValue ?? 'new');
      return;
    }
    const tool = el.dataset.tool as SatelliteTool | undefined;
    if (tool) {
      this.switchTool(tool);
      return;
    }
    const group = el.closest<HTMLElement>('.toggle-group');
    if (group && el.dataset.value !== undefined) {
      this.pickOption(group.id, el.dataset.value);
      return;
    }
    // A switch is a shared toggle button inside the element naming its action.
    const target = el.closest<HTMLElement>('[data-action]') ?? el;
    switch (target.dataset.action) {
      case 'tp-scan': void this.scanTransponder(); break;
      case 'save-to-tv': void this.saveToTv(); break;
      case 'new-tp': this.startNewTransponder(); break;
      case 'tp-manage': this.openTpManager(target.dataset.config); break;
      case 'tpm-toggle': this.toggleTp(target.dataset.tp); break;
      case 'tpm-select-all': this.selectAllTps(); break;
      case 'tpm-delete': this.confirmTpDelete(false); break;
      case 'tpm-delete-all': this.confirmTpDelete(true); break;
      case 'tpm-orphans': this.confirmOrphanDelete(); break;
      case 'share': this.toggleShare(); break;
      case 'lnb-power': {
        const config = this.config;
        if (config) {
          config.lnbPower = !config.lnbPower;
          this.lnbChanged(config);
        }
        break;
      }
      case 'cfg-toggle': this.toggleConfig(target.dataset.config); break;
      case 'option': this.toggleOption(target.dataset.option as keyof ScanOptions); break;
      case 'order':
        this.orderMode = this.orderMode === 'keep' ? 'reset' : 'keep';
        this.render();
        break;
      case 'scan-start': if (!this.wiping) this.confirmScan(); break;
      case 'wipe': this.confirmWipe(); break;
      case 'scan-stop': void SatelliteScanSession.stop(); break;
      case 'scan-done': this.finishScan(); break;
      case 'back': this.options.onBack(); break;
    }
  }

  private switchTool(tool: SatelliteTool): void {
    if (tool === this.tool) {
      if (this.tpManager) this.closeTpManager();
      return;
    }
    this.menuOpen = false;
    this.tpManager = null;
    // The phone share belongs to the signal finder.
    if (tool !== 'finder') FinderShare.stop();
    if (this.tool === 'manager') this.manager.close();
    this.tool = tool;
    this.tpResult = null;
    if (tool === 'manager') void this.manager.open();
    this.render();
    if (tool === 'scan') this.loadAllTransponders();
    if (tool !== 'finder') void this.releasePicture();
    else if (this.broadcastId) this.scheduleRetune(0);
    else void this.openPicture();
  }

  private pickOption(groupId: string, value: string): void {
    if (groupId === 'sat-tools-satellite') {
      const at = this.configs ? this.configs.findIndex(config => String(config.id) === value) : -1;
      if (at < 0 || at === this.configIndex) return;
      this.configIndex = at;
      const config = this.config;
      if (config) {
        this.adoptSelectedTp(config);
        void this.loadTransponders(config);
      }
      this.formChanged();
    } else if (groupId === 'sat-tools-pol') {
      this.form = { ...this.form, polarization: value === 'V' ? 'V' : 'H' };
      this.formChanged();
    } else if (groupId === 'sat-tools-system') {
      this.form = { ...this.form, system: value === 'DVB-S' ? 'DVB-S' : 'DVB-S2' };
      this.formChanged();
    } else if (groupId === 'sat-tools-tone') {
      const config = this.config;
      if (config) {
        config.tone = value;
        this.lnbChanged(config);
      }
    } else if (groupId.indexOf('sat-tools-diseqc-') === 0) {
      const config = this.configs?.find(item => String(item.id) === groupId.slice('sat-tools-diseqc-'.length));
      if (config) {
        config.diseqc = value;
        this.lnbChanged(config);
      }
    }
  }

  private toggleConfig(id: string | undefined): void {
    const config = this.configs?.find(item => String(item.id) === id);
    if (!config) return;
    config.selected = !config.selected;
    this.render();
  }

  private toggleOption(option: keyof ScanOptions): void {
    if (!(option in this.scanOptions)) return;
    this.scanOptions = { ...this.scanOptions, [option]: !this.scanOptions[option] };
    this.render();
  }

  // --- Delete all channels ----------------------------------------------------

  private confirmWipe(): void {
    if (this.wiping || SatelliteScanSession.busy) return;
    this.prompt.show({
      title: t('satelliteTools.deleteAllTitle'),
      message: t('satelliteTools.deleteAllBody'),
      confirmLabel: t('common.delete'),
      cancelLabel: t('common.cancel'),
      onConfirm: () => { void this.wipe(); },
      onCancel: () => this.refocus('sat-tools-wipe'),
    });
  }

  private async wipe(): Promise<void> {
    this.wiping = true;
    this.render();
    this.refocus('sat-tools-wipe');
    const result = await SatelliteScan.deleteAllChannels();
    // The satellite setup was rebuilt: its ids and transponder lists are new.
    const configs = await SatelliteScan.configurations();
    this.wiping = false;
    if (configs) this.configs = configs;
    this.configIndex = 0;
    this.transponders.clear();
    this.options.onChannelsChanged();
    if (!this.active) return;
    showToast(t(!result.ok ? 'satelliteTools.deleteChannelsFailed'
      : result.restored ? 'satelliteTools.allChannelsDeleted' : 'satelliteTools.satellitesNotRestored'));
    this.render();
    if (this.tool === 'scan') this.loadAllTransponders();
    this.refocus('sat-tools-wipe');
  }

  private finishScan(): void {
    SatelliteScanSession.dismiss();
    this.render();
    this.refocus('scan-start');
  }

  // --- LNB settings ----------------------------------------------------------

  // The Satellite scan saves its LNB choices when it starts; the finders save
  // at once, as LG's satellite settings do, and retune on the new setup.
  private lnbChanged(config: SatelliteConfig): void {
    this.saveResult = null;
    this.render();
    if (this.tool === 'scan') return;
    if (this.lnbTimer) clearTimeout(this.lnbTimer);
    const token = this.token;
    this.lnbTimer = setTimeout(() => {
      this.lnbTimer = null;
      void SatelliteScan.saveLnb(config).then((ok) => {
        if (token !== this.token || !this.active) return;
        if (!ok) showToast(t('satelliteTools.lnbSaveFailed'));
        this.scheduleRetune(0);
      });
    }, RETUNE_DELAY_MS);
  }

  // Writes the satellite's setup and the form's transponder to the TV now,
  // then shows whether the TV kept them.
  private async saveToTv(): Promise<void> {
    const config = this.config;
    if (!config || this.saveResult === 'saving') return;
    this.commitDigits(false);
    if (this.lnbTimer) clearTimeout(this.lnbTimer);
    this.lnbTimer = null;
    config.scanInfo = { ...config.scanInfo, selectedTp: selectedTpRecord(this.form, this.knownTransponders) };
    this.unsavedTp.delete(config);
    this.saveResult = 'saving';
    this.render();
    const token = this.token;
    const unkept = await SatelliteScan.saveAndCheck(config);
    if (token !== this.token || !this.active || this.saveResult !== 'saving') return;
    this.saveResult = unkept ?? 'failed';
    this.render();
  }

  // --- Transponder menu ------------------------------------------------------

  private selectedTp(): string {
    const match = this.newTp ? undefined : this.knownTransponders.find(item => formMatches(item, this.form));
    return match ? String(match.id) : 'new';
  }

  private setMenu(open: boolean): void {
    // Nothing listed yet: the form is a new transponder already.
    if (open && !this.knownTransponders.length) return;
    this.menuOpen = open;
    this.render();
    this.refocus(open ? `sat-tools-tp:${this.selectedTp()}` : 'sat-tools-tp:trigger');
  }

  // An open menu keeps the keys: Up and Down move inside it, Back and Left
  // close it, as Settings' menus do.
  private menuAction(action: Action, focused: HTMLElement | null): void {
    if (action === 'back' || action === 'left') {
      this.setMenu(false);
    } else if (action === 'up' || action === 'down') {
      this.nav.setRestrict(this.ui.querySelector<HTMLElement>('.dropdown.open .dropdown-menu'));
      this.nav.move(action);
      this.nav.setRestrict(null);
    } else if (action === 'select' && focused) {
      this.activate(focused);
    }
  }

  // A new transponder starts from the form, its frequency ready to type.
  private startNewTransponder(): void {
    this.menuOpen = false;
    this.newTp = true;
    this.render();
    this.refocus('sat-tools-frequency');
  }

  private pickTransponder(value: string): void {
    this.menuOpen = false;
    const picked = this.knownTransponders.find(item => String(item.id) === value);
    if (!picked) {
      this.render();
      this.refocus('sat-tools-tp:trigger');
      return;
    }
    this.newTp = false;
    this.form = {
      frequency: picked.frequency,
      polarization: picked.polarization === 'V' ? 'V' : 'H',
      symbolRate: picked.symbolRate || this.form.symbolRate,
      system: picked.system === 'DVB-S' ? 'DVB-S' : 'DVB-S2',
    };
    this.formChanged();
    this.refocus('sat-tools-tp:trigger');
  }

  // --- Transponder list ------------------------------------------------------

  private openTpManager(id: string | undefined): void {
    const config = this.configs?.find(item => String(item.id) === id);
    if (!config || SatelliteScanSession.state.phase !== 'idle') return;
    this.tpManager = { configId: config.id, selected: new Set() };
    this.satChannels = null;
    void this.loadTransponders(config);
    void this.loadSatChannels();
    this.render();
    this.focusFirst();
  }

  private async loadSatChannels(): Promise<void> {
    const load = await BroadcastService.loadChannels();
    this.satChannels = load.ok && load.route !== 'sample' ? load.channels : [];
    if (this.active) this.render();
  }

  private managedChannels(config: SatelliteConfig): ReturnType<typeof channelsByTransponder> | null {
    const list = this.transponders.get(config.id);
    return list && this.satChannels ? channelsByTransponder(this.satChannels, config.satelliteName, list) : null;
  }

  private closeTpManager(): void {
    const manager = this.tpManager;
    this.tpManager = null;
    this.satChannels = null;
    this.render();
    if (manager) this.refocus(`sat-tools-tps:${String(manager.configId)}`);
  }

  private managedConfig(): SatelliteConfig | null {
    const manager = this.tpManager;
    return manager ? this.configs?.find(item => item.id === manager.configId) ?? null : null;
  }

  private toggleTp(id: string | undefined): void {
    const manager = this.tpManager;
    const value = Number(id);
    if (!manager || !id || !isFinite(value)) return;
    if (manager.selected.has(value)) manager.selected.delete(value);
    else manager.selected.add(value);
    this.render();
  }

  private selectAllTps(): void {
    const manager = this.tpManager;
    const list = manager ? this.transponders.get(manager.configId) ?? [] : [];
    if (!manager || !list.length) return;
    manager.selected = manager.selected.size === list.length ? new Set() : new Set(list.map(item => item.id));
    this.render();
  }

  private confirmTpDelete(all: boolean): void {
    const manager = this.tpManager;
    const config = this.managedConfig();
    if (!manager || !config || this.deleting) return;
    const list = this.transponders.get(config.id) ?? [];
    const targets = all ? list : list.filter(item => manager.selected.has(item.id));
    if (!targets.length) return;
    const grouped = this.managedChannels(config);
    const channels = grouped ? targets.reduce<BroadcastChannel[]>((sum, item) => sum.concat(grouped.on.get(item.id) ?? []), []) : [];
    this.prompt.show({
      title: tp('satelliteTools.deleteTpTitle', targets.length),
      message: [
        t('satelliteTools.deleteTpBody', { satellite: config.satelliteName }),
        channels.length ? t('satelliteTools.deleteTpChannels', { count: channels.length }) : '',
      ].filter(Boolean).join(' '),
      confirmLabel: t('common.delete'),
      cancelLabel: t('common.cancel'),
      onConfirm: () => { void this.deleteTransponders(config, targets, channels, all ? 'tpm-delete-all' : 'tpm-delete'); },
      onCancel: () => this.refocus(all ? 'tpm-delete-all' : 'tpm-delete'),
    });
  }

  private confirmOrphanDelete(): void {
    const config = this.managedConfig();
    const grouped = config ? this.managedChannels(config) : null;
    if (!config || !grouped || !grouped.orphans.length || this.deleting) return;
    const orphans = grouped.orphans;
    this.prompt.show({
      title: tp('satelliteTools.deleteChannelsTitle', orphans.length),
      message: t('satelliteTools.deleteChannelsBody'),
      confirmLabel: t('common.delete'),
      cancelLabel: t('common.cancel'),
      onConfirm: () => { void this.deleteTransponders(config, [], orphans, 'tpm-orphans'); },
      onCancel: () => this.refocus('tpm-orphans'),
    });
  }

  // Transponders go first; their channels only once they are gone, so a
  // refused delete leaves both as they were.
  private async deleteTransponders(
    config: SatelliteConfig,
    targets: Transponder[],
    channels: BroadcastChannel[],
    button: NonNullable<SatelliteTools['deleting']>,
  ): Promise<void> {
    this.deleting = button;
    this.render();
    this.refocus(button);
    const ok = await SatelliteScan.deleteTransponders(config, targets);
    const channelsOk = ok && channels.length ? await SatelliteScan.deleteChannels(channels.map(item => item.id)) : true;
    // The TV's lists are read again, whatever it answered.
    this.transponders.delete(config.id);
    await Promise.all([this.loadTransponders(config), channels.length ? this.loadSatChannels() : Promise.resolve()]);
    if (channels.length) this.options.onChannelsChanged();
    this.deleting = null;
    if (!this.active) return;
    const manager = this.tpManager;
    if (manager && manager.configId === config.id) {
      const left = new Set((this.transponders.get(config.id) ?? []).map(item => item.id));
      manager.selected = new Set(Array.from(manager.selected).filter(id => left.has(id)));
    }
    if (!ok) showToast(t('satelliteTools.deleteTpFailed'));
    else if (!channelsOk) showToast(t('satelliteTools.deleteChannelsFailed'));
    this.render();
    this.focusFirst();
  }

  // --- Text fields -----------------------------------------------------------

  private caretInput(): HTMLInputElement | null {
    const active = document.activeElement;
    return active instanceof HTMLInputElement && this.ui.contains(active) ? active : null;
  }

  private onFieldKey(event: KeyboardEvent): void {
    const input = event.target as HTMLInputElement;
    if (input.tagName !== 'INPUT' || !input.dataset.number) return;
    const back = event.key === 'Escape' || event.keyCode === CONFIG.KEYS.BACK;
    const up = event.key === 'ArrowUp' || event.keyCode === CONFIG.KEYS.UP;
    const down = event.key === 'ArrowDown' || event.keyCode === CONFIG.KEYS.DOWN;
    if (event.key !== 'Enter' && !up && !down && !back) return;
    event.preventDefault();
    event.stopPropagation();
    // Back leaves the value as it was.
    if (back) input.value = String(this.form[input.dataset.number as NumberField]);
    input.blur();
    this.nav.focus(input);
    if (up || down) this.nav.move(up ? 'up' : 'down');
  }

  // A typed value in range replaces the form's; anything else puts it back.
  private commitField(input: HTMLInputElement): void {
    const field = input.dataset.number as NumberField;
    const spec = NUMBER_FIELDS[field];
    const value = parseInt(input.value.replace(/\D/g, ''), 10);
    if (isFinite(value) && value >= spec.min && value <= spec.max && value !== this.form[field]) {
      this.form = { ...this.form, [field]: value };
      this.formChanged();
      return;
    }
    input.value = String(this.form[field]);
  }

  // --- Digits --------------------------------------------------------------

  private onFocus(el: HTMLElement | null): void {
    const field = el ? el.dataset.number as NumberField | undefined : undefined;
    if (!field || (this.editing && this.editing.field !== field)) this.commitDigits(true);
    KeyHandler.setDigitSink(field ? (digit) => this.typeDigit(field, digit)
      : this.tool === 'manager' ? this.manager.digitSinkFor(el) : null);
    if (this.tool === 'manager') this.manager.trackFocus(el);
  }

  // The first digit replaces the value, the next ones extend it, as on a
  // receiver; the value commits at its full length or once typing pauses.
  private typeDigit(field: NumberField, digit: number): void {
    const spec = NUMBER_FIELDS[field];
    const text = this.editing && this.editing.field === field ? this.editing.text + String(digit) : String(digit);
    this.editing = { field, text };
    if (this.digitTimer) clearTimeout(this.digitTimer);
    if (text.length >= spec.digits) {
      this.commitDigits(true);
      return;
    }
    this.digitTimer = setTimeout(() => this.commitDigits(true), DIGIT_COMMIT_MS);
    this.render();
  }

  private commitDigits(retune: boolean): void {
    if (this.digitTimer) clearTimeout(this.digitTimer);
    this.digitTimer = null;
    const editing = this.editing;
    if (!editing) return;
    this.editing = null;
    const spec = NUMBER_FIELDS[editing.field];
    const value = parseInt(editing.text, 10);
    if (isFinite(value) && value >= spec.min && value <= spec.max) {
      this.form = { ...this.form, [editing.field]: value };
      if (retune) this.formChanged();
      return;
    }
    // Out of range: the old value stays.
    if (this.active) this.render();
  }

  // --- Focus helpers -------------------------------------------------------

  private refocus(key: string): void {
    const el = this.ui.querySelector<HTMLElement>(`[data-key="${key}"]`);
    if (el) this.nav.focus(el);
    else this.focusFirst();
  }

  private focusFirst(): void {
    const el = this.ui.querySelector<HTMLElement>('.sat-tools-content [data-focusable]')
      ?? this.ui.querySelector<HTMLElement>('[data-focusable]');
    this.nav.focus(el);
  }

  // --- Rendering -----------------------------------------------------------

  private render(): void {
    if (!this.active) return;
    // No picture or signal while a scan runs: the tuner is the scan's.
    const showLive = this.loadState === 'ready' && this.tool === 'finder' && !SatelliteScanSession.busy;
    const managing = this.tool === 'manager' && !SatelliteScanSession.busy;
    morph(this.ui, html`
      <div class="settings-view sat-tools">
        <nav class="settings-sidebar" data-nav-container aria-label="${t('satelliteTools.title')}">
          <h2 class="settings-title">${t('satelliteTools.title')}</h2>
          <div class="settings-nav-list">
            ${SATELLITE_TOOLS.map(item => html`
              <button class="settings-nav-item ${item.id === this.tool ? 'active' : ''}" data-focusable
                      data-key="tool:${item.id}" data-tool="${item.id}">
                <span class="settings-nav-icon">${raw(item.icon)}</span>
                <span>${t(item.label)}</span>
              </button>`)}
          </div>
        </nav>
        <div class="settings-main">
          <div class="settings-scroll sat-tools-scroll ${managing ? 'sat-cm-page' : ''}">
            <div class="sat-tools-layout ${showLive ? '' : 'wide'}">
              <div class="sat-tools-content" data-nav-container>${this.renderContent()}</div>
              ${showLive ? this.renderLive() : ''}
            </div>
          </div>
        </div>
      </div>
    `);
    // A field's typed value outlives its attribute, so a field not being
    // typed in is set to what the form holds.
    this.ui.querySelectorAll<HTMLInputElement>('input[data-number]').forEach((input) => {
      const value = input.getAttribute('value') ?? '';
      if (input !== document.activeElement && input.value !== value) input.value = value;
    });
    if (managing) this.manager.syncFields();
    this.video.showPreview();
    this.scheduleShareSettings();
  }

  private renderContent(): Safe {
    const tool = SATELLITE_TOOLS.find(item => item.id === this.tool) ?? SATELLITE_TOOLS[0];
    const head = html`
      <h3 class="settings-section-title">${t(tool.label)}</h3>
      <p class="settings-item-hint sat-tools-lead">${t(tool.hint)}</p>`;
    if (this.tool === 'manager' && !SatelliteScanSession.busy) return html`${head}${this.manager.render()}`;
    if (this.loadState === 'loading') return html`${head}<p class="sat-tools-empty">${t('common.loading')}</p>`;
    if (this.loadState === 'unavailable') {
      return html`${head}<p class="sat-tools-empty">${t('satelliteTools.unavailable')}</p>`;
    }
    if (!this.configs || !this.configs.length) {
      return html`${head}<p class="sat-tools-empty">${t('satelliteTools.noSatellites')}</p>`;
    }
    if (this.tool !== 'scan' && SatelliteScanSession.busy) {
      return html`${head}
        <p class="sat-tools-empty">${t('satelliteTools.busy')}</p>
        <div class="settings-item settings-item--action sat-tools-action">
          <button class="btn btn-primary" data-focusable data-key="sat-tools-see-scan" data-tool="scan">${
            t('satelliteTools.seeProgress')}</button>
        </div>`;
    }
    const managed = this.tool === 'scan' && SatelliteScanSession.state.phase === 'idle' ? this.managedConfig() : null;
    if (managed) return this.renderTpManager(managed);
    return html`${head}${this.tool === 'scan' ? this.renderScan() : this.renderTuneForm()}`;
  }

  // OK opens the TV keyboard; the remote's digits type in it directly.
  private inputField(field: NumberField, label: TextMessageKey, key: string): Safe {
    const editing = this.editing && this.editing.field === field ? this.editing.text : null;
    return html`
      <div class="settings-item">
        <div class="settings-item-title">${t(label)}</div>
        <input type="text" inputmode="numeric" maxlength="5" autocomplete="off"
               class="settings-input sat-tools-input ${editing !== null ? 'editing' : ''}" data-focusable
               data-key="${key}" data-number="${field}" value="${editing ?? String(this.form[field])}">
      </div>`;
  }

  private lnbStepper(config: SatelliteConfig, key: string, extra: string): Safe {
    return html`
      <button class="sat-tools-number sat-tools-stepper sat-tools-lnb ${extra}" data-focusable
              data-key="${key}" data-stepper="lnb" data-config="${config.id}">
        <span class="sat-tools-chevron">${raw(chevronLeftIcon())}</span>
        <span class="sat-tools-number-value">${lnbLabel(config)}</span>
        <span class="sat-tools-chevron">${raw(chevronRightIcon())}</span>
      </button>`;
  }

  // The satellite's LNB setup, as LG's satellite settings lay it out.
  private renderLnb(config: SatelliteConfig): Safe {
    const locked = toneLocked(config);
    return html`
      <div class="sat-tools-grid">
        <div class="settings-item">
          <div class="settings-item-title">${t('satelliteTools.lnb')}</div>
          ${this.lnbStepper(config, 'sat-tools-lnb', '')}
        </div>
        <div class="settings-item sat-tools-port">
          <div class="settings-item-title">${t('satelliteTools.diseqc')}</div>
          ${toggleGroup(`sat-tools-diseqc-${String(config.id)}`,
            DISEQC_PORTS.map(port => ({ value: port, label: diseqcLabel(port) })), config.diseqc)}
        </div>
      </div>
      <div class="sat-tools-grid">
        <div class="settings-item">
          <div class="settings-item-title">${t('satelliteTools.tone')}</div>
          ${toggleGroup('sat-tools-tone', TONES.map(tone => ({ value: tone.value, label: tone.label || t('common.off') })),
            locked ? 'OFF_22KHZTONE' : config.tone, locked ? TONES.map(tone => tone.value) : [])}
        </div>
        <div class="settings-item">
          <div class="settings-item-title">${t('satelliteTools.lnbPower')}</div>
          <span class="sat-tools-switch" data-action="lnb-power">${
            sourceToggle(config.lnbPower, 'sat-tools-lnb-power')}</span>
        </div>
      </div>
      <div class="settings-item-hint sat-tools-lnb-hint">${t('satelliteTools.lnbSaved')}</div>`;
  }

  private renderTuneForm(): Safe {
    const configs = this.configs ?? [];
    const config = this.config;
    const known = this.knownTransponders;
    const selected = this.selectedTp();
    const options = known.map(item => ({ value: String(item.id), label: transponderLabel(item) }));
    return html`
      <div class="settings-item">
        <div class="settings-item-title">${t('satelliteTools.satellite')}</div>
        ${toggleGroup('sat-tools-satellite',
          configs.map(item => ({ value: String(item.id), label: item.satelliteName })),
          config ? String(config.id) : '')}
      </div>
      ${config ? this.renderLnb(config) : ''}
      <div class="settings-item sat-tools-tp">
        <div class="settings-item-title">${t('satelliteTools.transponder')}</div>
        <div class="sat-tools-tp-pick">
          ${dropdown('sat-tools-tp', options, selected, this.menuOpen, transponderLabel({ id: 0, ...this.form }))}
          <button class="btn sat-tools-new-tp" data-focusable
                  data-key="sat-tools-new-tp" data-action="new-tp"
                  aria-pressed="${selected === 'new' ? 'true' : 'false'}">${t('satelliteTools.newTransponder')}</button>
        </div>
        <div class="settings-item-hint">${tp('satelliteTools.transponderCount', known.length)}</div>
      </div>
      <div class="sat-tools-grid">
        ${selected === 'new' ? this.inputField('frequency', 'satelliteTools.frequency', 'sat-tools-frequency') : ''}
        ${this.inputField('symbolRate', 'satelliteTools.symbolRate', 'sat-tools-symbol-rate')}
      </div>
      <div class="settings-item-hint sat-tools-digits-hint">${t('satelliteTools.digitsHint')}</div>
      <div class="sat-tools-grid">
        <div class="settings-item">
          <div class="settings-item-title">${t('satelliteTools.polarization')}</div>
          ${toggleGroup('sat-tools-pol', [
            { value: 'H', label: t('satelliteTools.horizontal') },
            { value: 'V', label: t('satelliteTools.vertical') },
          ], this.form.polarization)}
        </div>
        <div class="settings-item">
          <div class="settings-item-title">${t('satelliteTools.system')}</div>
          ${toggleGroup('sat-tools-system', [
            { value: 'DVB-S', label: 'DVB-S' },
            { value: 'DVB-S2', label: 'DVB-S2' },
          ], this.form.system)}
        </div>
      </div>
      ${this.renderTpScanAction()}
      ${this.renderSaveAction()}
      ${this.renderShare()}`;
  }

  private renderShare(): Safe {
    const state = FinderShare.state;
    const url = FinderShare.viewerUrl;
    const status = state === 'connecting' ? t('finderShare.connecting')
      : state === 'reconnecting' ? t('finderShare.reconnecting')
      : state === 'failed' ? t('finderShare.failed') : '';
    return html`
      <div class="settings-item sat-tools-share">
        <div class="sat-tools-row">
          <div class="sat-tools-row-text">
            <div class="sat-tools-row-title">${t('finderShare.title')}</div>
            <div class="settings-item-hint">${t('finderShare.hint')}</div>
          </div>
          <span class="sat-tools-switch" data-action="share">${
            sourceToggle(FinderShare.active && state !== 'failed', 'sat-tools-share')}</span>
        </div>
        ${state !== 'off' ? html`
          <div class="sat-tools-share-card" data-key="sat-tools-share-card">
            ${url ? html`<img class="setup-qr sat-tools-share-qr" alt="${t('settings.qrAlt', { url })}" src="${qrDataUrl(url)}">` : ''}
            <div class="sat-tools-share-text">
              ${url ? html`<div class="sat-tools-row-title">${t('settings.setupScanQr')}</div>` : ''}
              ${status ? html`<div class="settings-item-hint ${state === 'failed' ? 'sat-tools-error' : ''}">${status}</div>` : ''}
              ${url ? html`<div class="settings-item-hint">${t('finderShare.relayNote')}</div>` : ''}
            </div>
          </div>` : ''}
      </div>`;
  }

  private renderSaveAction(): Safe {
    const result = this.saveResult;
    const labels: Record<SatelliteSetting, TextMessageKey> = {
      lnb: 'satelliteTools.lnb', diseqc: 'satelliteTools.diseqc', tone: 'satelliteTools.tone',
      lnbPower: 'satelliteTools.lnbPower', transponder: 'satelliteTools.transponder',
    };
    const message = result === 'saving' ? ''
      : result === 'failed' ? t('satelliteTools.saveToTvFailed')
      : result && result.length ? t('satelliteTools.saveToTvUnkept', { settings: result.map(item => t(labels[item])).join(', ') })
      : result ? t('satelliteTools.saveToTvChecked') : '';
    const error = result === 'failed' || (Array.isArray(result) && result.length > 0);
    return html`
      <div class="settings-item settings-item--action sat-tools-action">
        <button class="btn" data-focusable data-key="sat-tools-save" data-action="save-to-tv"
                ${result === 'saving' ? raw('aria-disabled="true"') : ''}>${t('satelliteTools.saveToTv')}</button>
        ${message ? html`<div class="settings-item-hint ${error ? 'sat-tools-error' : ''}">${message}</div>` : ''}
      </div>`;
  }

  private renderTpScanAction(): Safe {
    const result = this.tpResult;
    const message = result === 'saving' ? t('satelliteTools.scanning')
      : result === 'failed' ? t('satelliteTools.tpScanFailed')
      : result ? t('satelliteTools.tpScanResult', { tv: result.tv, radio: result.radio })
      : t('satelliteTools.orderKept');
    return html`
      <div class="settings-item settings-item--action sat-tools-action">
        <button class="btn btn-primary" data-focusable data-key="sat-tools-tp-scan" data-action="tp-scan"
                ${result === 'saving' ? raw('aria-disabled="true"') : ''}>${t('satelliteTools.scanTransponder')}</button>
        <div class="settings-item-hint ${result === 'failed' ? 'sat-tools-error' : ''}">${message}</div>
      </div>`;
  }

  private renderScan(): Safe {
    if (SatelliteScanSession.state.phase !== 'idle') return this.renderScanProgress();
    const configs = this.configs ?? [];
    const any = configs.some(config => config.selected);
    const option = (key: keyof ScanOptions, label: TextMessageKey, hint: TextMessageKey) => html`
      <div class="sat-tools-row">
        <div class="sat-tools-row-text">
          <div class="sat-tools-row-title">${t(label)}</div>
          <div class="settings-item-hint">${t(hint)}</div>
        </div>
        <span class="sat-tools-switch" data-action="option" data-option="${key}">${
          sourceToggle(this.scanOptions[key], `sat-tools-opt-${key}`)}</span>
      </div>`;
    return html`
      <div class="settings-item">
        <div class="settings-item-title">${t('satelliteTools.satellites')}</div>
        <div class="sat-tools-sat-list">
          ${configs.map(config => html`
            <div class="sat-tools-sat ${config.selected ? 'selected' : ''}" data-key="sat-row:${config.id}">
              <div class="sat-tools-sat-head">
                <span class="sat-tools-sat-name">${config.satelliteName}</span>
                <button class="btn sat-tools-tps-open" data-focusable data-key="sat-tools-tps:${config.id}"
                        data-action="tp-manage" data-config="${config.id}">${this.transpondersLabel(config)}</button>
                <span class="sat-tools-switch" data-action="cfg-toggle" data-config="${config.id}">${
                  sourceToggle(config.selected, `sat-tools-cfg:${config.id}`)}</span>
              </div>
              <div class="sat-tools-sat-controls">
              <span class="sat-tools-sat-control">
                <span class="sat-tools-sat-label">${t('satelliteTools.lnb')}</span>
                ${this.lnbStepper(config, `sat-tools-lnb:${String(config.id)}`, '')}
              </span>
              <span class="sat-tools-sat-control">
                <span class="sat-tools-sat-label">${t('satelliteTools.diseqc')}</span>
                ${toggleGroup(`sat-tools-diseqc-${String(config.id)}`,
                  DISEQC_PORTS.map(port => ({ value: port, label: diseqcLabel(port) })), config.diseqc)}
              </span>
              </div>
            </div>`)}
        </div>
      </div>
      <div class="settings-item">
        <div class="settings-item-title">${t('satelliteTools.options')}</div>
        ${option('network', 'satelliteTools.networkSearch', 'satelliteTools.networkSearchHint')}
        ${option('blind', 'satelliteTools.blindSearch', 'satelliteTools.blindSearchHint')}
        ${option('freeOnly', 'satelliteTools.freeOnly', 'satelliteTools.freeOnlyHint')}
        ${option('skipRadio', 'satelliteTools.skipRadio', 'satelliteTools.skipRadioHint')}
        <div class="sat-tools-row">
          <div class="sat-tools-row-text">
            <div class="sat-tools-row-title">${t('satelliteTools.keepOrder')}</div>
            <div class="settings-item-hint">${t('satelliteTools.keepOrderHint')}</div>
          </div>
          <span class="sat-tools-switch" data-action="order">${
            sourceToggle(this.orderMode === 'keep', 'sat-tools-opt-keepOrder')}</span>
        </div>
      </div>
      <div class="settings-item settings-item--action sat-tools-action">
        <button class="btn btn-primary" data-focusable data-key="scan-start" data-action="scan-start"
                ${any && !this.wiping ? '' : raw('aria-disabled="true"')}>${t('satelliteTools.startScan')}</button>
      </div>
      <div class="settings-item sat-tools-row sat-tools-wipe">
        <div class="sat-tools-row-text">
          <div class="sat-tools-row-title">${t('satelliteTools.deleteAllChannels')}</div>
          <div class="settings-item-hint">${t('satelliteTools.deleteAllChannelsHint')}</div>
        </div>
        <button class="btn btn-danger" data-focusable data-key="sat-tools-wipe" data-action="wipe"
                ${this.wiping ? raw('aria-disabled="true" aria-busy="true"') : ''}>${this.wiping
                  ? html`<span class="sat-tools-spinner" aria-hidden="true"></span>${t('satelliteTools.deleting')}`
                  : t('satelliteTools.deleteAllChannels')}</button>
      </div>`;
  }

  private transpondersLabel(config: SatelliteConfig): string {
    const list = this.transponders.get(config.id);
    return list ? `${t('satelliteTools.transponders')} · ${String(list.length)}` : t('satelliteTools.transponders');
  }

  // One satellite's transponders, to pick and delete; Back returns to the scan.
  private renderTpManager(config: SatelliteConfig): Safe {
    const list = this.transponders.get(config.id);
    const selected = this.tpManager ? this.tpManager.selected : new Set<number>();
    const all = !!list && list.length > 0 && selected.size === list.length;
    const busy = this.deleting ? raw('aria-disabled="true" aria-busy="true"') : '';
    // The pressed delete shows it is working; the rest wait for it.
    const label = (key: NonNullable<SatelliteTools['deleting']>, text: string): Safe => (this.deleting === key
      ? html`<span class="sat-tools-spinner" aria-hidden="true"></span>${t('satelliteTools.deleting')}` : html`${text}`);
    const head = html`
      <h3 class="settings-section-title">${config.satelliteName}</h3>
      <p class="settings-item-hint sat-tools-lead">${t('satelliteTools.transponders')}${
        list ? ` · ${String(list.length)}` : ''}</p>`;
    if (!list) return html`${head}<p class="sat-tools-empty">${t('common.loading')}</p>`;
    const grouped = this.managedChannels(config);
    const orphans = grouped && grouped.orphans.length ? html`
      <div class="sat-tools-row sat-tools-tpm-orphans">
        <div class="sat-tools-row-text">
          <div class="sat-tools-row-title">${tp('satelliteTools.orphanChannels', grouped.orphans.length)}</div>
          <div class="settings-item-hint">${t('satelliteTools.orphanChannelsHint')}</div>
        </div>
        <button class="btn btn-danger" data-focusable data-key="tpm-orphans" data-action="tpm-orphans" ${busy}>${
          label('tpm-orphans', t('satelliteTools.deleteChannels'))}</button>
      </div>` : '';
    if (!list.length) return html`${head}<p class="sat-tools-empty">${t('satelliteTools.noTransponders')}</p>${orphans}`;
    return html`${head}${orphans}
      <div class="sat-tools-tpm-actions">
        <button class="btn" data-focusable data-key="tpm-select-all" data-action="tpm-select-all" ${busy}>${
          t(all ? 'channel.favoriteDeselectAll' : 'channel.favoriteSelectAll')}</button>
        <button class="btn btn-danger" data-focusable data-key="tpm-delete" data-action="tpm-delete"
                ${this.deleting ? busy : selected.size ? '' : raw('aria-disabled="true"')}>${
          label('tpm-delete', t('satelliteTools.deleteSelected', { count: selected.size }))}</button>
        <button class="btn btn-danger" data-focusable data-key="tpm-delete-all" data-action="tpm-delete-all" ${busy}>${
          label('tpm-delete-all', t('satelliteTools.deleteAll'))}</button>
      </div>
      <div class="sat-tools-tpm-list">
        ${list.map((item) => {
          const on = selected.has(item.id);
          return html`
            <button class="sat-tools-tpm-row ${on ? 'favorite-selected' : ''}" data-focusable data-key="tpm:${item.id}"
                    data-action="tpm-toggle" data-tp="${item.id}" aria-pressed="${on ? 'true' : 'false'}" ${busy}>
              <span class="favorite-checkbox">${on ? raw(CHECK_ICON) : ''}</span>
              <span class="sat-tools-tpm-label">${transponderLabel(item)}</span>
              ${grouped ? html`<span class="sat-tools-tpm-count">${
                tp('channel.count', (grouped.on.get(item.id) ?? []).length)}</span>` : ''}
            </button>`;
        })}
      </div>`;
  }

  private satelliteName(configurationId: number): string {
    const config = this.configs?.find(item => item.id === configurationId);
    return config ? config.satelliteName : '';
  }

  private renderScanProgress(): Safe {
    const state = SatelliteScanSession.state;
    const running = state.phase === 'running' || state.phase === 'stopping';
    const title = state.phase === 'failed' ? t('satelliteTools.scanFailed')
      : running ? t('satelliteTools.scanning')
      : state.phase === 'finishing' ? t('satelliteTools.finishing')
      : state.stoppedByUser ? t('satelliteTools.scanStopped') : t('satelliteTools.scanDone');
    const seconds = Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000));
    const elapsed = `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`;
    const current = state.feed ? state.feed.current : null;
    const counts = scanCounts(state);
    const unlocked = !!current && (current.state === 'UNLOCK' || current.state === 'UNLOCKED');
    const added = state.added;
    const fresh = new Set(state.fresh);
    return html`
      <div class="sat-tools-progress" data-key="scan-progress">
        <div class="sat-tools-progress-head">
          <span class="sat-tools-progress-title">${title}</span>
          ${running ? html`<span class="sat-tools-progress-value">${String(state.progress)}%</span>` : ''}
        </div>
        ${state.phase === 'failed' && state.error ? html`
          <div class="settings-item-hint sat-tools-error">${state.error}</div>` : ''}
        ${state.phase !== 'failed' ? html`
          <div class="sat-meter-bar sat-tools-progress-bar"><div style="width:${String(running ? state.progress : 100)}%"></div></div>
          ${running ? html`
            <div class="sat-tools-now" data-key="scan-now">
              <span class="sat-tools-now-label">${t('satelliteTools.current')}</span>
              <span class="sat-tools-now-value">${current && current.transponder
                ? `${this.satelliteName(current.configurationId)} · ${transponderLabel(current.transponder)}` : '–'}</span>
              ${current ? html`<span class="sat-tools-lock sat-tools-lock-inline" data-state="${unlocked ? 'nolock' : 'locked'}">${
                unlocked ? t('satelliteTools.noLock')
                  : current.state === 'COMPLETED' ? t('satelliteTools.scanDone') : t('satelliteTools.locked')}</span>` : ''}
            </div>` : ''}
          <div class="sat-tools-found">
            ${running ? html`<span class="sat-chip">${t('satelliteTools.elapsed', { time: elapsed })}</span>` : ''}
            <span class="sat-chip">${t('satellite.tv')} ${String(counts.tv)}</span>
            ${state.skipRadio ? '' : html`<span class="sat-chip">${t('satellite.radio')} ${String(counts.radio)}</span>`}
            ${!running && state.removed ? html`<span class="sat-chip">${tp('satelliteTools.removedCount', state.removed)}</span>` : ''}
          </div>` : ''}
        ${!running && state.report.length ? html`
          <div class="sat-tools-report">
            ${counts.satellites.map(entry => html`
              <div class="sat-tools-report-row">
                <span>${entry.satelliteName}</span>
                <span>${tp('channel.count', entry.channels)}</span>
              </div>`)}
          </div>` : ''}
      </div>
      <div class="settings-item settings-item--action sat-tools-action">
        ${running
          ? html`<button class="btn" data-focusable data-key="scan-stop" data-action="scan-stop"
                  ${state.phase === 'stopping' ? raw('aria-disabled="true"') : ''}>${t('satelliteTools.stopScan')}</button>`
          : html`<button class="btn btn-primary" data-focusable data-key="scan-done" data-action="scan-done"
                  ${state.phase === 'finishing' ? raw('aria-disabled="true"') : ''}>${t('satelliteTools.done')}</button>`}
        ${running ? html`<div class="settings-item-hint">${t('satelliteTools.backgroundHint')}</div>` : ''}
      </div>
      ${added && added.length ? html`
        <div class="settings-item sat-tools-log" data-key="scan-added">
          <div class="settings-item-title">${t('satelliteTools.addedChannels')} · ${String(added.length)}</div>
          <div class="sat-tools-scroller" data-scroller data-key="scan-added-list">
            ${added.slice().reverse().map((channel, index) => html`
              <div class="sat-tools-log-row" data-key="added:${channel.id}">
                <span class="sat-tools-log-tp"><span class="sat-tools-added-index">${String(added.length - index)}</span>${channel.name}${
                  fresh.has(channel.serviceKey) ? html`<span class="sat-tools-new">${t('satelliteTools.newTag')}</span>` : ''}</span>
                <span class="sat-tools-added-kind">${addedDetail(channel)}</span>
              </div>`)}
          </div>
        </div>` : ''}`;
  }

  private renderLive(): Safe {
    const signal = this.signal;
    const state = this.liveLock();
    const label = state === 'locked' ? t('satelliteTools.locked')
      : state === 'nolock' ? t('satelliteTools.noLock') : t('satelliteTools.searching');
    const config = this.config;
    // Shown only while no scan runs, so it names the finder's transponder.
    const tuned = this.tool !== 'scan' && config
        ? `${config.satelliteName} · ${transponderLabel({ id: 0, ...this.form })}`
        : '–';
    const meter = (title: TextMessageKey, value: number | null) => {
      const level = signalLevel(value);
      return html`
        <div class="sat-meter sat-tools-meter" data-level="${level}">
          <div class="sat-meter-top">
            <span class="sat-meter-label">${t(title)}</span>
            <span class="sat-meter-value">${value === null ? '–' : `${String(value)}%`}</span>
          </div>
          <div class="sat-meter-bar"><div style="width:${String(value ?? 0)}%"></div></div>
        </div>`;
    };
    return html`
      <aside class="sat-tools-live" data-key="sat-tools-live">
        <div class="sat-tools-slot" data-key="sat-tools-slot">
          <span class="sat-tools-lock" data-state="${state}">${label}</span>
        </div>
        <div class="sat-tools-live-card" data-key="sat-tools-live-card">
        ${meter('satellite.signalStrength', signal ? signal.strength : null)}
        ${meter('satellite.signalQuality', signal ? signal.quality : null)}
        <div class="sat-tools-facts">
          <div><span>${t('satelliteTools.ber')}</span><span>${signal && signal.ber !== null ? signal.ber.toExponential(1) : '–'}</span></div>
          <div><span>${t('satelliteTools.transponder')}</span><span>${tuned}</span></div>
        </div>
        </div>
      </aside>`;
  }
}
