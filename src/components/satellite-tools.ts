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
  type SatelliteConfig,
  type SignalReading,
  type TuneRequest,
} from '../services/satellite-scan';
import { BroadcastService } from '../services/broadcast-service';
import { BroadcastCache } from '../services/broadcast-cache';
import {
  captureLineup,
  SatelliteScanSession,
  type OrderMode,
  type ScanOptions,
} from '../services/satellite-scan-session';
import { FinderShare, type FinderReading } from '../services/finder-share';
import { signalLevel, type ViewerLabels } from '../services/finder-share-protocol';
import { InputMode } from '../navigation/input-mode';
import { qrDataUrl } from '../utils/qr';
import { BroadcastVideo } from './broadcast-video';
import { ConfirmationPrompt } from './confirmation-prompt';
import { toggleGroup, sourceToggle } from './toggle-controls';
import { chevronLeftIcon, chevronRightIcon, TAB_SATELLITE_ICON } from './icons';
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
// A saved transponder shows up in the TV's list within a few seconds.
const TP_COUNT_ATTEMPTS = 4;
const TP_COUNT_DELAY_MS = 2500;
export type SatelliteTool = 'finder' | 'tpscan' | 'scan';

const TOOLS: ReadonlyArray<{ id: SatelliteTool; label: TextMessageKey; hint: TextMessageKey }> = [
  { id: 'finder', label: 'satelliteTools.signalFinder', hint: 'satelliteTools.signalFinderHint' },
  { id: 'tpscan', label: 'satelliteTools.tpScan', hint: 'satelliteTools.tpScanHint' },
  { id: 'scan', label: 'satelliteTools.channelScan', hint: 'satelliteTools.channelScanHint' },
];

type NumberField = 'frequency' | 'symbolRate';

const NUMBER_FIELDS: Record<NumberField, { min: number; max: number; step: number; digits: number }> = {
  frequency: { min: 3000, max: 13000, step: 1, digits: 5 },
  symbolRate: { min: 1000, max: 45000, step: 1, digits: 5 },
};

// A scroller moves this far per Up or Down.
const SCROLL_STEP_PX = 132;
// The QR stays clear of the screen's bottom edge, which overscan may crop.
export const SHARE_GUTTER_PX = 40;

// How far to scroll so a block shows whole with a gutter below it, without
// pushing its top out of view; 0 when it already shows.
export function revealDelta(view: { top: number; bottom: number }, box: { top: number; bottom: number }, gutter: number): number {
  return Math.max(0, Math.min(box.bottom + gutter - view.bottom, box.top - view.top));
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

function formMatches(transponder: Transponder, form: TuneRequest): boolean {
  return Math.abs(transponder.frequency - form.frequency) <= 3 && transponder.polarization === form.polarization;
}

interface SatelliteToolsOptions {
  onRevealTabBar: (dir: 'up' | 'left') => void;
  onBack: () => void;
  // A scan changed the TV's channel list.
  onChannelsChanged: () => void;
}

/**
 * Satellite tools, opened from Settings and laid out like it: a signal
 * finder that tunes a transponder and shows its signal live, a transponder
 * scan that adds one transponder's channels, and a channel scan of whole
 * satellites with each one's LNB and DiSEqC port. A live tuner card (the
 * picture, lock, strength, quality, and bit error rate) stays beside every
 * tool. Satellite and transponder names come from the TV, through `html`.
 */
export class SatelliteTools {
  readonly focusScope: FocusScope;
  private readonly stage: HTMLElement;
  private readonly ui: HTMLElement;
  private readonly video: BroadcastVideo;
  private readonly nav: SpatialNav;
  private readonly prompt = new ConfirmationPrompt('prompt.satellite-tools');

  private active = false;
  private tool: SatelliteTool = 'finder';
  private configs: SatelliteConfig[] | null = null;
  private loadState: 'loading' | 'ready' | 'unavailable' = 'loading';
  private configIndex = 0;
  private readonly transponders = new Map<number, Transponder[]>();
  private form: TuneRequest = { frequency: 11000, polarization: 'H', symbolRate: 27500, system: 'DVB-S2' };
  private editing: { field: NumberField; text: string } | null = null;
  private broadcastId: string | null = null;
  private tuned = false;
  private tuning = false;
  private signal: SignalReading | null = null;
  private tpResult: { tv: number; radio: number } | 'failed' | 'saving' | null = null;
  private scanOptions: ScanOptions = { network: true, blind: false, freeOnly: false, skipRadio: false };
  private orderMode: OrderMode = 'keep';
  private unsubscribe: (() => void) | null = null;
  private unsubscribeShare: (() => void) | null = null;
  // The scan's phase at the last render, to notice it ending.
  private seenPhase = SatelliteScanSession.state.phase;
  private token = 0;
  private digitTimer: ReturnType<typeof setTimeout> | null = null;
  private retuneTimer: ReturnType<typeof setTimeout> | null = null;
  private readingTimer: ReturnType<typeof setTimeout> | null = null;

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
      defaultKey: () => {
        const el = this.nav.focused;
        return el && this.container.contains(el) ? el.dataset.key ?? null : null;
      },
    });
    this.nav = new SpatialNav(container, el => this.onFocus(el), { scope: this.focusScope });
    container.setAttribute('data-self-activate', '');
    container.addEventListener('click', (event: MouseEvent) => {
      const control = (event.target as HTMLElement).closest<HTMLElement>('[data-focusable]');
      if (!control || !this.container.contains(control)) return;
      this.nav.focus(control, 'pointer');
      this.activate(control);
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
    const token = ++this.token;
    this.loadState = 'loading';
    this.tpResult = null;
    this.render();
    this.focusFirst();
    const configs = await SatelliteScan.configurations();
    if (token !== this.token || !this.active) return;
    if (!configs) {
      this.loadState = 'unavailable';
      this.render();
      this.focusFirst();
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
    this.render();
    this.focusFirst();
    if (config) void this.loadTransponders(config);
    this.pollReading(token);
    if (this.tool !== 'scan') await this.openPicture();
  }

  // The picture and live signal, once the tuner is free.
  private async openPicture(): Promise<void> {
    const token = this.token;
    if (this.broadcastId || this.tool === 'scan' || SatelliteScanSession.busy) return;
    this.broadcastId = await this.video.prepare();
    if (token !== this.token || !this.active) return;
    // Switched to the Satellite scan tool, or a scan began, meanwhile.
    if ((this.tool as SatelliteTool) === 'scan' || SatelliteScanSession.busy) {
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
    KeyHandler.setDigitSink(null);
    this.prompt.hide();
    // A scan goes on in the background; only this screen's picture stops.
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubscribeShare?.();
    this.unsubscribeShare = null;
    FinderShare.stop();
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
    for (const timer of [this.digitTimer, this.retuneTimer, this.readingTimer]) if (timer) clearTimeout(timer);
    this.digitTimer = null;
    this.retuneTimer = null;
    this.readingTimer = null;
  }

  private get config(): SatelliteConfig | null {
    return this.configs ? this.configs[this.configIndex] ?? null : null;
  }

  // The finder starts on the transponder the TV last used for the satellite.
  private adoptSelectedTp(config: SatelliteConfig): void {
    const selected = config.scanInfo.selectedTp as Record<string, unknown> | undefined;
    if (!selected || typeof selected.frequency !== 'number') return;
    this.form = {
      frequency: selected.frequency,
      polarization: selected.polarisation === 'VERTICAL_POLARISATION' ? 'V' : 'H',
      symbolRate: typeof selected.symbolRate === 'number' ? selected.symbolRate : 27500,
      system: selected.transmissionSystem === 'TRANSMISSIONSYSTEM_DVBS' ? 'DVB-S' : 'DVB-S2',
    };
  }

  private async loadTransponders(config: SatelliteConfig): Promise<void> {
    if (this.transponders.has(config.id)) return;
    const list = await SatelliteScan.transponders(config);
    this.transponders.set(config.id, list);
    if (this.active) this.render();
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
    if (!this.active || !config || !id || this.tool === 'scan' || SatelliteScanSession.busy) return;
    const token = this.token;
    this.tuning = true;
    this.signal = null;
    this.tpResult = null;
    this.render();
    this.shareReading();
    const ok = await SatelliteScan.tune(id, config, this.form, this.knownTransponders);
    if (token !== this.token || !this.active) return;
    this.tuning = false;
    this.tuned = this.tuned || ok;
    if (!ok) showToast(t('satellite.tuneFailed'));
    this.render();
    if (ok) this.showPicture(token, id, config);
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
        if (this.active) this.render();
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
    };
  }

  private toggleShare(): void {
    if (FinderShare.active && FinderShare.state !== 'failed') {
      FinderShare.stop();
      return;
    }
    void FinderShare.start(this.shareLabels()).then(() => this.shareReading());
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
    if (action === 'back') {
      if (this.editing) {
        this.editing = null;
        this.render();
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
    const scroller = focused && focused.closest('.sat-tools-action')
      ? this.ui.querySelector<HTMLElement>('[data-scroller]') : null;
    if ((action === 'up' || action === 'down') && scroller) {
      const before = scroller.scrollTop;
      scroller.scrollTop += action === 'down' ? SCROLL_STEP_PX : -SCROLL_STEP_PX;
      if (scroller.scrollTop !== before) return;
    }
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
    if (el.dataset.stepper === 'tp') {
      const list = this.knownTransponders;
      if (!list.length) return true;
      const at = list.findIndex(transponder => formMatches(transponder, this.form));
      const next = list[at < 0 ? (step > 0 ? 0 : list.length - 1) : (at + step + list.length) % list.length];
      this.form = {
        frequency: next.frequency,
        polarization: next.polarization === 'V' ? 'V' : 'H',
        symbolRate: next.symbolRate || this.form.symbolRate,
        system: next.system === 'DVB-S' ? 'DVB-S' : 'DVB-S2',
      };
      this.formChanged();
      return true;
    }
    if (el.dataset.stepper === 'lnb') {
      const config = this.configs?.find(item => String(item.id) === el.dataset.config);
      if (!config) return true;
      const preset = LNB_PRESETS[(lnbIndex(config) + step + LNB_PRESETS.length) % LNB_PRESETS.length];
      config.lnb = { type: preset.type, min: preset.min, max: preset.max };
      this.render();
      return true;
    }
    return false;
  }

  private formChanged(): void {
    this.tpResult = null;
    this.render();
    this.scheduleRetune();
  }

  private activate(el: HTMLElement): void {
    if (el.getAttribute('aria-disabled') === 'true') return;
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
      case 'share': this.toggleShare(); break;
      case 'cfg-toggle': this.toggleConfig(target.dataset.config); break;
      case 'option': this.toggleOption(target.dataset.option as keyof ScanOptions); break;
      case 'order':
        this.orderMode = this.orderMode === 'keep' ? 'reset' : 'keep';
        this.render();
        break;
      case 'scan-start': this.confirmScan(); break;
      case 'scan-stop': void SatelliteScanSession.stop(); break;
      case 'scan-done': this.finishScan(); break;
      case 'back': this.options.onBack(); break;
    }
  }

  private switchTool(tool: SatelliteTool): void {
    if (tool === this.tool) return;
    // The phone share belongs to the signal finder.
    if (tool !== 'finder') FinderShare.stop();
    this.tool = tool;
    this.tpResult = null;
    this.render();
    if (tool === 'scan') void this.releasePicture();
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
    } else if (groupId.indexOf('sat-tools-diseqc-') === 0) {
      const config = this.configs?.find(item => String(item.id) === groupId.slice('sat-tools-diseqc-'.length));
      if (config) config.diseqc = value;
      this.render();
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

  private finishScan(): void {
    SatelliteScanSession.dismiss();
    this.render();
    this.refocus('scan-start');
  }

  // --- Digits --------------------------------------------------------------

  private onFocus(el: HTMLElement | null): void {
    const field = el ? el.dataset.number as NumberField | undefined : undefined;
    if (!field || (this.editing && this.editing.field !== field)) this.commitDigits(true);
    KeyHandler.setDigitSink(field ? (digit) => this.typeDigit(field, digit) : null);
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
    const showLive = this.loadState === 'ready' && this.tool !== 'scan' && !SatelliteScanSession.busy;
    morph(this.ui, html`
      <div class="settings-view sat-tools">
        <nav class="settings-sidebar" data-nav-container aria-label="${t('satelliteTools.title')}">
          <h2 class="settings-title">${t('satelliteTools.title')}</h2>
          <div class="settings-nav-list">
            ${TOOLS.map(item => html`
              <button class="settings-nav-item ${item.id === this.tool ? 'active' : ''}" data-focusable
                      data-key="tool:${item.id}" data-tool="${item.id}">
                <span class="settings-nav-icon">${raw(TAB_SATELLITE_ICON)}</span>
                <span>${t(item.label)}</span>
              </button>`)}
          </div>
        </nav>
        <div class="settings-main">
          <div class="settings-scroll sat-tools-scroll">
            <div class="sat-tools-layout ${showLive ? '' : 'wide'}">
              <div class="sat-tools-content" data-nav-container>${this.renderContent()}</div>
              ${showLive ? this.renderLive() : ''}
            </div>
          </div>
        </div>
      </div>
    `);
    this.video.showPreview();
  }

  private renderContent(): Safe {
    const tool = TOOLS.find(item => item.id === this.tool) ?? TOOLS[0];
    const head = html`
      <h3 class="settings-section-title">${t(tool.label)}</h3>
      <p class="settings-item-hint sat-tools-lead">${t(tool.hint)}</p>`;
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
    return html`${head}${this.tool === 'scan' ? this.renderScan() : this.renderTuneForm()}`;
  }

  private numberField(field: NumberField, label: TextMessageKey, key: string): Safe {
    const editing = this.editing && this.editing.field === field ? this.editing.text : null;
    return html`
      <div class="settings-item">
        <div class="settings-item-title">${t(label)}</div>
        <button class="sat-tools-number ${editing !== null ? 'editing' : ''}" data-focusable
                data-key="${key}" data-number="${field}">
          <span class="sat-tools-chevron">${raw(chevronLeftIcon())}</span>
          <span class="sat-tools-number-value">${editing !== null ? html`${editing}<span class="sat-tools-caret"></span>` : String(this.form[field])}</span>
          <span class="sat-tools-chevron">${raw(chevronRightIcon())}</span>
        </button>
      </div>`;
  }

  private renderTuneForm(): Safe {
    const configs = this.configs ?? [];
    const config = this.config;
    const known = this.knownTransponders;
    const match = known.find(transponder => formMatches(transponder, this.form));
    return html`
      <div class="settings-item">
        <div class="settings-item-title">${t('satelliteTools.satellite')}</div>
        ${toggleGroup('sat-tools-satellite',
          configs.map(item => ({ value: String(item.id), label: item.satelliteName })),
          config ? String(config.id) : '')}
      </div>
      <div class="settings-item">
        <div class="settings-item-title">${t('satelliteTools.transponder')}</div>
        <button class="sat-tools-number sat-tools-stepper" data-focusable data-key="sat-tools-tp" data-stepper="tp"
                ${known.length ? '' : raw('aria-disabled="true"')}>
          <span class="sat-tools-chevron">${raw(chevronLeftIcon())}</span>
          <span class="sat-tools-number-value">${match ? transponderLabel(match) : t('satelliteTools.custom')}</span>
          <span class="sat-tools-chevron">${raw(chevronRightIcon())}</span>
        </button>
        <div class="settings-item-hint">${tp('satelliteTools.transponderCount', known.length)}</div>
      </div>
      <div class="sat-tools-grid">
        ${this.numberField('frequency', 'satelliteTools.frequency', 'sat-tools-frequency')}
        ${this.numberField('symbolRate', 'satelliteTools.symbolRate', 'sat-tools-symbol-rate')}
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
      ${this.tool === 'tpscan' ? this.renderTpScanAction() : ''}
      ${this.tool === 'finder' ? this.renderShare() : ''}`;
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
                <span class="sat-tools-switch" data-action="cfg-toggle" data-config="${config.id}">${
                  sourceToggle(config.selected, `sat-tools-cfg:${config.id}`)}</span>
              </div>
              <div class="sat-tools-sat-controls">
              <span class="sat-tools-sat-control">
                <span class="sat-tools-sat-label">${t('satelliteTools.lnb')}</span>
                <button class="sat-tools-number sat-tools-stepper sat-tools-lnb" data-focusable
                        data-key="sat-tools-lnb:${config.id}" data-stepper="lnb" data-config="${config.id}">
                  <span class="sat-tools-chevron">${raw(chevronLeftIcon())}</span>
                  <span class="sat-tools-number-value">${lnbLabel(config)}</span>
                  <span class="sat-tools-chevron">${raw(chevronRightIcon())}</span>
                </button>
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
                ${any ? '' : raw('aria-disabled="true"')}>${t('satelliteTools.startScan')}</button>
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
    // The running totals the TV reported, summed over satellites.
    const totals = new Map<number, { tv: number; radio: number }>();
    for (const status of state.feed ? state.feed.completed : []) {
      totals.set(status.configurationId, { tv: status.tv, radio: status.radio });
    }
    if (current && current.state === 'COMPLETED') totals.set(current.configurationId, { tv: current.tv, radio: current.radio });
    let liveTv = 0;
    let liveRadio = 0;
    totals.forEach((entry) => { liveTv += entry.tv; liveRadio += entry.radio; });
    const reportTv = state.report.reduce((sum, entry) => sum + entry.tv, 0);
    const reportRadio = state.report.reduce((sum, entry) => sum + entry.radio, 0);
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
            <span class="sat-chip">${t('satellite.tv')} ${String(running ? liveTv : reportTv)}</span>
            ${state.skipRadio ? '' : html`<span class="sat-chip">${t('satellite.radio')} ${String(running ? liveRadio : reportRadio)}</span>`}
            ${!running && state.removed ? html`<span class="sat-chip">${tp('satelliteTools.removedCount', state.removed)}</span>` : ''}
          </div>` : ''}
        ${!running && state.report.length ? html`
          <div class="sat-tools-report">
            ${state.report.map(entry => html`
              <div class="sat-tools-report-row">
                <span>${entry.satelliteName}</span>
                <span>${tp('channel.count', state.skipRadio ? entry.tv : entry.channels)}</span>
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
            ${added.map((channel, index) => html`
              <div class="sat-tools-log-row" data-key="added:${channel.id}">
                <span class="sat-tools-log-tp"><span class="sat-tools-added-index">${String(index + 1)}</span>${channel.name}${
                  fresh.has(channel.serviceKey) ? html`<span class="sat-tools-new">${t('satelliteTools.newTag')}</span>` : ''}</span>
                <span class="sat-tools-added-kind">${channel.kind === 'radio' ? t('satellite.radio') : t('satellite.tv')} · ${
                  channel.satellite}</span>
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
