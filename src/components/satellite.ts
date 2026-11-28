import type { Action, NumberEvent } from '../types';
import { Focus, type FocusScope, type Via } from '../navigation/focus-scope';
import { html, raw, type Safe } from '../utils/dom';
import { morph } from '../utils/morph';
import { onClockTick } from '../utils/clock';
import { formatTime } from '../utils/time';
import { VirtualList } from '../utils/virtual-list';
import { t, tp, type TextMessageKey } from '../i18n';
import { StorageService } from '../services/storage-service';
import {
  BroadcastService,
  type BroadcastChannel,
  type BroadcastProgram,
  type BroadcastRoute,
  type BroadcastStats,
  type ChannelLoad,
  type LoadFailure,
} from '../services/broadcast-service';
import { BroadcastCache, type CachedStats } from '../services/broadcast-cache';
import { applyOrder } from '../services/broadcast-order';
import { transponderLabel } from '../services/broadcast-normalize';
import { isLunaAvailable } from '../services/luna';
import { isWebOS } from '../utils/platform';
import { KeepAwake } from '../services/keep-awake';
import { BroadcastVideo, type BroadcastVideoStatus } from './broadcast-video';
import { favoriteIcon, FULLSCREEN_ICON, KEY_ICON, LIVE_CATEGORIES_ICON, LOCK_ICON, TAB_LIVE_ICON, TAB_SATELLITE_ICON } from './icons';
import { groupIcon } from './group-icon';
import { PLAYING_MARK } from './item-cards';
import { liveBadge } from './live-badge';
import { showToast } from './toast';

// Fixed row geometry: the list is virtualized, so this must match
// .channel-item's 84px height plus the 4px gap.
const ROW_STRIDE = 88;
const LIST_PADDING_TOP = 8;
// A focused channel's programs are asked for once the focus rests.
const PROGRAM_DWELL_MS = 250;
// Zapping tunes once the presses stop, so a run of CH+ crosses channels
// without retuning the dish for each one.
const ZAP_DEBOUNCE_MS = 450;
// The full-screen channel list: Live's player sidebar rows (css/player.css,
// 84px plus a 4px gap), hiding as Live's does when left alone.
const PANEL_ROW_STRIDE = 88;
const PANEL_HIDE_MS = 5000;
const UPCOMING_COUNT = 4;
// Signal and picture readings refresh this often while a channel plays.
const STATS_FIRST_MS = 1200;
const STATS_POLL_MS = 3000;
// A good channel reads "no signal" while the tuner locks; only this many bad
// readings in a row, with no good picture, mean the channel is dead (~8 s).
const DEAD_READINGS = 3;
// Strength and quality need root on webOS 10, so they refresh less often.
const RECEPTION_FIRST_MS = 1500;
const RECEPTION_POLL_MS = 6000;
const FILL_ASPECT = '16x9';
const KEEP_AWAKE = 'satellite-live';

type Area = 'groups' | 'channels' | 'preview' | 'notice';
type PreviewControl = 'favorite' | 'fullscreen' | 'livetv';
type NoticeAction = 'retry' | 'sample';
type Phase = 'idle' | 'loading' | 'ready' | 'failed';

interface SatGroup {
  id: string;
  label: string;
  icon: string;
  count: number;
}

const FAILURE_COPY: Record<LoadFailure, { title: TextMessageKey; body: TextMessageKey }> = {
  unsupported: { title: 'satellite.unsupportedTitle', body: 'satellite.unsupportedBody' },
  'no-root': { title: 'satellite.noRootTitle', body: 'satellite.noRootBody' },
  'no-channels': { title: 'satellite.noChannelsTitle', body: 'satellite.noChannelsBody' },
  'no-satellite': { title: 'satellite.noSatelliteTitle', body: 'satellite.noSatelliteBody' },
  failed: { title: 'satellite.failedTitle', body: 'satellite.failedBody' },
};

// The group rail's outline glyphs, on the group icons' 24px grid.
function outline(paths: string): string {
  return `<svg class="group-logo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

const ICONS = {
  satellite: outline('<path d="M4 8.5a8.5 8.5 0 0 0 11.5 11.5z"/><path d="M9.7 14.3 14.6 9.4"/><circle cx="16" cy="8" r="1.6"/><path d="M16 4.4a3.6 3.6 0 0 1 3.6 3.6M16 1.6a6.4 6.4 0 0 1 6.4 6.4"/>'),
  tv: outline('<rect x="2.5" y="6.5" width="19" height="13" rx="2"/><path d="M8 3l4 3.5L16 3"/>'),
  radio: outline('<rect x="3" y="8" width="18" height="12" rx="2"/><path d="M7 8l9-4.5"/><circle cx="15.5" cy="14" r="2.6"/><path d="M6.5 12.5h4M6.5 15.5h4"/>'),
  hd: outline('<rect x="2.5" y="5.5" width="19" height="13" rx="2"/><path d="M6.5 9v6M6.5 12h3.5M10 9v6M13 9v6h1.8a3 3 0 0 0 0-6z"/>'),
  freeToAir: outline('<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 7.6-1.7"/>'),
};

type MeterLevel = 'good' | 'fair' | 'poor';

function meterLevel(value: number): MeterLevel {
  return value >= 60 ? 'good' : value >= 30 ? 'fair' : 'poor';
}

// "HD 1080i", "SD 576i", "UHD 2160p": the tier viewers know, then the lines.
function resolutionLabel(stats: Partial<BroadcastStats>): string {
  if (!stats.height) return '';
  const tier = stats.height >= 2160 ? 'UHD' : stats.height >= 720 ? 'HD' : 'SD';
  return `${tier} ${String(stats.height)}${stats.interlaced ? 'i' : 'p'}`;
}

// The full transponder ("11977 V 27500 DVB-S2") once the TV listed it,
// else the frequency the channel list carries.
function transponderText(channel: BroadcastChannel): string {
  const transponder = BroadcastCache.transponder(channel.transponderId);
  if (transponder) return transponderLabel(transponder);
  return channel.frequency ? `${String(channel.frequency)} MHz` : '';
}

function timeRange(program: BroadcastProgram): string {
  return `${formatTime(new Date(program.start))} – ${formatTime(new Date(program.end))}`;
}

function programAt(programs: readonly BroadcastProgram[], now: number): BroadcastProgram | null {
  for (const program of programs) if (program.start <= now && program.end > now) return program;
  return null;
}

interface SatelliteViewOptions {
  onRevealTabBar: (dir: 'up' | 'left') => void;
  onBack: () => void;
  // Full screen hides the tab bar; the host owns it.
  onFullscreenChange: (fullscreen: boolean) => void;
}

/**
 * Satellite: the TV's own satellite tuner as a section, laid out like Live —
 * a group rail (favorites, TV, radio, HD, free-to-air, and one group per
 * satellite), the channel list, and a preview with now/next. OK watches in
 * the preview and again goes full screen, where Up/Down and CH± zap and
 * the digits tune by number. Channel and program names come from the
 * broadcast, so they render only through `html`.
 */
export class SatelliteView {
  readonly focusScope: FocusScope;
  private readonly stage: HTMLElement;
  private readonly ui: HTMLElement;
  private readonly video: BroadcastVideo;
  private readonly virtual = new VirtualList({ itemSize: ROW_STRIDE, overscan: 6, fallbackViewportSize: 800 });

  private active = false;
  private phase: Phase = 'idle';
  private failure: LoadFailure = 'failed';
  private route: BroadcastRoute | null = null;
  private channels: BroadcastChannel[] = [];
  private byId = new Map<string, BroadcastChannel>();
  private groups: SatGroup[] = [];
  private groupId = 'all';
  private list: BroadcastChannel[] = [];
  // Favorites by service key, so a rescan keeps them.
  private favorites = new Set<string>(StorageService.getSatelliteFavorites());

  private area: Area = 'channels';
  private groupIndex = 0;
  private channelIndex = 0;
  private control: PreviewControl = 'fullscreen';
  private noticeAction: NoticeAction = 'retry';

  private playingId: string | null = null;
  private tuning = false;
  private tuneFailed = false;
  private noSignal = false;
  // Readings since the last tune; what is shown also falls back on the
  // channel's cached reception (displayStats).
  private stats: Partial<BroadcastStats> | null = null;
  private badReadings = 0;
  private refreshing: Promise<ChannelLoad> | null = null;
  private transpondersRead = false;
  private aspectApplied = false;
  private videoStatus: BroadcastVideoStatus = 'idle';
  private fullscreen = false;
  private osdVisible = false;
  private zapId: string | null = null;
  private panelOpen = false;
  private panelIndex = 0;
  private panelTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly panelVirtual = new VirtualList({ itemSize: PANEL_ROW_STRIDE, overscan: 8, fallbackViewportSize: 900 });

  private loadToken = 0;
  private tuneToken = 0;
  private osdTimer: ReturnType<typeof setTimeout> | null = null;
  private zapTimer: ReturnType<typeof setTimeout> | null = null;
  private dwellTimer: ReturnType<typeof setTimeout> | null = null;
  private scrollFrame = 0;
  private readonly programsInFlight = new Set<string>();
  // A channel Search asked for, by service key, until the lineup shows.
  private pendingChannel: string | null = null;

  constructor(private readonly container: HTMLElement, private readonly options: SatelliteViewOptions) {
    this.stage = document.createElement('div');
    this.stage.className = 'sat-stage';
    this.ui = document.createElement('div');
    this.ui.className = 'sat-ui';
    container.appendChild(this.stage);
    container.appendChild(this.ui);
    this.virtual.setLeadingSize(LIST_PADDING_TOP);
    // The TV draws video on its own plane, which no backdrop blur reaches;
    // the OSD then needs an opaque panel to stay readable.
    container.classList.toggle('sat-hardware-video', isWebOS());
    this.video = new BroadcastVideo(
      this.stage,
      () => this.ui.querySelector<HTMLElement>('.sat-slot'),
      (status) => {
        this.videoStatus = status;
        if (this.active) this.render();
      },
    );
    this.focusScope = Focus.register({
      id: 'view.satellite',
      root: container,
      leaveFor: { up: 'tabbar', left: 'tabbar' },
      defaultKey: () => this.focusKey(),
      has: (key) => this.hasKey(key),
      // The list keeps its own focus in view.
      reveal: () => null,
    });
    this.bindPointer();
    // Live TV takes the broadcast while it is in front; take it back on return.
    document.addEventListener('visibilitychange', () => {
      if (!this.active || this.phase !== 'ready') return;
      if (document.hidden) {
        this.tuneToken++;
        this.video.stop();
        KeepAwake.release(KEEP_AWAKE);
        return;
      }
      const playing = this.playingId ? this.byId.get(this.playingId) : null;
      if (playing) void this.watch(playing, this.fullscreen);
    });
    onClockTick(() => {
      if (this.active && this.phase === 'ready') this.render();
    });
  }

  // --- Lifecycle -----------------------------------------------------------

  open(): void {
    this.active = true;
    if (this.phase !== 'ready') {
      void this.load();
      return;
    }
    if (this.pendingChannel) {
      this.render();
      this.showPending();
      void this.refresh();
      return;
    }
    this.render();
    this.syncFocus('resume');
    // Back from another section: the tuner is still on the channel; show it again.
    const playing = this.playingId ? this.byId.get(this.playingId) : null;
    if (playing) void this.watch(playing);
    void this.refresh();
  }

  resumeFocus(): void {
    this.syncFocus('resume');
  }

  // The next open lands on this channel, as Search picked it, and watches it.
  queueChannel(serviceKey: string): void {
    this.pendingChannel = serviceKey;
  }

  private showPending(): void {
    const key = this.pendingChannel;
    this.pendingChannel = null;
    const channel = key ? this.channels.find(item => item.serviceKey === key) : undefined;
    if (!channel) {
      this.syncFocus('resume');
      return;
    }
    this.area = 'channels';
    this.selectGroup(this.list.some(item => item.id === channel.id) ? this.groupId : 'all', channel.id);
    this.render();
    this.revealChannel();
    this.render();
    this.syncFocus('key');
    void this.watch(channel);
  }

  // The channel manager saved a new order: renumber in place.
  reorder(): void {
    if (this.phase === 'ready') this.applyChannels(this.channels, null, false);
  }

  // At app start: reads the cache and refreshes it from the TV in the
  // background, so the first open shows at once. Only for a TV where the
  // section was used before; also undoes an aspect change a crash left.
  warm(): void {
    void BroadcastCache.load().then(() => {
      if (!this.active) this.restoreAspect();
      if (BroadcastCache.channels() && isLunaAvailable()) void this.refresh();
    });
  }

  // The section was left: release the broadcast pipeline for the IPTV player.
  deactivate(): void {
    if (!this.active) return;
    this.active = false;
    this.tuneToken++;
    this.clearTimer('osd');
    this.clearTimer('zap');
    this.clearTimer('dwell');
    this.zapId = null;
    if (this.fullscreen) {
      this.fullscreen = false;
      this.options.onFullscreenChange(false);
    }
    this.video.stop();
    KeepAwake.release(KEEP_AWAKE);
    this.restoreAspect();
    BroadcastCache.flush();
  }

  // The cached lineup shows at once while the TV is asked again; without a
  // cache, the section waits for the TV.
  private async load(): Promise<void> {
    const token = ++this.loadToken;
    await BroadcastCache.load();
    if (token !== this.loadToken || !this.active) return;
    const cached = BroadcastService.activeRoute === 'sample' ? null : BroadcastCache.channels();
    if (cached && cached.length) {
      this.applyChannels(cached, null, true);
      void this.refresh();
      return;
    }
    this.phase = 'loading';
    this.area = 'notice';
    this.render();
    this.syncFocus('key');
    const result = await this.refresh();
    // A refresh that finished first may already have shown the list.
    if (token !== this.loadToken || (this.phase as Phase) === 'ready') return;
    if (!result.ok) {
      this.phase = 'failed';
      this.failure = result.reason;
      this.noticeAction = 'retry';
      this.render();
      this.syncFocus('key');
      return;
    }
    this.applyChannels(result.channels, result.currentId, true);
  }

  // Asks the TV for the lineup (one request at a time), stores it, and
  // updates the shown list in place when it changed; the transponders
  // follow once per session.
  private refresh(): Promise<ChannelLoad> {
    if (this.refreshing) return this.refreshing;
    const request = BroadcastService.loadChannels().then((result) => {
      this.refreshing = null;
      if (!result.ok || result.route === 'sample') return result;
      const changed = BroadcastCache.saveChannels(result.channels);
      if (changed && this.phase === 'ready') this.applyChannels(result.channels, null, false);
      this.refreshTransponders();
      return result;
    });
    this.refreshing = request;
    return request;
  }

  private refreshTransponders(): void {
    if (this.transpondersRead) return;
    this.transpondersRead = true;
    void BroadcastService.transponders().then((list) => {
      if (!list || !list.length) {
        this.transpondersRead = false;
        return;
      }
      BroadcastCache.saveTransponders(list);
      if (this.active && this.phase === 'ready') this.render();
    });
  }

  // `initial` opens the section on the list; otherwise a refreshed list
  // replaces it under the user, keeping the group, focus, and scroll.
  private applyChannels(tvList: BroadcastChannel[], currentId: string | null, initial: boolean): void {
    const focusId = this.focusedChannel ? this.focusedChannel.id : null;
    this.route = BroadcastService.activeRoute;
    const list = this.ordered(tvList);
    this.channels = list;
    this.byId = new Map(list.map(channel => [channel.id, channel]));
    this.rebuildGroups();
    const groupId = this.groups.some(group => group.id === this.groupId) ? this.groupId : 'all';
    if (!initial) {
      this.groupId = groupId;
      this.groupIndex = Math.max(0, this.groups.findIndex(group => group.id === groupId));
      this.list = list.filter(channel => this.matches(groupId, channel));
      const at = focusId ? this.list.findIndex(channel => channel.id === focusId) : -1;
      this.channelIndex = at >= 0 ? at : Math.min(this.channelIndex, Math.max(0, this.list.length - 1));
      if (!this.active) return;
      this.render();
      if (at < 0) this.syncFocus('resume');
      return;
    }
    this.phase = 'ready';
    this.area = 'channels';
    if (this.pendingChannel && this.active) {
      this.selectGroup(groupId, null);
      this.showPending();
      return;
    }
    // Land on the channel the TV is on, else the last one watched here.
    const last = StorageService.getSatelliteLastChannel();
    const resume = (currentId ? this.byId.get(currentId) : undefined)
      ?? (last ? this.channels.find(channel => channel.serviceKey === last || channel.id === last) : undefined)
      ?? null;
    this.selectGroup(groupId, resume ? resume.id : null);
    if (!this.active) return;
    this.render();
    this.revealChannel();
    this.render();
    this.syncFocus('key');
    if (resume) void this.watch(resume);
  }

  // The TV's list in the section's own order (new services at the end),
  // with favorites saved before services had keys moved over to them.
  private ordered(tvList: BroadcastChannel[]): BroadcastChannel[] {
    const lineup = applyOrder(tvList, StorageService.getSatelliteOrder());
    if (lineup.changed) StorageService.setSatelliteOrder(lineup.order);
    let migrated = false;
    for (const channel of lineup.channels) {
      if (!this.favorites.has(channel.id)) continue;
      this.favorites.delete(channel.id);
      this.favorites.add(channel.serviceKey);
      migrated = true;
    }
    if (migrated) StorageService.setSatelliteFavorites(Array.from(this.favorites));
    return lineup.channels;
  }

  // A scan changed the TV's list: read it again, now or on the next open.
  invalidate(): void {
    BroadcastCache.invalidate();
    this.transpondersRead = false;
    if (this.active) void this.refresh();
    else this.phase = 'idle';
  }

  // The TV's own aspect for this app follows the channel's flag, which
  // pillarboxes many SD services; while Satellite plays it fills the screen
  // as Live TV does, and the viewer's setting comes back on the way out.
  private fillScreen(): void {
    if (this.aspectApplied || this.route === 'sample') return;
    this.aspectApplied = true;
    void (async () => {
      if (!StorageService.getSatelliteAspectRestore()) {
        const current = await BroadcastService.appAspect();
        if (current && current !== FILL_ASPECT) StorageService.setSatelliteAspectRestore(current);
      }
      if (this.aspectApplied) await BroadcastService.setAppAspect(FILL_ASPECT);
    })();
  }

  private restoreAspect(): void {
    this.aspectApplied = false;
    const prior = StorageService.getSatelliteAspectRestore();
    if (!prior) return;
    StorageService.setSatelliteAspectRestore(null);
    void BroadcastService.setAppAspect(prior);
  }

  // --- Groups --------------------------------------------------------------

  private rebuildGroups(): void {
    const all = this.channels;
    const total = all.length;
    const count = (test: (channel: BroadcastChannel) => boolean): number => {
      let n = 0;
      for (const channel of all) if (test(channel)) n++;
      return n;
    };
    const groups: SatGroup[] = [
      { id: 'all', label: t('satellite.allChannels'), icon: groupIcon('', 'all'), count: total },
      { id: 'favorites', label: t('channel.favorites'), icon: groupIcon('', 'favorites'), count: count(c => this.favorites.has(c.serviceKey)) },
    ];
    // A filter that matches nothing or everything adds nothing.
    const optional: SatGroup[] = [
      { id: 'tv', label: t('satellite.tv'), icon: ICONS.tv, count: count(c => c.kind === 'tv') },
      { id: 'radio', label: t('satellite.radio'), icon: ICONS.radio, count: count(c => c.kind === 'radio') },
      { id: 'hd', label: t('satellite.hd'), icon: ICONS.hd, count: count(c => c.hd) },
      { id: 'fta', label: t('satellite.freeToAir'), icon: ICONS.freeToAir, count: count(c => !c.scrambled) },
    ];
    const satellites: string[] = [];
    for (const channel of all) {
      if (channel.satellite && satellites.indexOf(channel.satellite) === -1) satellites.push(channel.satellite);
    }
    satellites.sort();
    for (const name of satellites) {
      optional.push({ id: `sat:${name}`, label: name, icon: ICONS.satellite, count: count(c => c.satellite === name) });
    }
    for (const group of optional) if (group.count > 0 && group.count < total) groups.push(group);
    this.groups = groups;
  }

  private matches(groupId: string, channel: BroadcastChannel): boolean {
    switch (groupId) {
      case 'all': return true;
      case 'favorites': return this.favorites.has(channel.serviceKey);
      case 'tv': return channel.kind === 'tv';
      case 'radio': return channel.kind === 'radio';
      case 'hd': return channel.hd;
      case 'fta': return !channel.scrambled;
      default: return groupId.indexOf('sat:') === 0 && channel.satellite === groupId.slice(4);
    }
  }

  // Shows a group's channels, keeping `focusId` focused when it is in it.
  private selectGroup(groupId: string, focusId?: string | null): void {
    this.groupId = groupId;
    this.groupIndex = Math.max(0, this.groups.findIndex(group => group.id === groupId));
    this.list = this.channels.filter(channel => this.matches(groupId, channel));
    const at = focusId ? this.list.findIndex(channel => channel.id === focusId) : -1;
    this.channelIndex = at >= 0 ? at : 0;
    const scroller = this.listEl();
    if (scroller) scroller.scrollTop = 0;
    this.virtual.setScrollOffset(0);
  }

  // --- Model helpers -------------------------------------------------------

  private get focusedChannel(): BroadcastChannel | null {
    return this.list[this.channelIndex] ?? null;
  }

  // The preview describes what plays; before anything does, what is focused.
  private get previewChannel(): BroadcastChannel | null {
    return (this.playingId ? this.byId.get(this.playingId) : null) ?? this.focusedChannel;
  }

  private get osdChannel(): BroadcastChannel | null {
    const id = this.zapId ?? this.playingId;
    return id ? this.byId.get(id) ?? null : null;
  }

  private focusKey(): string | null {
    if (this.fullscreen) {
      const channel = this.panelOpen ? this.ring[this.panelIndex] : undefined;
      return channel ? `q:${channel.id}` : null;
    }
    switch (this.area) {
      case 'groups': return this.groups[this.groupIndex] ? `g:${this.groups[this.groupIndex].id}` : null;
      case 'channels': return this.focusedChannel ? `c:${this.focusedChannel.id}` : null;
      case 'preview': return this.previewChannel ? `p:${this.control}` : null;
      case 'notice': return this.phase === 'failed' ? `n:${this.noticeAction}` : null;
    }
  }

  private hasKey(key: string): boolean {
    const id = key.slice(2);
    switch (key.slice(0, 2)) {
      case 'g:': return this.groups.some(group => group.id === id);
      case 'c:': return this.list.some(channel => channel.id === id);
      case 'q:': return this.panelOpen && this.ring.some(channel => channel.id === id);
      default: return this.ui.querySelector(`[data-key="${CSS.escape(key)}"]`) !== null;
    }
  }

  private syncFocus(via: Via): void {
    this.focusScope.focus(this.focusKey(), via);
  }

  private listEl(): HTMLElement | null {
    return this.ui.querySelector<HTMLElement>('.sat-channel-main');
  }

  private nowProgram(channel: BroadcastChannel, now: number): BroadcastProgram | null {
    const programs = BroadcastService.cachedPrograms(channel, now);
    return programs ? programAt(programs, now) : null;
  }

  private loadPrograms(channel: BroadcastChannel): void {
    if (BroadcastService.cachedPrograms(channel) || this.programsInFlight.has(channel.id)) return;
    this.programsInFlight.add(channel.id);
    void BroadcastService.programs(channel).catch(() => []).then(() => {
      this.programsInFlight.delete(channel.id);
      if (this.active && this.phase === 'ready') this.render();
    });
  }

  private schedulePrograms(channel: BroadcastChannel | null): void {
    this.clearTimer('dwell');
    if (!channel) return;
    this.dwellTimer = setTimeout(() => {
      this.dwellTimer = null;
      this.loadPrograms(channel);
    }, PROGRAM_DWELL_MS);
  }

  private clearTimer(which: 'osd' | 'zap' | 'dwell' | 'panel'): void {
    const timer = which === 'osd' ? this.osdTimer : which === 'zap' ? this.zapTimer
      : which === 'panel' ? this.panelTimer : this.dwellTimer;
    if (timer) clearTimeout(timer);
    if (which === 'osd') this.osdTimer = null;
    else if (which === 'zap') this.zapTimer = null;
    else if (which === 'panel') this.panelTimer = null;
    else this.dwellTimer = null;
  }

  // --- Playback ------------------------------------------------------------

  private async watch(channel: BroadcastChannel, fullscreen = false): Promise<void> {
    const token = ++this.tuneToken;
    this.playingId = channel.id;
    this.tuning = true;
    this.tuneFailed = false;
    StorageService.setSatelliteLastChannel(channel.serviceKey);
    this.noSignal = false;
    this.stats = null;
    this.badReadings = 0;
    this.loadPrograms(channel);
    this.render();
    const sample = this.route === 'sample';
    if (!sample) this.fillScreen();
    const broadcastId = sample ? null : await this.video.prepare();
    if (token !== this.tuneToken || !this.active) return;
    const ok = sample || (!!broadcastId && await BroadcastService.tune(channel, broadcastId));
    if (token !== this.tuneToken || !this.active) return;
    this.tuning = false;
    this.tuneFailed = !ok;
    if (ok && broadcastId) {
      this.video.start();
      // The TV does not count its broadcast picture as playback.
      KeepAwake.hold(KEEP_AWAKE);
      this.pollPicture(channel, broadcastId, token, STATS_FIRST_MS);
      this.pollReception(channel, broadcastId, token, RECEPTION_FIRST_MS);
    }
    if (ok && fullscreen && !this.fullscreen) this.enterFullscreen();
    else this.render();
  }

  // Folds a reading into the tune's readings and the channel's cache.
  private takeReading(channel: BroadcastChannel, reading: Partial<BroadcastStats>): void {
    this.stats = { ...(this.stats ?? {}), ...reading };
    const shown = this.displayStats(channel);
    if (shown && this.confirmed) BroadcastCache.rememberStats(channel.id, shown);
  }

  // "No signal" waits for a run of bad readings: a good channel reads bad
  // for a moment while the tuner locks.
  private countReading(alive: boolean): void {
    this.badReadings = alive ? 0 : this.badReadings + 1;
    this.noSignal = this.badReadings >= DEAD_READINGS;
  }

  // The picture and its lock, often and directly.
  private pollPicture(channel: BroadcastChannel, broadcastId: string, token: number, delay: number): void {
    setTimeout(() => {
      if (token !== this.tuneToken || !this.active) return;
      void BroadcastService.pictureStats(broadcastId).then((reading) => {
        if (token !== this.tuneToken || !this.active) return;
        this.takeReading(channel, reading);
        // Radio has no picture to report; its reception poll decides.
        if (channel.kind === 'tv') {
          this.countReading(reading.signal === 'good' || (reading.height ?? 0) > 0 || this.stats?.videoGood === true);
        }
        this.render();
        this.pollPicture(channel, broadcastId, token, STATS_POLL_MS);
      });
    }, delay);
  }

  // Strength, quality, and (once) the codec, through root.
  private pollReception(channel: BroadcastChannel, broadcastId: string, token: number, delay: number): void {
    setTimeout(() => {
      if (token !== this.tuneToken || !this.active) return;
      void BroadcastService.receptionStats(broadcastId, !this.stats?.codec).then((reading) => {
        if (token !== this.tuneToken || !this.active) return;
        this.takeReading(channel, reading);
        if (channel.kind === 'radio' && reading.locked !== undefined) this.countReading(reading.locked !== false);
        this.render();
        this.pollReception(channel, broadcastId, token, RECEPTION_POLL_MS);
      });
    }, delay);
  }

  // What the meters show: this tune's readings over the channel's cached
  // reception, so a channel shows its last values the moment it is chosen.
  private displayStats(channel: BroadcastChannel): CachedStats | null {
    const cached = BroadcastCache.stats(channel.id);
    const live = channel.id === this.playingId ? this.stats : null;
    if (!cached && !live) return null;
    const pick = <K extends keyof CachedStats>(key: K, empty: CachedStats[K]): CachedStats[K] => {
      const value = live ? live[key] : undefined;
      if (value !== undefined && value !== null && value !== 0 && value !== '') return value as CachedStats[K];
      return cached ? cached[key] : empty;
    };
    return {
      strength: pick('strength', null),
      quality: pick('quality', null),
      width: pick('width', 0),
      height: pick('height', 0),
      fps: pick('fps', 0),
      interlaced: live && live.height ? !!live.interlaced : cached ? cached.interlaced : false,
      hdr: pick('hdr', ''),
      codec: pick('codec', ''),
    };
  }

  // Whether this tune's readings show live values yet (else cached ones).
  private isLive(channel: BroadcastChannel): boolean {
    return channel.id === this.playingId && !!this.stats
      && (this.stats.strength !== undefined || (this.stats.height ?? 0) > 0);
  }

  private activateChannel(channel: BroadcastChannel): void {
    if (channel.id === this.playingId && !this.tuneFailed && !this.tuning) this.enterFullscreen();
    else void this.watch(channel);
  }

  private enterFullscreen(): void {
    if (!this.playingId) return;
    this.fullscreen = true;
    this.zapId = null;
    this.options.onFullscreenChange(true);
    this.showOsd();
  }

  private exitFullscreen(): void {
    this.clearTimer('zap');
    this.clearTimer('osd');
    this.clearTimer('panel');
    this.panelOpen = false;
    this.zapId = null;
    this.fullscreen = false;
    this.options.onFullscreenChange(false);
    const at = this.playingId ? this.list.findIndex(channel => channel.id === this.playingId) : -1;
    if (at >= 0) this.channelIndex = at;
    this.area = 'channels';
    this.render();
    this.revealChannel();
    this.render();
    this.syncFocus('back');
  }

  private showOsd(): void {
    const channel = this.osdChannel;
    if (channel) this.loadPrograms(channel);
    this.osdVisible = true;
    this.clearTimer('osd');
    this.osdTimer = setTimeout(() => {
      this.osdTimer = null;
      this.osdVisible = false;
      if (this.active) this.render();
    }, StorageService.getPlayerOsdTimeoutMs());
    this.render();
  }

  // What CH± and the full-screen list step through: the group on screen.
  private get ring(): BroadcastChannel[] {
    return this.list.length ? this.list : this.channels;
  }

  private panelEl(): HTMLElement | null {
    return this.ui.querySelector<HTMLElement>('.sat-panel-list');
  }

  // Left in full screen: the channel list over the picture, on the channel
  // playing, as Live's player opens its sidebar.
  private openPanel(): void {
    const ring = this.ring;
    if (!ring.length) return;
    this.clearTimer('zap');
    this.zapId = null;
    this.clearTimer('osd');
    this.osdVisible = false;
    this.panelIndex = Math.max(0, ring.findIndex(channel => channel.id === this.playingId));
    this.panelOpen = true;
    this.render();
    const list = this.panelEl();
    this.panelVirtual.centerOn(this.panelIndex, list?.clientHeight || 900);
    if (list) list.scrollTop = this.panelVirtual.scrollOffset;
    this.render();
    this.syncFocus('key');
    this.armPanel();
  }

  private closePanel(): void {
    if (!this.panelOpen) return;
    this.clearTimer('panel');
    this.panelOpen = false;
    this.render();
    this.syncFocus('back');
  }

  private armPanel(): void {
    this.clearTimer('panel');
    this.panelTimer = setTimeout(() => {
      this.panelTimer = null;
      if (this.active) this.closePanel();
    }, PANEL_HIDE_MS);
  }

  private movePanel(step: number): void {
    const count = this.ring.length;
    if (!count) return;
    this.panelIndex = Math.max(0, Math.min(count - 1, this.panelIndex + step));
    const list = this.panelEl();
    if (list) {
      this.panelVirtual.setScrollOffset(list.scrollTop);
      if (this.panelVirtual.ensureVisible(this.panelIndex, list.clientHeight || 900, PANEL_ROW_STRIDE)) {
        list.scrollTop = this.panelVirtual.scrollOffset;
      }
    }
    this.render();
    this.syncFocus('key');
    this.armPanel();
  }

  // A pick tunes and leaves the list open to try the next; picking the
  // channel already playing (OK again, a double click) closes it.
  private pickPanel(channel: BroadcastChannel | undefined): void {
    if (!channel) return;
    if (channel.id === this.playingId) {
      this.closePanel();
      this.showOsd();
      return;
    }
    const at = this.ring.indexOf(channel);
    if (at >= 0) this.panelIndex = at;
    void this.watch(channel);
    this.render();
    this.syncFocus('key');
    this.armPanel();
  }

  private handlePanel(action: Action, event?: NumberEvent): void {
    if (action === 'up' || action === 'down') this.movePanel(action === 'up' ? -1 : 1);
    else if (action === 'channel_up' || action === 'channel_down') {
      const page = Math.max(1, Math.floor((this.panelEl()?.clientHeight || 900) / PANEL_ROW_STRIDE) - 1);
      this.movePanel(action === 'channel_up' ? -page : page);
    } else if (action === 'select') this.pickPanel(this.ring[this.panelIndex]);
    else if (action === 'number') {
      this.closePanel();
      this.tuneNumber(event);
    } else if (action === 'left' || action === 'right' || action === 'back') this.closePanel();
    else this.armPanel();
  }

  private zap(step: 1 | -1): void {
    const ring = this.ring;
    if (!ring.length) return;
    const from = this.zapId ?? this.playingId;
    const at = ring.findIndex(channel => channel.id === from);
    const next = ring[at < 0 ? 0 : (at + step + ring.length) % ring.length];
    this.zapId = next.id;
    this.loadPrograms(next);
    this.showOsd();
    this.clearTimer('zap');
    this.zapTimer = setTimeout(() => {
      this.zapTimer = null;
      const target = this.zapId ? this.byId.get(this.zapId) : null;
      this.zapId = null;
      if (target && target.id !== this.playingId) void this.watch(target);
    }, ZAP_DEBOUNCE_MS);
  }

  // Direct entry: the channel with that number, full screen as in Live.
  private tuneNumber(event?: NumberEvent): void {
    if (!event) return;
    const channel = this.channels.find(item => item.number === event.number);
    if (!channel) {
      showToast(t('satellite.noChannelNumber', { number: event.number }));
      return;
    }
    if (!this.fullscreen) {
      if (!this.list.some(item => item.id === channel.id)) this.selectGroup('all', channel.id);
      else this.channelIndex = this.list.findIndex(item => item.id === channel.id);
      this.area = 'channels';
    }
    void this.watch(channel, true);
  }

  private toggleFavorite(channel: BroadcastChannel | null): void {
    if (!channel) return;
    const added = !this.favorites.has(channel.serviceKey);
    if (added) this.favorites.add(channel.serviceKey);
    else this.favorites.delete(channel.serviceKey);
    StorageService.setSatelliteFavorites(Array.from(this.favorites));
    showToast(t(added ? 'channel.favoriteAdded' : 'channel.favoriteRemoved', { name: channel.name }));
    const focusId = this.focusedChannel?.id ?? null;
    this.rebuildGroups();
    if (this.groups.some(group => group.id === this.groupId)) {
      // Favorites shrinks under the focus; keep it on the row's neighbor.
      const keepIndex = this.channelIndex;
      this.list = this.channels.filter(item => this.matches(this.groupId, item));
      const at = focusId ? this.list.findIndex(item => item.id === focusId) : -1;
      this.channelIndex = at >= 0 ? at : Math.min(keepIndex, Math.max(0, this.list.length - 1));
      this.groupIndex = Math.max(0, this.groups.findIndex(group => group.id === this.groupId));
    } else {
      this.selectGroup('all', focusId);
    }
    if (this.area === 'channels' && !this.list.length) this.area = 'groups';
    this.render();
    this.syncFocus('key');
  }

  private async openLiveTv(channel: BroadcastChannel | null): Promise<void> {
    if (!channel) return;
    if (this.route === 'sample') {
      showToast(t('satellite.sampleOnly'));
      return;
    }
    // Live TV takes the broadcast pipeline as it opens.
    this.video.stop();
    const ok = await BroadcastService.launchLiveTv(channel);
    if (!ok) {
      showToast(t('satellite.liveTvFailed'));
      const playing = this.active && this.playingId ? this.byId.get(this.playingId) : null;
      if (playing) void this.watch(playing, this.fullscreen);
    }
  }

  // --- Keys ----------------------------------------------------------------

  handleAction(action: Action, event?: NumberEvent): void {
    if (this.fullscreen) {
      this.handleFullscreen(action, event);
      return;
    }
    if (this.phase !== 'ready') {
      this.handleNotice(action);
      return;
    }
    if (action === 'number') {
      this.tuneNumber(event);
      return;
    }
    if (action === 'channel_up' || action === 'channel_down') {
      this.stepChannel(action === 'channel_up' ? 1 : -1, true);
      return;
    }
    if (action === 'green') {
      this.toggleFavorite(this.area === 'channels' ? this.focusedChannel : this.previewChannel);
      return;
    }
    if (action === 'yellow') {
      void this.openLiveTv(this.area === 'channels' ? this.focusedChannel : this.previewChannel);
      return;
    }
    switch (this.area) {
      case 'groups': this.handleGroups(action); break;
      case 'channels': this.handleChannels(action); break;
      case 'preview': this.handlePreview(action); break;
      case 'notice': this.handleNotice(action); break;
    }
  }

  private moveTo(area: Area): void {
    this.area = area;
    this.render();
    this.syncFocus('key');
  }

  private handleGroups(action: Action): void {
    if (action === 'back' || action === 'right') {
      if (this.list.length) this.moveTo('channels');
      else if (action === 'back') this.options.onBack();
    } else if (action === 'select') {
      if (this.list.length) this.moveTo('channels');
    } else if (action === 'left') {
      this.options.onRevealTabBar('left');
    } else if (action === 'up' || action === 'down') {
      const next = this.groupIndex + (action === 'up' ? -1 : 1);
      if (next < 0) {
        this.options.onRevealTabBar('up');
        return;
      }
      const group = this.groups[next];
      if (!group) return;
      // The rail selects as it moves, as on the TV's own channel list.
      this.selectGroup(group.id, this.playingId);
      this.render();
      this.revealGroup();
      this.revealChannel();
      this.render();
      this.syncFocus('key');
    }
  }

  private handleChannels(action: Action): void {
    const channel = this.focusedChannel;
    if (action === 'back') {
      this.options.onBack();
    } else if (action === 'left') {
      this.moveTo('groups');
    } else if (action === 'right') {
      this.control = this.playingId ? 'fullscreen' : 'favorite';
      if (this.previewChannel) this.moveTo('preview');
    } else if (action === 'select' && channel) {
      this.activateChannel(channel);
    } else if (action === 'up' || action === 'down') {
      if (action === 'up' && this.channelIndex === 0) {
        this.options.onRevealTabBar('up');
        return;
      }
      this.stepChannel(action === 'up' ? -1 : 1, false);
    }
  }

  // Up/Down in the list; CH± also tunes what it lands on.
  private stepChannel(step: 1 | -1, tune: boolean): void {
    if (!this.list.length) return;
    const next = tune
      ? (this.channelIndex + step + this.list.length) % this.list.length
      : Math.max(0, Math.min(this.list.length - 1, this.channelIndex + step));
    if (next === this.channelIndex && !tune) return;
    this.channelIndex = next;
    if (this.area !== 'channels') this.area = 'channels';
    this.revealChannel();
    this.render();
    this.syncFocus('key');
    const channel = this.focusedChannel;
    if (tune && channel) void this.watch(channel);
    else this.schedulePrograms(channel);
  }

  private handlePreview(action: Action): void {
    const channel = this.previewChannel;
    if (action === 'back') {
      this.moveTo('channels');
    } else if (action === 'select') {
      this.activateControl(this.control, channel);
    } else if (action === 'up' && this.control !== 'favorite') {
      this.control = 'favorite';
      this.moveTo('preview');
    } else if (action === 'down' && this.control === 'favorite') {
      this.control = 'fullscreen';
      this.moveTo('preview');
    } else if (action === 'right' && this.control === 'fullscreen') {
      this.control = 'livetv';
      this.moveTo('preview');
    } else if (action === 'left') {
      if (this.control === 'livetv') {
        this.control = 'fullscreen';
        this.moveTo('preview');
      } else {
        this.moveTo('channels');
      }
    }
  }

  private activateControl(control: PreviewControl, channel: BroadcastChannel | null): void {
    if (!channel) return;
    if (control === 'favorite') this.toggleFavorite(channel);
    else if (control === 'livetv') void this.openLiveTv(channel);
    else if (channel.id === this.playingId && !this.tuneFailed) this.enterFullscreen();
    else void this.watch(channel, true);
  }

  private handleNotice(action: Action): void {
    if (this.phase !== 'failed') {
      if (action === 'back') this.options.onBack();
      else if (action === 'up' || action === 'left') this.options.onRevealTabBar(action);
      return;
    }
    const actions = this.noticeActions();
    const at = Math.max(0, actions.indexOf(this.noticeAction));
    if (action === 'back') {
      this.options.onBack();
    } else if (action === 'select') {
      this.activateNotice(this.noticeAction);
    } else if (action === 'right' && at < actions.length - 1) {
      this.noticeAction = actions[at + 1];
      this.moveTo('notice');
    } else if (action === 'left' && at > 0) {
      this.noticeAction = actions[at - 1];
      this.moveTo('notice');
    } else if (action === 'up' || action === 'left') {
      this.options.onRevealTabBar(action);
    }
  }

  private noticeActions(): NoticeAction[] {
    // Nothing to explore when the TV answered with its own empty lineup.
    return this.failure === 'no-channels' || this.failure === 'no-satellite' ? ['retry'] : ['retry', 'sample'];
  }

  private activateNotice(action: NoticeAction): void {
    if (action === 'sample') BroadcastService.useSample();
    void this.load();
  }

  private handleFullscreen(action: Action, event?: NumberEvent): void {
    if (this.panelOpen) {
      this.handlePanel(action, event);
      return;
    }
    if (action === 'left') {
      this.openPanel();
    } else if (action === 'back') {
      this.exitFullscreen();
    } else if (action === 'up' || action === 'channel_up') {
      this.zap(1);
    } else if (action === 'down' || action === 'channel_down') {
      this.zap(-1);
    } else if (action === 'select') {
      if (this.osdVisible && !this.zapId) {
        this.clearTimer('osd');
        this.osdVisible = false;
        this.render();
      } else {
        this.showOsd();
      }
    } else if (action === 'number') {
      this.tuneNumber(event);
    } else if (action === 'green') {
      this.toggleFavorite(this.osdChannel);
      this.showOsd();
    } else if (action === 'yellow') {
      void this.openLiveTv(this.osdChannel);
    } else {
      this.showOsd();
    }
  }

  // --- Pointer -------------------------------------------------------------

  private bindPointer(): void {
    this.container.setAttribute('data-self-activate', '');
    this.container.addEventListener('nav:hover', (event: Event) => {
      const el = event.target as HTMLElement;
      const key = el.getAttribute('data-key');
      if (key && this.fullscreen && this.panelOpen && key.indexOf('q:') === 0) {
        const at = this.ring.findIndex(channel => channel.id === key.slice(2));
        if (at < 0) return;
        this.panelIndex = at;
        this.focusScope.focus(key, 'pointer');
        this.armPanel();
        return;
      }
      if (!key || this.fullscreen || !this.adoptKey(key)) return;
      this.focusScope.focus(key, 'pointer');
    });
    this.container.addEventListener('nav:unhover', (event: Event) => {
      const key = (event.target as HTMLElement).getAttribute('data-key');
      if (key && key === this.focusScope.focusKey) this.focusScope.conceal();
    });
    this.container.addEventListener('click', (event: MouseEvent) => {
      if (this.fullscreen) {
        if (this.panelOpen) {
          const row = (event.target as HTMLElement).closest<HTMLElement>('[data-key^="q:"]');
          if (row) this.pickPanel(this.ring.find(channel => `q:${channel.id}` === row.getAttribute('data-key')));
          else if (!(event.target as HTMLElement).closest('.sat-panel')) this.closePanel();
          else this.armPanel();
          return;
        }
        this.handleFullscreen('select');
        return;
      }
      const target = event.target as HTMLElement;
      const el = target.closest<HTMLElement>('[data-key]');
      const key = el?.getAttribute('data-key') ?? '';
      if (target.closest('.sat-slot') && !target.closest('[data-focusable]')) {
        const playing = this.playingId ? this.byId.get(this.playingId) ?? null : null;
        if (playing) this.activateControl('fullscreen', playing);
        return;
      }
      if (!key || !this.adoptKey(key)) return;
      this.focusScope.focus(key, 'pointer');
      if (key.indexOf('g:') === 0) {
        const group = this.groups[this.groupIndex];
        if (group) this.selectGroup(group.id, this.playingId);
        this.render();
      } else if (key.indexOf('c:') === 0) {
        const channel = this.focusedChannel;
        if (channel) this.activateChannel(channel);
      } else if (key.indexOf('p:') === 0) {
        this.activateControl(this.control, this.previewChannel);
      } else if (key.indexOf('n:') === 0) {
        this.activateNotice(this.noticeAction);
      }
    });
    // A wheel or drag scroll renders the rows it brings into view.
    this.ui.addEventListener('scroll', (event: Event) => {
      if (event.target instanceof HTMLElement && event.target.classList.contains('sat-panel-list')) {
        const list = event.target;
        if (this.scrollFrame) return;
        this.scrollFrame = requestAnimationFrame(() => {
          this.scrollFrame = 0;
          this.panelVirtual.setScrollOffset(list.scrollTop);
          this.render();
          if (this.panelOpen) this.armPanel();
        });
        return;
      }
      if (!(event.target instanceof HTMLElement) || !event.target.classList.contains('sat-channel-main')) return;
      if (this.scrollFrame) return;
      this.scrollFrame = requestAnimationFrame(() => {
        this.scrollFrame = 0;
        const scroller = this.listEl();
        if (!scroller) return;
        this.virtual.setScrollOffset(scroller.scrollTop);
        this.render();
      });
    }, true);
  }

  // Points the model at a hovered or clicked key; false when it names nothing.
  private adoptKey(key: string): boolean {
    const id = key.slice(2);
    const prefix = key.slice(0, 2);
    if (prefix === 'g:') {
      const at = this.groups.findIndex(group => group.id === id);
      if (at < 0) return false;
      this.groupIndex = at;
      this.area = 'groups';
    } else if (prefix === 'c:') {
      const at = this.list.findIndex(channel => channel.id === id);
      if (at < 0) return false;
      if (at !== this.channelIndex) this.schedulePrograms(this.list[at]);
      this.channelIndex = at;
      this.area = 'channels';
    } else if (prefix === 'p:' && (id === 'favorite' || id === 'fullscreen' || id === 'livetv')) {
      this.control = id;
      this.area = 'preview';
    } else if (prefix === 'n:' && (id === 'retry' || id === 'sample')) {
      this.noticeAction = id;
      this.area = 'notice';
    } else {
      return false;
    }
    return true;
  }

  // --- Scrolling -----------------------------------------------------------

  private revealChannel(): void {
    const scroller = this.listEl();
    if (!scroller || this.channelIndex < 0) return;
    this.virtual.setScrollOffset(scroller.scrollTop);
    if (this.virtual.ensureVisible(this.channelIndex, scroller.clientHeight || 800, ROW_STRIDE)) {
      scroller.scrollTop = this.virtual.scrollOffset;
    }
  }

  private revealGroup(): void {
    const rail = this.ui.querySelector<HTMLElement>('.sat-group-list');
    const group = this.groups[this.groupIndex];
    const el = group ? rail?.querySelector<HTMLElement>(`[data-key="${CSS.escape(`g:${group.id}`)}"]`) : null;
    if (!rail || !el) return;
    const top = el.offsetTop - 8;
    const bottom = el.offsetTop + el.offsetHeight + 8;
    if (top < rail.scrollTop) rail.scrollTop = top;
    else if (bottom > rail.scrollTop + rail.clientHeight) rail.scrollTop = bottom - rail.clientHeight;
  }

  // --- Rendering -----------------------------------------------------------

  private render(): void {
    if (!this.active) return;
    morph(this.ui, html`
      <div class="sat-view ${this.fullscreen ? 'sat-fullscreen' : ''}">
        ${this.phase === 'ready' ? this.renderBrowse() : this.renderNotice()}
        ${this.fullscreen ? this.renderFullscreen() : ''}
      </div>
    `);
    this.container.classList.toggle('sat-fullscreen', this.fullscreen);
    if (this.fullscreen) this.video.showFullscreen();
    else this.video.showPreview();
  }

  private renderNotice(): Safe {
    if (this.phase !== 'failed') {
      return html`
        <div class="sat-notice" data-key="sat-notice">
          <span class="sat-notice-icon sat-notice-loading">${raw(TAB_SATELLITE_ICON)}</span>
          <h2 class="sat-notice-title">${t('satellite.loading')}</h2>
        </div>`;
    }
    const copy = FAILURE_COPY[this.failure];
    const actions = this.noticeActions();
    return html`
      <div class="sat-notice" data-key="sat-notice">
        <span class="sat-notice-icon">${raw(TAB_SATELLITE_ICON)}</span>
        <h2 class="sat-notice-title">${t(copy.title)}</h2>
        <p class="sat-notice-body">${t(copy.body)}</p>
        <div class="sat-notice-actions">
          <button class="btn btn-primary sat-notice-button" data-key="n:retry" data-focusable>${t('common.retry')}</button>
          ${actions.indexOf('sample') !== -1 ? html`
            <button class="btn sat-notice-button" data-key="n:sample" data-focusable>${t('satellite.exploreSample')}</button>` : ''}
        </div>
      </div>`;
  }

  private renderBrowse(): Safe {
    const now = Date.now();
    const showHints = this.area === 'channels' && this.list.length > 0;
    return html`
      <div class="sat-browse ${showHints ? 'has-channel-hints' : ''}">
        <div class="sidebar sat-sidebar" data-nav-container>
          <div class="sidebar-header">
            <span class="sidebar-label-icon">${raw(LIVE_CATEGORIES_ICON)}</span>
            <h2 class="sidebar-label">${t('nav.satellite')}</h2>
            ${this.route === 'sample' ? html`<span class="sat-sample-badge">${t('satellite.sample')}</span>` : ''}
          </div>
          <div class="group-list sat-group-list">
            ${this.groups.map(group => html`
              <div class="group-item ${group.id === this.groupId ? 'active' : ''}"
                   data-key="g:${group.id}" data-focusable>
                <span class="group-icon">${raw(group.icon)}</span>
                <span class="group-name">${group.label}</span>
                <span class="group-count">${group.count}</span>
              </div>`)}
          </div>
        </div>
        ${this.renderList(now)}
        ${this.renderPreview(now)}
        ${showHints ? this.renderHints() : ''}
      </div>`;
  }

  private renderList(now: number): Safe {
    const scroller = this.listEl();
    const viewport = scroller?.clientHeight || this.virtual.fallbackViewportSize;
    if (scroller) this.virtual.setScrollOffset(scroller.scrollTop);
    const range = this.virtual.getRange(this.list.length, viewport);
    const rows: Safe[] = [];
    for (let i = range.start; i < range.end; i++) rows.push(this.renderRow(this.list[i], i, now));
    const selected = this.groups.find(group => group.id === this.groupId);
    return html`
      <div class="sat-list-column" data-key="sat-list-column">
        <div class="sat-list-heading" data-key="sat-list-heading">
          <span class="sat-list-title">${selected ? selected.label : ''}</span>
          <span class="sat-list-count">${tp('channel.count', this.list.length)}</span>
        </div>
        <div class="channel-main sat-channel-main" data-key="sat-list">
          ${this.list.length
            ? html`<div class="channel-list-spacer" data-key="sat-spacer"
                        style="height:${this.virtual.getTotalSize(this.list.length)}px">${rows}</div>`
            : html`<div class="empty-state">${t(this.groupId === 'favorites' ? 'satellite.noFavorites' : 'satellite.emptyGroup')}</div>`}
        </div>
      </div>`;
  }

  private badges(channel: BroadcastChannel): Safe {
    return html`
      ${channel.hd ? html`<span class="sat-badge">${t('satellite.hd')}</span>` : ''}
      ${channel.kind === 'radio' ? html`<span class="sat-badge sat-badge-icon" title="${t('satellite.radio')}">${raw(ICONS.radio)}</span>` : ''}
      ${channel.scrambled ? html`<span class="sat-badge sat-badge-icon" title="${t('satellite.encrypted')}">${raw(KEY_ICON)}</span>` : ''}
      ${channel.locked ? html`<span class="sat-badge sat-badge-icon sat-badge-lock">${raw(LOCK_ICON)}</span>` : ''}`;
  }

  private renderRow(channel: BroadcastChannel, index: number, now: number): Safe {
    const playing = channel.id === this.playingId;
    const program = this.nowProgram(channel, now);
    return html`
      <div class="channel-item sat-channel ${playing ? 'playing' : ''}"
           data-key="c:${channel.id}" data-focusable style="top:${this.virtual.getItemOffset(index)}px">
        <span class="sat-number">${channel.numberLabel}</span>
        <div class="channel-info">
          <div class="channel-name" dir="auto">${this.favorites.has(channel.serviceKey) && this.groupId !== 'favorites'
            ? raw(favoriteIcon(true)) : ''}${channel.name}</div>
          ${program ? html`<div class="channel-now" dir="auto">${program.title}</div>` : ''}
        </div>
        <span class="sat-badges">${this.badges(channel)}</span>
        ${playing ? PLAYING_MARK : ''}
      </div>`;
  }

  // Whether a reading confirmed a picture (or radio sound) since the tune.
  private get confirmed(): boolean {
    const stats = this.stats;
    return !!stats && (stats.videoGood === true || stats.signal === 'good' || (stats.height ?? 0) > 0);
  }

  // The tuning state as the IPTV player words it, for the label at the
  // bottom leading edge; null when there is nothing to say.
  private status(channel: BroadcastChannel): { text: string; state: 'loading' | 'error' | 'info' } | null {
    if (channel.id !== this.playingId) return null;
    if (this.route === 'sample') return { text: t('satellite.samplePicture'), state: 'info' };
    if (this.tuneFailed) return { text: t('satellite.tuneFailed'), state: 'error' };
    if (this.videoStatus === 'error') return { text: t('satellite.noPicture'), state: 'error' };
    if (this.tuning) return { text: t('satellite.tuning'), state: 'loading' };
    if (channel.kind === 'radio') return this.noSignal ? { text: t('satellite.noSignal'), state: 'error' } : null;
    if (this.noSignal) return { text: t('satellite.noSignal'), state: 'error' };
    // Readings decide when the TV gives them; else the video's own grace.
    const reported = !!this.stats && (this.stats.signal != null || this.stats.videoGood != null);
    const waiting = reported ? !this.confirmed : (!this.stats || this.videoStatus === 'connecting');
    return waiting ? { text: t('satellite.tuning'), state: 'loading' } : null;
  }

  private renderStatus(channel: BroadcastChannel, extra = ''): Safe | '' {
    const status = this.status(channel);
    if (!status) return '';
    // Tuning says only that; a failure names the transponder it was on.
    const source = status.state === 'loading' ? ''
      : [channel.satellite, transponderText(channel)].filter(Boolean).join(' · ');
    return html`
      <div class="player-status sat-status ${extra}" data-key="sat-status" data-state="${status.state}" role="status">
        <div class="player-status-text">${status.text}</div>
        ${source ? html`<div class="player-status-engine">${source}</div>` : ''}
      </div>`;
  }

  private meter(label: string, value: number | null): Safe {
    const level = value === null ? 'none' : meterLevel(value);
    return html`
      <div class="sat-meter" data-level="${level}">
        <div class="sat-meter-top">
          <span class="sat-meter-label">${label}</span>
          <span class="sat-meter-value">${value === null ? '–' : `${String(value)}%`}</span>
        </div>
        <div class="sat-meter-bar"><div style="width:${String(value ?? 0)}%"></div></div>
      </div>`;
  }

  private qualityChips(stats: CachedStats | null): Safe {
    if (!stats || !stats.height) return html``;
    const parts = [
      resolutionLabel(stats),
      stats.fps ? `${String(Math.round(stats.fps * 100) / 100)} fps` : '',
      stats.codec,
      stats.hdr,
    ].filter(Boolean);
    return html`${parts.map(part => html`<span class="sat-quality-chip">${part}</span>`)}`;
  }

  // Under the preview, and as the OSD's last row: the satellite and full
  // transponder, how the picture looks, and how well it is received. Cached
  // values show at once, dimmed, until this tune's readings replace them.
  private renderSignal(channel: BroadcastChannel, compact: boolean): Safe | '' {
    const sample = this.route === 'sample';
    const stats = sample ? null : this.displayStats(channel);
    const live = !sample && this.isLive(channel);
    const transponder = transponderText(channel);
    return html`
      <div class="sat-signal ${compact ? 'sat-signal-compact' : ''} ${live ? '' : 'sat-signal-cached'}" data-key="sat-signal">
        <div class="sat-signal-head">
          ${channel.satellite ? html`<span class="sat-signal-source">${raw(ICONS.satellite)}<span>${channel.satellite}</span></span>` : ''}
          ${transponder ? html`<span class="sat-signal-frequency">${transponder}</span>` : ''}
          <span class="sat-signal-quality">${this.qualityChips(stats)}</span>
        </div>
        ${sample ? '' : html`
          <div class="sat-meters">
            ${this.meter(t('satellite.signalStrength'), stats ? stats.strength : null)}
            ${this.meter(t('satellite.signalQuality'), stats ? stats.quality : null)}
          </div>`}
      </div>`;
  }

  private renderPreview(now: number): Safe {
    const channel = this.previewChannel;
    if (!channel) return html`<aside class="sat-preview" data-key="sat-preview"></aside>`;
    const programs = BroadcastService.cachedPrograms(channel, now) ?? [];
    const current = programAt(programs, now);
    const upcoming = programs.filter(program => program.start >= (current ? current.end : now)).slice(0, UPCOMING_COUNT);
    const favorite = this.favorites.has(channel.serviceKey);
    const playing = channel.id === this.playingId;
    const control = this.area === 'preview' ? this.control : null;
    const length = current ? current.end - current.start : 0;
    const fraction = current && length > 0 ? Math.max(0, Math.min(1, (now - current.start) / length)) : 0;
    const remaining = current ? Math.max(0, Math.ceil((current.end - now) / 60000)) : 0;
    return html`
      <aside class="sat-preview" data-key="sat-preview">
        <div class="live-preview-heading" data-key="sat-preview-heading">
          <span class="sat-preview-number">${channel.numberLabel}</span>
          <span class="live-preview-channel" dir="auto">${channel.name}</span>
          <button class="live-preview-favorite" data-key="p:favorite" data-focusable
                  aria-label="${t('player.toggleFavorite')}" aria-pressed="${String(favorite)}">
            ${raw(favoriteIcon(favorite))}
          </button>
        </div>
        <div class="live-preview-slot sat-slot" data-key="sat-slot">
          ${playing && !this.status(channel) ? liveBadge('live-preview-badge') : ''}
          ${!playing ? html`<div class="live-preview-message sat-slot-message" data-key="sat-slot-message">${
            t('satellite.pressOk')}</div>` : ''}
          ${playing && channel.kind === 'radio' ? html`<div class="sat-slot-radio" data-key="sat-slot-radio">${
            raw(ICONS.radio)}<span>${t('satellite.radio')}</span></div>` : ''}
          ${this.renderStatus(channel)}
          <div class="live-preview-controls" data-key="sat-controls" data-nav-container>
            <button class="live-preview-button" data-key="p:fullscreen" data-focusable
                    aria-label="${t('preview.fullScreen')}">${raw(FULLSCREEN_ICON)}</button>
            <button class="live-preview-button" data-key="p:livetv" data-focusable
                    aria-label="${t('satellite.openLiveTv')}">${raw(TAB_LIVE_ICON)}</button>
          </div>
          ${control === 'fullscreen' || control === 'livetv' ? html`
            <div class="live-preview-legend" data-key="sat-legend">
              <span class="live-preview-hint"><span class="live-preview-key">OK</span>
                <span class="live-preview-hint-label">${
                  control === 'livetv' ? t('satellite.openLiveTv') : t('preview.fullScreen')}</span></span>
            </div>` : ''}
        </div>
        ${this.renderSignal(channel, false)}
        <div class="live-preview-details sat-details" data-key="sat-details">
          ${current ? html`
            <h2 class="live-preview-title" dir="auto">${current.title}</h2>
            <div class="live-preview-schedule">
              <time class="live-preview-time-range">${formatTime(new Date(current.start))} – ${formatTime(new Date(current.end))}</time>
              <span class="live-preview-remaining">${t('preview.timeLeft', { minutes: remaining })}</span>
            </div>
            <div class="live-preview-progress" role="progressbar" aria-label="${current.title}"
                 aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(fraction * 100)}">
              <div style="width:${fraction * 100}%"></div>
            </div>
            ${current.description ? html`<p class="sat-description" dir="auto">${current.description}</p>` : ''}`
          : html`<p class="live-preview-empty">${t('epg.noData')}</p>`}
          ${upcoming.length ? html`
            <div class="live-preview-upcoming">
              <h3>${t('player.upNext')}</h3>
              ${upcoming.map(program => html`
                <div class="live-preview-program" data-key="up:${String(program.start)}">
                  <time>${formatTime(new Date(program.start))}</time>
                  <span dir="auto">${program.title}</span>
                </div>`)}
            </div>` : ''}
          <div class="sat-meta" data-key="sat-meta">
            <span class="sat-chip">${channel.kind === 'radio' ? t('satellite.radio') : t('satellite.tv')}</span>
            ${channel.hd ? html`<span class="sat-chip">${t('satellite.hd')}</span>` : ''}
            <span class="sat-chip">${channel.scrambled ? t('satellite.encrypted') : t('satellite.freeToAir')}</span>
          </div>
        </div>
      </aside>`;
  }

  private renderHints(): Safe {
    const channel = this.focusedChannel;
    const fullscreen = !!channel && channel.id === this.playingId && !this.tuneFailed && !this.tuning;
    return html`
      <div class="edit-hints sat-hints" data-key="sat-hints">
        <span class="edit-hint"><span class="edit-key key-ok">OK</span><span>${
          fullscreen ? t('preview.fullScreen') : t('satellite.watch')}</span></span>
        <span class="edit-hint"><span class="edit-key key-green"></span><span>${t('satellite.favorite')}</span></span>
        <span class="edit-hint"><span class="edit-key key-yellow"></span><span>${t('satellite.openLiveTv')}</span></span>
        <span class="edit-hint sat-hint-digits"><span class="edit-key key-ok">0–9</span><span>${t('satellite.channelNumber')}</span></span>
      </div>`;
  }

  private renderPanel(now: number): Safe {
    const ring = this.ring;
    const list = this.panelEl();
    if (list) this.panelVirtual.setScrollOffset(list.scrollTop);
    const range = this.panelOpen ? this.panelVirtual.getRange(ring.length, list?.clientHeight || 900) : { start: 0, end: 0 };
    const group = this.list.length ? this.groups.find(item => item.id === this.groupId) : undefined;
    const rows: Safe[] = [];
    for (let i = range.start; i < range.end; i++) {
      const channel = ring[i];
      const program = this.nowProgram(channel, now);
      rows.push(html`
        <div class="sidebar-ch-item ${channel.id === this.playingId ? 'playing' : ''}" data-key="q:${channel.id}"
             data-focusable style="top:${String(this.panelVirtual.getItemOffset(i))}px">
          <span class="ch-num">${channel.numberLabel}</span>
          <div class="ch-info">
            <span class="ch-name"><span class="ch-name-text" dir="auto">${channel.name}</span></span>
            ${program ? html`<span class="ch-now"><span class="ch-now-text" dir="auto">${program.title}</span></span>` : ''}
          </div>
        </div>`);
    }
    return html`
      <div class="player-sidebar sat-panel ${this.panelOpen ? 'visible channels-only' : 'hidden'}" data-key="sat-panel">
        <div class="sidebar-channel-panel">
          <div class="sidebar-title">
            <span class="sidebar-title-icon">${raw(LIVE_CATEGORIES_ICON)}</span>
            <span class="sidebar-title-label">${group ? group.label : t('satellite.allChannels')}</span>
          </div>
          <div class="sidebar-channel-list sat-panel-list" data-key="sat-panel-list">
            <div class="sidebar-channel-spacer" style="height:${String(this.panelVirtual.getTotalSize(ring.length))}px">${rows}</div>
          </div>
        </div>
      </div>`;
  }

  private renderFullscreen(): Safe | '' {
    const channel = this.osdChannel;
    if (!channel) return '';
    const now = Date.now();
    const cached = BroadcastService.cachedPrograms(channel, now);
    const loaded = !!cached;
    const programs = cached ?? [];
    const current = programAt(programs, now);
    const next = programs.find(program => program.start >= (current ? current.end : now)) ?? null;
    const length = current ? current.end - current.start : 0;
    const fraction = current && length > 0 ? Math.max(0, Math.min(1, (now - current.start) / length)) : 0;
    const remaining = current ? Math.max(0, Math.ceil((current.end - now) / 60000)) : 0;
    const zapping = !!this.zapId;
    // The program rows keep their place whether or not the guide has
    // answered yet, so the panel never jumps when it does.
    return html`
      ${zapping ? '' : this.renderStatus(channel)}
      ${!zapping && channel.kind === 'radio' ? html`<div class="sat-slot-radio sat-fs-radio" data-key="sat-fs-radio">${
        raw(ICONS.radio)}<span>${t('satellite.radio')}</span></div>` : ''}
      ${this.renderPanel(now)}
      <div class="sat-osd ${this.osdVisible && !this.panelOpen ? 'visible' : ''}" data-key="sat-osd">
        <div class="sat-osd-panel">
          <div class="sat-osd-row">
            <span class="sat-osd-number">${channel.numberLabel}</span>
            <span class="sat-osd-name" dir="auto">${this.favorites.has(channel.serviceKey) ? raw(favoriteIcon(true)) : ''}${channel.name}</span>
            ${liveBadge()}
            <span class="sat-badges">${this.badges(channel)}</span>
            <span class="sat-osd-clock">${formatTime(new Date(now))}</span>
          </div>
          <div class="sat-osd-guide">
            <div class="sat-osd-slot sat-osd-now">
              <span class="sat-osd-label">${t('player.now')}</span>
              <span class="sat-osd-title ${current ? '' : 'sat-osd-muted'}" dir="auto">${
                current ? current.title : loaded ? t('epg.noData') : ''}</span>
              <time class="sat-osd-time">${current ? timeRange(current) : ''}</time>
            </div>
            <div class="sat-osd-slot sat-osd-elapsed">
              <span class="sat-osd-label"></span>
              <div><div class="sat-osd-progress"><div style="width:${fraction * 100}%"></div></div></div>
              <span class="sat-osd-remaining">${current ? t('preview.timeLeft', { minutes: remaining }) : ''}</span>
            </div>
            <div class="sat-osd-slot sat-osd-next ${next ? '' : 'empty'}">
              <span class="sat-osd-label">${t('player.upNext')}</span>
              <span class="sat-osd-title" dir="auto">${next ? next.title : ''}</span>
              <time class="sat-osd-time">${next ? timeRange(next) : ''}</time>
            </div>
          </div>
          ${this.renderSignal(channel, true)}
        </div>
      </div>`;
  }
}
