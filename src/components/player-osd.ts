import type { Action, CatchupInfo, Channel, Programme } from '../types';
import { CONFIG } from '../config';
import { Focus, type FocusScope } from '../navigation/focus-scope';
import { StorageService } from '../services/storage-service';
import { $, hide, html, inShownView, raw, type Safe, show } from '../utils/dom';
import { type DvrState } from '../utils/dvr';
import { morph } from '../utils/morph';
import { clockTime, onClockTick } from '../utils/clock';
import { formatDuration, formatPosition, formatTime, getProgress } from '../utils/time';
import { t, tp } from '../i18n';
import { EPISODES_ICON, INFO_ICON, NEXT_EPISODE_ICON, PAUSE_ICON, PLAY_ICON, PLAYER_MENU_ICON, seekIcon } from './icons';

/** A movie/episode control a remote key also drives, lit briefly when it does. */
export type VodControl = 'rewind' | 'playpause' | 'forward';
const PRESS_MS = 220;

/** An OSD control the D-pad can hold, by its `data-key`. */
export type OsdControl = 'seek' | 'rewind' | 'playpause' | 'forward' | 'skipintro' | 'info' | 'golive' | 'menu' | 'episodes' | 'next';
// The bar is its own row above the buttons, wherever it is drawn.
const CONTROL_ROWS: readonly (readonly OsdControl[])[] = [
  ['seek'],
  ['rewind', 'playpause', 'forward', 'skipintro', 'info', 'golive', 'menu', 'episodes', 'next'],
];

export interface PlayerOsdSnapshot {
  playback: {
    position: number;
    duration: number;
    paused: boolean;
  } | null;
  channel: Channel | null;
  channelNumber: number;
  catchup: CatchupInfo | null;
  vodTitle: string | null;
  /** An episode follows in the queue, so the controls offer Next episode. */
  vodHasNext: boolean;
  /** Playback is inside the stream's marked intro, so the controls offer Skip intro. */
  vodInIntro: boolean;
  /** The title has details, so the controls offer Title Info. */
  vodHasInfo: boolean;
  /** An episode of a series whose episode list the player holds. */
  vodHasEpisodes: boolean;
  upNextSeconds: number;
  dvr: DvrState | null;
  nowPlaying: Programme | null;
  streamInfo: PlayerOsdStreamInfo | null;
}

export interface PlayerOsdStreamInfo {
  resolution: {
    tier: string;
    label: string;
  } | null;
  hdr: string;
  drm: string;
  fps: string;
  videoCodec: string;
  audioCodec: string;
  audio: string;
  subtitle: string;
}

export interface PlayerOsdOptions {
  getSnapshot: () => PlayerOsdSnapshot;
  canAutoReveal: () => boolean;
  /** A side panel opened from the controls covers them: they stay up under it. */
  isCovered: () => boolean;
  canSeek: () => boolean;
  onSeekFraction: (fraction: number) => void;
  onPauseToggle: () => void;
  onGoLive: () => void;
  onPlayNext: () => void;
  onCancelNext: () => void;
  onSeekStep: (direction: -1 | 1) => void;
  onNextEpisode: () => void;
  onSkipIntro: () => void;
  onShowInfo: () => void;
  onShowEpisodes: () => void;
  onOpenMenu: () => void;
  onSurfaceClick: () => void;
}

interface OsdProgramme {
  icon: string;
  title: string;
  /** Beside the title: time remaining, or a recording's length. */
  note: string;
}

// Panels over the picture that own their clicks; while one shows, a click
// elsewhere doesn't reach the picture either.
const PANEL_SELECTORS = ['#player-sidebar', '#player-menu', '#subtitle-search', '#subtitle-offset', '#vod-info', '#vod-episodes'];

function audioTrackText(name: string): string {
  const label = t('player.audioTrack');
  return name === label || name.startsWith(`${label} `) ? name : `${label}: ${name}`;
}

export class PlayerOsd {
  private visible = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pointerX: number | null = null;
  private pointerY: number | null = null;
  // Programme-icon URLs that failed to load, so a re-render omits them instead of
  // re-requesting a broken image (which would thrash the OSD layout).
  private failedIcons = new Set<string>();
  private pressed: VodControl | null = null;
  private pressTimer: ReturnType<typeof setTimeout> | null = null;
  private scope: FocusScope | null = null;
  private focusKey: OsdControl | null = null;

  constructor(private container: HTMLElement, private callbacks: PlayerOsdOptions) {
    // Activate OSD controls on click by coordinate hit-test (vs e.target) since
    // they sit over the video plane. The persistent container is marked so the
    // global click handler skips this self-activating subtree.
    container.setAttribute('data-self-activate', '');
    // eslint-disable-next-line focus/no-raw-pointer-listener -- OSD auto-hide is an activity signal, not focus
    container.addEventListener('mousemove', (e: MouseEvent) => {
      this.pointerX = e.clientX;
      this.pointerY = e.clientY;
      // An active cursor reveals the OSD (and its controls) so there's
      // something to aim at; keep it up while the cursor keeps moving.
      if (this.visible) this.resetTimer();
      else if (this.callbacks.canAutoReveal()) this.show();
    });
    container.addEventListener('click', (e: MouseEvent) => this.onPointerRelease(e.clientX, e.clientY, e.target));
    onClockTick(time => this.setClock(time));
    // A broken programme icon: record its URL (capture — `error` doesn't bubble)
    // and re-render so morph drops it and never re-requests it.
    container.addEventListener('error', (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (!(target instanceof HTMLImageElement) ||
          !target.classList.contains('osd-programme-icon')) return;
      const src = target.getAttribute('src');
      if (src && !this.failedIcons.has(src)) {
        this.failedIcons.add(src);
        if (this.visible) this.render();
      }
    }, true);
  }

  isVisible(): boolean {
    return this.visible;
  }

  // The time of day sits in the screen's top right corner, outside the OSD
  // panel, and shows with it. A hidden one keeps its stale time.
  private setClock(time: string): void {
    const clock = $('.osd-clock', this.container) as HTMLElement | null;
    if (!clock) return;
    if (!this.visible) { hide(clock); return; }
    clock.setAttribute('datetime', time);
    clock.textContent = time;
    show(clock);
  }

  pointerPosition(): { x: number | null; y: number | null } {
    return { x: this.pointerX, y: this.pointerY };
  }

  // The picture sits outside the OSD container, so the player forwards its clicks.
  pointerRelease(e: MouseEvent): void {
    this.onPointerRelease(e.clientX, e.clientY, e.target);
  }

  clearPointer(): void {
    this.pointerX = null;
    this.pointerY = null;
  }

  clearFailedIcons(): void {
    this.failedIcons.clear();
  }

  show(): void {
    this.visible = true;
    this.render();
    const osd = $('#player-osd', this.container);
    if (osd) show(osd);
    this.setClock(clockTime());
    this.resetTimer();
  }

  hide(): void {
    this.visible = false;
    this.setClock('');
    this.releaseFocus();
    this.clearPressed();
    const osd = $('#player-osd', this.container);
    if (osd) hide(osd);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Light a control a remote key just drove, as a press would. */
  flash(control: VodControl): void {
    this.clearPressed();
    this.pressed = control;
    if (this.visible) this.render();
    this.pressTimer = setTimeout(() => {
      this.pressTimer = null;
      this.pressed = null;
      if (this.visible) this.render();
    }, PRESS_MS);
  }

  private clearPressed(): void {
    if (this.pressTimer) clearTimeout(this.pressTimer);
    this.pressTimer = null;
    this.pressed = null;
  }

  focusedControl(): OsdControl | null {
    return this.focusKey;
  }

  /** Put the ring on `key`, or on the nearest control drawn; false when none is. */
  focusControl(key: OsdControl): boolean {
    const osd = $('#player-osd', this.container);
    if (!this.visible || !osd) return false;
    const target = this.drawn(key) ? key : this.rows()[0]?.[0];
    if (!target) return false;
    if (!this.scope) {
      this.scope = Focus.register({
        id: 'player.controls',
        root: osd,
        when: () => inShownView(osd),
        defaultKey: () => this.focusKey,
      });
    }
    if (this.focusKey === null) Focus.push(this.scope);
    this.focusKey = target;
    this.scope.focus(target, 'key');
    Focus.flush();
    return true;
  }

  releaseFocus(): void {
    if (this.focusKey === null) return;
    this.focusKey = null;
    if (this.scope) Focus.pop(this.scope);
  }

  /** A key while a control holds the ring: Left/Right seek on the bar and move
   *  along a row elsewhere, Up/Down move between rows, OK activates. False
   *  when the key is not the controls' to take. */
  handleKey(action: Action): boolean {
    const key = this.focusKey;
    if (key === null || !this.visible) return false;
    const rows = this.rows();
    const r = rows.findIndex(row => row.indexOf(key) >= 0);
    if (r < 0) { this.releaseFocus(); return false; }
    const row = rows[r];
    const i = row.indexOf(key);
    switch (action) {
      case 'left':
      case 'right':
        if (key === 'seek') this.callbacks.onSeekStep(action === 'left' ? -1 : 1);
        else this.focusControl(row[Math.max(0, Math.min(row.length - 1, i + (action === 'left' ? -1 : 1)))]);
        return true;
      case 'up':
      case 'down': {
        // A lone row leaves Up/Down to the channels.
        if (rows.length < 2) return false;
        const next = rows[Math.max(0, Math.min(rows.length - 1, r + (action === 'up' ? -1 : 1)))];
        if (next !== row) this.focusControl(next.indexOf('playpause') >= 0 ? 'playpause' : next[0]);
        return true;
      }
      case 'select':
        this.activate(key);
        return true;
      default:
        return false;
    }
  }

  private activate(key: OsdControl): void {
    switch (key) {
      case 'seek':
      case 'playpause': this.callbacks.onPauseToggle(); break;
      case 'rewind': this.callbacks.onSeekStep(-1); break;
      case 'forward': this.callbacks.onSeekStep(1); break;
      case 'golive': this.callbacks.onGoLive(); break;
      case 'menu': this.callbacks.onOpenMenu(); break;
      case 'next': this.callbacks.onNextEpisode(); break;
      case 'skipintro': this.callbacks.onSkipIntro(); break;
      case 'info': this.callbacks.onShowInfo(); break;
      case 'episodes': this.callbacks.onShowEpisodes(); break;
    }
  }

  // The rows of controls this render drew, in reading order.
  private rows(): OsdControl[][] {
    return CONTROL_ROWS
      .map(row => row.filter(key => this.drawn(key)))
      .filter(row => row.length > 0);
  }

  private drawn(key: OsdControl): boolean {
    const osd = $('#player-osd', this.container);
    return !!osd && !!osd.querySelector(`[data-key="${key}"]`);
  }

  toggle(): void {
    if (this.visible) this.hide(); else this.show();
  }

  resetTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // Keep the OSD up while paused (live DVR or catch-up): nothing to fall behind.
    const snapshot = this.callbacks.getSnapshot();
    if (snapshot.playback?.paused || this.callbacks.isCovered()) return;
    this.timer = setTimeout(() => this.hide(), StorageService.getPlayerOsdTimeoutMs());
  }

  render(): void {
    const osd = $('#player-osd', this.container);
    if (!osd) return;
    const state = this.callbacks.getSnapshot();
    // Movies and episodes draw their controls on the video, not in a panel.
    osd.classList.toggle('osd-vod', state.vodTitle !== null);
    if (state.vodTitle !== null) this.renderVod(osd, state);
    else if (state.channel) this.renderLive(osd, state);
    // The ring cannot stay on a control this render didn't draw.
    if (this.focusKey !== null && !this.drawn(this.focusKey)) this.releaseFocus();
  }

  // Live is at most two lines beside the channel logo: the channel and what is
  // on, then the progress row when there is one.
  private renderLive(osd: HTMLElement, state: PlayerOsdSnapshot): void {
    const channel = state.channel;
    if (!channel) return;
    const paused = state.playback?.paused ?? false;

    // Now / Timeshift / Catch-up, beside the channel name.
    let label = '';
    let info: OsdProgramme | null = null;
    let progressRow: Safe | string = '';
    if (state.catchup) {
      // Catch-up playback: show the selected programme's info. The bar tracks the
      // video's playback position (a seekable VOD), not wall-clock time.
      const catchup = state.catchup;
      const start = new Date(catchup.start * 1000);
      const end = new Date(catchup.end * 1000);
      const playback = state.playback;
      const dur = playback && Number.isFinite(playback.duration) && playback.duration > 0
        ? playback.duration
        : catchup.end - catchup.start;
      const pos = playback ? Math.min(playback.position, dur) : 0;
      label = t('common.catchup');
      info = {
        icon: catchup.icon,
        title: catchup.title,
        note: formatDuration(end.getTime() - start.getTime()),
      };
      progressRow = html`
        <div class="osd-progress-row">
          ${this.playPauseButton(paused)}
          <span class="osd-time-current">${formatPosition(pos)}</span>
          <div class="osd-progress" data-seekbar data-focusable data-key="seek">
            <div class="osd-progress-bar" style="width: ${dur > 0 ? (pos / dur) * 100 : 0}%"></div>
          </div>
          <span class="osd-time-end">${formatPosition(dur)}</span>
        </div>
      `;
    } else if (state.nowPlaying || state.dvr) {
      // Live playback. Show EPG programme info, and a DVR timeshift bar when the
      // stream exposes a usable seekable window.
      const nowPlaying = state.nowPlaying;
      label = t(state.dvr && !state.dvr.atLiveEdge ? 'player.timeshift' : 'player.now');
      if (nowPlaying) {
        info = {
          icon: nowPlaying.icon,
          title: nowPlaying.title,
          note: t('player.remaining', {
            duration: formatDuration(nowPlaying.stop.getTime() - Date.now()),
          }),
        };
      }
      if (state.dvr) {
        progressRow = this.dvrProgressRow(state.dvr, paused);
      } else if (nowPlaying) {
        progressRow = html`
          <div class="osd-progress-row">
            <span class="osd-time-current">${formatTime(new Date())}</span>
            <div class="osd-progress">
              <div class="osd-progress-bar"
                style="width: ${getProgress(nowPlaying.start, nowPlaying.stop) * 100}%"></div>
            </div>
            <span class="osd-time-end">${formatTime(nowPlaying.stop)}</span>
          </div>
        `;
      }
    }
    morph(osd, html`
      <div class="osd-live">
        ${channel.logo ? html`<img class="osd-channel-logo" src="${channel.logo}" alt="">` : ''}
        <div class="osd-col">
          <div class="osd-channel">
            <div class="osd-channel-number">${state.channelNumber}</div>
            <div class="osd-channel-name">${channel.name}</div>
            ${label ? html`<span class="osd-now-label">${label}</span>` : ''}
            ${info ? html`
              ${this.programmeIcon(info.icon)}
              <div class="osd-programme-title">${info.title}</div>
              <span class="osd-remaining">${info.note}</span>
            ` : ''}
            ${this.renderStreamInfo(state.streamInfo)}
          </div>
          ${progressRow}
        </div>
      </div>
    `);
  }

  refreshProgress(): void {
    if (!this.visible) return;
    const state = this.callbacks.getSnapshot();
    const playback = state.playback;
    if (!playback) return;
    if (state.vodTitle !== null) {
      const dur = Number.isFinite(playback.duration) ? playback.duration : 0;
      this.setProgress(dur > 0 ? Math.min(playback.position, dur) / dur : 0);
      const current = $('.osd-time-current', this.container);
      if (current) current.textContent = formatPosition(playback.position);
      // The intro starts or ends: draw or drop Skip intro.
      if (state.vodInIntro !== this.drawn('skipintro') && state.upNextSeconds <= 0) this.render();
      return;
    }
    const hasDvrBar = !!$('[data-golive]', this.container);
    // DVR availability can flip after the OSD is already open (the seekable
    // window fills in a beat after tune-in). When the current layout no longer
    // matches, do a full render so the DVR bar appears/disappears on its own.
    if (!!state.dvr !== hasDvrBar) {
      this.render();
      return;
    }
    if (state.dvr) {
      this.setProgress(state.dvr.fraction);
      const behind = $('.osd-dvr-behind', this.container);
      if (behind) {
        behind.textContent = state.dvr.atLiveEdge
          ? t('common.live')
          : `-${formatPosition(state.dvr.behindLive)}`;
      }
      const live = $('.osd-dvr-live', this.container) as HTMLElement | null;
      if (live) live.classList.toggle('is-live', state.dvr.atLiveEdge);
      return;
    }
    if (!state.catchup || !Number.isFinite(playback.duration) || playback.duration <= 0) return;
    this.setProgress(Math.min(playback.position, playback.duration) / playback.duration);
    const current = $('.osd-time-current', this.container);
    if (current) current.textContent = formatPosition(playback.position);
  }

  /** Seek to the bar position under (x, y) when it's over the seek bar; returns
   *  whether it seeked. Used by both pointer clicks and OK over the bar. */
  seekAtPointer(x: number | null, y: number | null): boolean {
    if (x === null || y === null || !this.callbacks.canSeek()) return false;
    const bar = $('[data-seekbar]', this.container) as HTMLElement | null;
    if (!bar) return false;
    const rect = bar.getBoundingClientRect();
    const margin = 20;
    const hit = rect.width > 0 && x >= rect.left && x <= rect.right &&
      y >= rect.top - margin && y <= rect.bottom + margin;
    if (!hit) return false;
    this.callbacks.onSeekFraction((x - rect.left) / rect.width);
    return true;
  }

  // The VOD OSD reuses the Live markup: an `.osd-channel` header (movie/episode
  // title + shared stream-info) over the shared seekable `.osd-progress-row`.
  private renderVod(osd: HTMLElement, state: PlayerOsdSnapshot): void {
    if (state.upNextSeconds > 0) {
      morph(osd, html`
        <div class="osd-next-episode">
          <div class="osd-next-episode-label">${t('player.upNext')}</div>
          <div class="osd-channel-name">${state.vodTitle ?? ''}</div>
          <div class="osd-next-episode-time">${tp('player.playingIn', state.upNextSeconds)}</div>
          <div class="osd-actions">
            <button data-next-play>${t('player.playNow')}</button>
            <button data-next-cancel>${t('common.cancel')}</button>
          </div>
        </div>
      `);
      return;
    }
    const playback = state.playback;
    const dur = playback && Number.isFinite(playback.duration) ? playback.duration : 0;
    const pos = playback ? Math.min(playback.position, dur || Infinity) : 0;
    const paused = playback?.paused ?? false;
    const step = CONFIG.PLAYER.SEEK_STEP;
    morph(osd, html`
      <div class="osd-channel">
        <div class="osd-channel-name">${state.vodTitle ?? ''}</div>
        ${this.renderStreamInfo(state.streamInfo)}
      </div>
      <div class="osd-vod-progress">
        <div class="osd-progress" data-seekbar data-focusable data-key="seek">
          <div class="osd-progress-bar" style="width: ${dur > 0 ? (pos / dur) * 100 : 0}%"></div>
        </div>
      </div>
      <div class="osd-vod-controls">
        <div class="osd-vod-transport">
          <button class="osd-vod-btn${this.pressedClass('rewind')}" data-rewind data-focusable data-key="rewind"
                  aria-label="${t('player.rewind')}">${raw(seekIcon('back', step))}</button>
          <button class="osd-vod-btn osd-vod-btn--main${this.pressedClass('playpause')}" data-playpause
                  data-focusable data-key="playpause" aria-label="${t(paused ? 'player.play' : 'player.pause')}">${raw(paused ? PLAY_ICON : PAUSE_ICON)}</button>
          <button class="osd-vod-btn${this.pressedClass('forward')}" data-forward data-focusable data-key="forward"
                  aria-label="${t('player.fastForward')}">${raw(seekIcon('forward', step))}</button>
          <span class="osd-vod-time"><span class="osd-time-current">${formatPosition(pos)}</span>${
            dur > 0 ? html` / <span class="osd-time-end">${formatPosition(dur)}</span>` : ''}</span>
        </div>
        <div class="osd-vod-aside">
          ${state.vodInIntro ? html`
            <button class="osd-vod-next osd-vod-skip" data-focusable data-key="skipintro" data-skip-intro>
              <span>${t('player.skipIntro')}</span>
            </button>` : ''}
          ${state.vodHasInfo ? html`
            <button class="osd-vod-btn osd-vod-btn--small" data-info data-focusable data-key="info"
                    aria-label="${t('player.titleInfo')}">
              ${raw(INFO_ICON)}
            </button>` : ''}
          <button class="osd-vod-btn osd-vod-btn--small" data-menu data-focusable data-key="menu"
                  aria-label="${t('player.menu')}">
            ${raw(PLAYER_MENU_ICON)}
          </button>
          ${state.vodHasEpisodes ? html`
            <button class="osd-vod-btn osd-vod-btn--small" data-episodes data-focusable data-key="episodes"
                    aria-label="${t('player.episodes')}">
              ${raw(EPISODES_ICON)}
            </button>` : ''}
          ${state.vodHasNext ? html`
            <button class="osd-vod-btn osd-vod-btn--small" data-next-episode data-focusable data-key="next"
                    aria-label="${t('player.nextEpisode')}">
              ${raw(NEXT_EPISODE_ICON)}
            </button>` : ''}
        </div>
      </div>
    `);
  }

  private pressedClass(control: VodControl): string {
    return this.pressed === control ? ' is-pressed' : '';
  }

  /** The programme icon `<img>`, or nothing if it has no URL or that URL already
   *  failed to load. Keyed by URL so morph reuses a loaded icon across re-renders
   *  (no reload/flicker); the delegated error listener drops a broken one. */
  private programmeIcon(url: string): Safe | string {
    if (!url || this.failedIcons.has(url)) return '';
    return html`<img class="osd-programme-icon" data-key="prog-icon:${url}" src="${url}" alt="">`;
  }

  /** The shared OSD play/pause button (live DVR and catch-up). Pointer-hit-tested
   *  by onPointerRelease and toggled by OK from Player.handleAction. */
  private playPauseButton(paused: boolean): Safe {
    return html`
      <button class="osd-btn osd-btn--play" data-playpause data-focusable data-key="playpause"
        aria-label="${t(paused ? 'player.play' : 'player.pause')}">
        ${paused ? raw(PLAY_ICON) : raw(PAUSE_ICON)}
      </button>
    `;
  }

  private dvrProgressRow(state: DvrState, paused: boolean): Safe {
    return html`
      <div class="osd-progress-row osd-dvr-row">
        ${this.playPauseButton(paused)}
        <span class="osd-time-current osd-dvr-behind">${state.atLiveEdge
          ? t('common.live')
          : `-${formatPosition(state.behindLive)}`}</span>
        <div class="osd-progress" data-seekbar data-focusable data-key="seek">
          <div class="osd-progress-bar" style="width: ${state.fraction * 100}%"></div>
        </div>
        <button class="osd-time-end osd-dvr-live ${state.atLiveEdge ? 'is-live' : ''}"
          data-golive data-focusable data-key="golive"
          aria-label="${t('player.goLive')}">${t('common.live')}</button>
      </div>
    `;
  }

  // The stream-info badges (resolution / HDR / DRM / fps / codecs / audio / subtitle),
  // shared by the Live and VOD OSD.
  private renderStreamInfo(info: PlayerOsdStreamInfo | null): Safe | string {
    if (!info) return '';
    return html`
      <div class="osd-stream-info">
        ${info.resolution
          ? html`<span class="si-badge si-badge--${info.resolution.tier}">${
              info.resolution.label
            }</span>`
          : ''}
        ${info.hdr ? html`<span class="si-badge si-badge--hdr">${info.hdr}</span>` : ''}
        ${info.drm ? html`<span class="si-pill">${info.drm}</span>` : ''}
        ${info.fps ? html`<span class="si-pill">${info.fps}fps</span>` : ''}
        ${info.videoCodec ? html`<span class="si-pill">${info.videoCodec}</span>` : ''}
        ${info.audioCodec ? html`<span class="si-pill">${info.audioCodec}</span>` : ''}
        ${info.audio ? html`<span class="si-text">${audioTrackText(info.audio)}</span>` : ''}
        ${info.subtitle ? html`<span class="si-text">${t('player.subtitlesTrack', { name: info.subtitle })}</span>` : ''}
      </div>
    `;
  }

  private setProgress(fraction: number): void {
    const bar = $('.osd-progress-bar', this.container) as HTMLElement | null;
    if (bar) bar.style.width = `${fraction * 100}%`;
  }

  /** A pointer release: seek if it landed on the bar, else activate the play/pause,
   *  Go-to-Live, or menu control under it. Coordinates are used because the OSD
   *  controls sit over the video plane. */
  private onPointerRelease(x: number, y: number, target: EventTarget | null): void {
    const state = this.callbacks.getSnapshot();
    if (state.upNextSeconds > 0) {
      if (this.hitsControl('[data-next-play]', x, y)) this.callbacks.onPlayNext();
      else if (this.hitsControl('[data-next-cancel]', x, y)) this.callbacks.onCancelNext();
      return;
    }
    if (this.seekAtPointer(x, y)) return;
    if (state.vodTitle !== null) {
      if (this.hitsControl('[data-rewind]', x, y)) { this.callbacks.onSeekStep(-1); return; }
      if (this.hitsControl('[data-forward]', x, y)) { this.callbacks.onSeekStep(1); return; }
      if (this.hitsControl('[data-next-episode]', x, y)) { this.callbacks.onNextEpisode(); return; }
      if (this.hitsControl('[data-skip-intro]', x, y)) { this.callbacks.onSkipIntro(); return; }
      if (this.hitsControl('[data-info]', x, y)) { this.callbacks.onShowInfo(); return; }
      if (this.hitsControl('[data-episodes]', x, y)) { this.callbacks.onShowEpisodes(); return; }
    }
    if (this.hitsControl('[data-playpause]', x, y)) this.callbacks.onPauseToggle();
    else if (this.hitsControl('[data-golive]', x, y)) this.callbacks.onGoLive();
    else if (this.hitsControl('[data-menu]', x, y)) this.callbacks.onOpenMenu();
    // Magic Remote OK with the cursor shown arrives as a click, so a click on
    // the bare picture acts as OK does.
    else if (this.onSurface(target)) this.callbacks.onSurfaceClick();
  }

  private onSurface(target: EventTarget | null): boolean {
    if (!(target instanceof Element) || target.closest('button, [data-focusable]')) return false;
    return !PANEL_SELECTORS.some(selector => {
      const panel = $(selector, this.container);
      return panel !== null && (!panel.classList.contains('hidden') || panel.contains(target));
    });
  }

  private hitsControl(selector: string, x: number, y: number): boolean {
    const element = $(selector, this.container) as HTMLElement | null;
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && x >= rect.left && x <= rect.right &&
      y >= rect.top && y <= rect.bottom;
  }
}
