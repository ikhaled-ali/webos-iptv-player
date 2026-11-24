import type {
  Action, Channel, PlaylistEntry, Programme, Reminder, ResumeEntry, SeriesItem, VodItem, WatchlistEntry,
} from '../types';
import { SpatialNav } from '../navigation/spatial-nav';
import { Focus, type FocusScope } from '../navigation/focus-scope';
import { html, raw, scrollInsetTop, type Safe } from '../utils/dom';
import { morph } from '../utils/morph';
import { onClockTick } from '../utils/clock';
import { formatDayLabel, formatTime } from '../utils/time';
import { channelKey } from '../utils/channel';
import { latestPerSeries, resumeSeriesId } from '../utils/vod-progress';
import { t, type TextMessageKey } from '../i18n';
import { CONFIG } from '../config';
import { EpgService } from '../services/epg-service';
import { PlaylistService } from '../services/playlist-service';
import { ReminderService } from '../services/reminder-service';
import { StorageService } from '../services/storage-service';
import {
  loadAllSeries, loadAllVodStreams,
} from '../services/xtream-catalog';
import {
  isResumeConcealed,
  isSeriesConcealed,
  isWatchlistConcealed,
  isVodConcealed,
  liveParentalRequest,
  ParentalControlService,
} from '../services/parental-control';
import { resumeLockBadge, seriesLockBadge, vodLockBadge } from './parental-badge';
import { bellIcon } from './icons';
import { RemoveTip } from './remove-tip';
import { showToast } from './toast';
import { channelCard, channelSeeAllCard, posterCard, posterSeeAllCard } from './item-cards';

// The rows with a See all tile, each opening its full list in its own section.
export type HomeRow = 'resume' | 'watchlist' | 'recent' | 'favorites' | 'top' | 'new' | 'reminders';

export interface HomeChannel {
  channel: Channel;
  channelIndex: number;
}

export type HomeTitle =
  | { kind: 'vod'; item: VodItem }
  | { kind: 'series'; item: SeriesItem };

export interface HomeCatalog {
  topRated: VodItem[];
  recentlyAdded: HomeTitle[];
}

// Where Home reads from; the app passes the live services, tests a stub.
export interface HomeSources {
  recent(): HomeChannel[];
  favorites(): HomeChannel[];
  nowPlaying(channel: Channel): Programme | null;
  resume(): ResumeEntry[];
  // Movies and series together, newest first.
  watchlist(): WatchlistEntry[];
  // The catalog rows, once loaded for the active account; loadCatalog reads
  // it in the background and calls onReady when it changes.
  catalog(): HomeCatalog | null;
  loadCatalog(onReady: () => void): void;
  reminders(now: number): Reminder[];
  hasXtream(): boolean;
  // The live channel playing now, or -1.
  playingIndex(): number;
  // Drops an item from its row's list (Continue watching, Recently watched,
  // or the Watchlist).
  remove(item: HomeRemoval): void;
}

export type HomeRemoval =
  | { row: 'resume'; entry: ResumeEntry }
  | { row: 'recent'; channel: Channel }
  | { row: 'watchlist'; entry: WatchlistEntry };

// A row's first items; `more` when it holds more than a row shows.
export interface HomeRail<T> {
  items: T[];
  more: boolean;
}

export type HomeChannelItem = HomeChannel & { now: Programme | null };

export interface HomeModel {
  resume: HomeRail<ResumeEntry>;
  watchlist: HomeRail<WatchlistEntry>;
  recent: HomeRail<HomeChannelItem>;
  favorites: HomeRail<HomeChannelItem>;
  topRated: HomeRail<VodItem>;
  recentlyAdded: HomeRail<HomeTitle>;
  reminders: HomeRail<Reminder>;
}

// Each row shows this many, then See all opens the full list.
export const HOME_ROW_ITEMS = 10;
// Extra catalog picks leave room for titles parental controls hide, and still
// tell whether there are more than a row shows.
const CATALOG_PICKS = HOME_ROW_ITEMS * 3;

const REMOVE_LABELS: Record<HomeRemoval['row'], { action: TextMessageKey; done: TextMessageKey }> = {
  resume: { action: 'catalog.removeContinueWatching', done: 'catalog.continueWatchingRemoved' },
  recent: { action: 'home.removeRecentlyWatched', done: 'home.recentlyWatchedRemoved' },
  watchlist: { action: 'catalog.removeWatchlist', done: 'catalog.watchlistRemoved' },
};

// Kept apart from the scroller's edge when a focused row or tile is revealed.
const REVEAL_MARGIN_Y = 24;
// The rail track's side padding, which holds a focused tile's growth.
const REVEAL_MARGIN_X = 80;

function rail<T>(items: readonly T[]): HomeRail<T> {
  return { items: items.slice(0, HOME_ROW_ITEMS), more: items.length > HOME_ROW_ITEMS };
}

export function buildHomeModel(sources: HomeSources, now: number): HomeModel {
  const withNow = (item: HomeChannel): HomeChannelItem => ({ ...item, now: sources.nowPlaying(item.channel) });
  const channelRail = (items: HomeChannel[]) => {
    const row = rail(items);
    return { items: row.items.map(withNow), more: row.more };
  };
  const reminders = sources.reminders(now);
  const xtream = sources.hasXtream();
  const catalog = xtream ? sources.catalog() : null;
  return {
    resume: rail(xtream ? sources.resume() : []),
    watchlist: rail(xtream ? sources.watchlist() : []),
    recent: channelRail(sources.recent()),
    favorites: channelRail(sources.favorites()),
    topRated: rail(catalog ? catalog.topRated : []),
    recentlyAdded: rail(catalog ? catalog.recentlyAdded : []),
    reminders: rail(reminders),
  };
}

// The n highest-valued items in one pass, highest first; ties keep catalog
// order. Sorting a whole catalog would stall a TV.
export function topBy<T>(items: readonly T[], value: (item: T) => number | null, n: number): T[] {
  const best: Array<{ item: T; value: number }> = [];
  for (const item of items) {
    const v = value(item);
    if (v === null || (best.length === n && v <= best[n - 1].value)) continue;
    let i = best.length;
    while (i > 0 && best[i - 1].value < v) i--;
    best.splice(i, 0, { item, value: v });
    if (best.length > n) best.pop();
  }
  return best.map(entry => entry.item);
}

function positive(raw: string | number | undefined): number | null {
  const value = typeof raw === 'string' ? (raw.trim() ? Number(raw) : NaN) : raw ?? NaN;
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function pickHomeCatalog(movies: readonly VodItem[], series: readonly SeriesItem[]): HomeCatalog {
  const titles: HomeTitle[] = [
    ...movies.map(item => ({ kind: 'vod' as const, item })),
    ...series.map(item => ({ kind: 'series' as const, item })),
  ];
  return {
    topRated: topBy(movies, item => positive(item.rating), CATALOG_PICKS),
    recentlyAdded: topBy(titles, title => positive(title.item.addedAt), CATALOG_PICKS),
  };
}

// A Watchlist entry as the catalog item its detail page opens.
export function watchlistTitle(entry: WatchlistEntry): HomeTitle {
  const { accountId, itemId, name, poster, rating, categoryId } = entry;
  return entry.kind === 'vod'
    ? { kind: 'vod', item: {
      accountId, streamId: itemId, name, poster, rating, categoryId,
      containerExtension: entry.containerExtension ?? 'mp4',
    } }
    : { kind: 'series', item: { accountId, seriesId: itemId, name, poster, rating, categoryId } };
}

function titleConcealed(title: HomeTitle): boolean {
  return title.kind === 'vod' ? isVodConcealed(title.item) : isSeriesConcealed(title.item);
}

function titleId(title: HomeTitle): string {
  return title.kind === 'vod' ? title.item.streamId : title.item.seriesId;
}

function visible(channel: Channel): boolean {
  return !ParentalControlService.isConcealed(liveParentalRequest(channel));
}

function resolve(key: string): HomeChannel | null {
  const resolved = key ? PlaylistService.resolveChannelKey(key) : null;
  return resolved && visible(resolved.channel) ? resolved : null;
}

export function liveHomeSources(
  activeAccount: () => PlaylistEntry | null,
  playingIndex: () => number,
): HomeSources {
  const activeAccountId = () => activeAccount()?.id ?? null;
  // Picked once per account and kept for an hour, so Home doesn't re-pick
  // (and flicker) every time a catalog list is written or refreshed.
  const picks = new Map<string, { catalog: HomeCatalog; pickedAt: number }>();
  let loading: string | null = null;
  return {
    recent: () => StorageService.getRecentlyWatchedLive()
      .map(entry => resolve(entry.channelKey))
      .filter((item): item is HomeChannel => item !== null),
    favorites: () => StorageService.getFavorites()
      .map(resolve)
      .filter((item): item is HomeChannel => item !== null),
    nowPlaying: (channel) => {
      const epgId = EpgService.findChannelId(channel);
      return epgId ? EpgService.getNowPlaying(epgId) : null;
    },
    resume: () => {
      const id = activeAccountId();
      return id ? latestPerSeries(StorageService.getResumeList(id)
        .filter(entry => !isResumeConcealed(entry))) : [];
    },
    watchlist: () => {
      const id = activeAccountId();
      if (!id) return [];
      return [...StorageService.getWatchlist(id, 'vod'), ...StorageService.getWatchlist(id, 'series')]
        .filter(entry => !isWatchlistConcealed(entry))
        .sort((a, b) => b.addedAt - a.addedAt);
    },
    catalog: () => {
      const id = activeAccountId();
      const cached = id ? picks.get(id) : undefined;
      if (!cached) return null;
      return {
        topRated: cached.catalog.topRated.filter(item => !isVodConcealed(item)),
        recentlyAdded: cached.catalog.recentlyAdded.filter(title => !titleConcealed(title)),
      };
    },
    loadCatalog: (onReady) => {
      const account = activeAccount();
      if (!account || account.id === loading) return;
      const id = account.id;
      const cached = picks.get(id);
      if (cached && Date.now() - cached.pickedAt < CONFIG.XTREAM.HOME_PICKS_TTL_MS) return;
      loading = id;
      Promise.all([loadAllVodStreams(account), loadAllSeries(account)])
        .then(([movies, series]) => {
          picks.set(id, { catalog: pickHomeCatalog(movies, series), pickedAt: Date.now() });
          if (activeAccountId() === id) onReady();
        })
        // The catalog loader logs its own failures; the rows keep their last picks.
        .catch(() => undefined)
        .then(() => { if (loading === id) loading = null; });
    },
    reminders: (now) => ReminderService.listManageable(now),
    hasXtream: () => activeAccountId() !== null,
    playingIndex,
    remove: (item) => {
      if (item.row === 'recent') {
        StorageService.removeRecentlyWatchedLive(channelKey(item.channel));
      } else if (item.row === 'watchlist') {
        StorageService.removeWatchlist(item.entry.accountId, item.entry.kind, item.entry.itemId);
      } else {
        // A series leaves as a whole, as in the Series section.
        const series = resumeSeriesId(item.entry);
        if (series) StorageService.clearSeriesResume(item.entry.accountId, series);
        else StorageService.clearResume(item.entry.accountId, item.entry.kind, item.entry.itemId);
      }
    },
  };
}

interface HomeViewOptions {
  sources: HomeSources;
  onRevealTabBar: (dir: 'up' | 'left') => void;
  onBack: () => void;
  onPlayChannel: (channelIndex: number) => void;
  onOpenGuide: (channelIndex: number) => void;
  onOpenResume: (entry: ResumeEntry) => void;
  onOpenTitle: (title: HomeTitle) => void;
  onSeeAll: (row: HomeRow, model: HomeModel) => void;
}

/**
 * The landing section: rows for Continue watching, recently watched
 * channels, the Watchlist, favorite channels, top rated and
 * recently added titles, and upcoming reminders. Each row borrows its
 * section's tile, so it looks and focuses the same as there. Channel, program,
 * and title text is untrusted, so it renders only through `html`.
 */
export class HomeView {
  readonly focusScope: FocusScope;
  private nav: SpatialNav;
  private model: HomeModel | null = null;
  private readonly removeTip = new RemoveTip('tip.home.remove');
  // A Magic Remote hold on a tile: its timer, then the click its release
  // fires, which must not also open the tile.
  private pointerHold: ReturnType<typeof setTimeout> | null = null;
  private swallowClick = false;

  constructor(private container: HTMLElement, private options: HomeViewOptions) {
    this.focusScope = Focus.register({
      id: 'view.home',
      root: container,
      leaveFor: { up: 'tabbar', left: 'tabbar' },
      defaultKey: () => {
        const el = this.nav.focused;
        return el && this.container.contains(el) ? el.dataset.key ?? null : null;
      },
    });
    // Home scrolls itself, so a focused tile and its whole row stay on screen.
    this.nav = new SpatialNav(container, undefined, {
      scope: this.focusScope,
      follow: false,
      onRequest: (el, via) => { if (el && via === 'key') this.reveal(el); },
    });
    // The pointer moves focus where it rests; only keys scroll Home.
    this.container.addEventListener('nav:hover', (event: Event) => {
      const el = event.target as HTMLElement;
      if (el.hasAttribute('data-focusable') && this.container.contains(el)) this.nav.focus(el, 'pointer');
    });
    this.container.addEventListener('nav:unhover', (event: Event) => {
      if (event.target === this.nav.focused) this.focusScope.conceal();
    });
    this.container.setAttribute('data-self-activate', '');
    this.container.addEventListener('click', (event: MouseEvent) => {
      if (this.swallowClick) {
        this.swallowClick = false;
        return;
      }
      const control = (event.target as HTMLElement).closest<HTMLElement>('[data-focusable]');
      if (!control) return;
      this.nav.focus(control, 'pointer');
      this.activate(control);
    });
    this.container.addEventListener('mousedown', (event: MouseEvent) => {
      const control = (event.target as HTMLElement).closest<HTMLElement>('[data-long-press]');
      this.cancelPointerHold();
      this.swallowClick = false;
      if (!control) return;
      this.pointerHold = setTimeout(() => {
        this.pointerHold = null;
        this.swallowClick = true;
        this.nav.focus(control, 'pointer');
        this.promptRemove(control);
      }, CONFIG.NAVIGATION.LONG_PRESS_MS);
    });
    this.container.addEventListener('mouseup', () => this.cancelPointerHold());
    // Now-playing titles move with the clock.
    onClockTick(() => this.refresh());
  }

  private get shown(): boolean {
    return !this.container.classList.contains('hidden') && this.model !== null;
  }

  // Entering Home lands on the last-focused item, or the first one.
  open(): void {
    const key = this.nav.focused?.dataset.key ?? null;
    this.render();
    this.refocus(key);
    this.options.sources.loadCatalog(() => this.refresh());
  }

  resumeFocus(): void {
    this.refocus(this.nav.focused?.dataset.key ?? null);
  }

  // Data under Home changed (guide loaded, catalog, clock).
  refresh(): void {
    if (!this.shown) return;
    const focused = this.nav.focused;
    this.render();
    if (focused && !focused.isConnected) this.focusFirst();
  }

  handleAction(action: Action): void {
    const focused = this.nav.focused;
    if (action === 'back') {
      this.options.onBack();
    } else if (action === 'select' && focused) {
      this.activate(focused);
    } else if (action === 'long_select' && focused) {
      this.promptRemove(focused);
    } else if (action === 'right' && focused && this.atRowEdge(focused, 'end')) {
      // Right at a row's end stays put rather than jumping to another row.
    } else if (action === 'left' && focused && this.atRowEdge(focused, 'start')) {
      // Left at a row's start opens the side menu, never another row.
      this.options.onRevealTabBar('left');
      this.rewind('left');
    } else if (action === 'up' || action === 'down' || action === 'left' || action === 'right') {
      if (!this.nav.move(action) && (action === 'up' || action === 'left')) {
        this.options.onRevealTabBar(action);
        this.rewind(action);
      }
    }
  }

  // Leaving for the tab bar rewinds only the way it left: Up scrolls Home
  // back to its top, Left scrolls every row back to its first tile. Focus
  // stays on the tile it left from.
  private rewind(dir: 'up' | 'left'): void {
    if (dir === 'up') {
      const view = this.container.querySelector<HTMLElement>('.home-view');
      if (view) view.scrollTop = 0;
      return;
    }
    const tracks = this.container.querySelectorAll<HTMLElement>('.home-rail-track');
    for (let i = 0; i < tracks.length; i++) tracks[i].scrollLeft = 0;
    this.nav.forgetLastFocused();
  }

  private atRowEdge(el: HTMLElement, edge: 'start' | 'end'): boolean {
    const row = el.closest('.home-rail-track');
    if (!row) return false;
    const items = row.querySelectorAll('[data-focusable]');
    return items[edge === 'start' ? 0 : items.length - 1] === el;
  }

  private render(): void {
    const now = Date.now();
    const model = buildHomeModel(this.options.sources, now);
    this.model = model;
    morph(this.container, html`
      <div class="home-view">
        ${this.posterRail('resume', t('catalog.continueWatching'), model.resume,
          entry => this.resumeTile(entry))}
        ${this.channelRail('recent', t('channel.recentlyWatched'), model.recent)}
        ${this.posterRail('watchlist', t('common.watchlist'), model.watchlist,
          entry => this.titleTile(watchlistTitle(entry), 'watchlist'))}
        ${this.channelRail('favorites', t('channel.favorites'), model.favorites)}
        ${this.posterRail('top', t('home.topRatedMovies'), model.topRated,
          item => this.titleTile({ kind: 'vod', item }, 'top'))}
        ${this.posterRail('new', t('home.recentlyAdded'), model.recentlyAdded,
          title => this.titleTile(title, 'new'))}
        ${this.section('reminders', t('reminderManager.title'), model.reminders.items.length
          ? html`${model.reminders.items.map(reminder => this.reminderTile(reminder, now))}${
            model.reminders.more ? this.channelSeeAll('reminders') : ''}`
          : null)}
      </div>
    `);
  }

  private section(row: HomeRow, title: string, tiles: Safe | null): Safe | '' {
    if (!tiles) return '';
    return html`
      <section class="home-row home-rail" data-home-row="${row}">
        <h2 class="catalog-rail-title">${title}</h2>
        <div class="home-rail-track" data-nav-container data-nav-enter="last-focused">${tiles}</div>
      </section>
    `;
  }

  private channelRail(row: HomeRow, title: string, rail: HomeRail<HomeChannelItem>): Safe | '' {
    if (!rail.items.length) return '';
    return this.section(row, title, html`${rail.items.map(item => this.channelTile(item, row))}${
      rail.more ? this.channelSeeAll(row) : ''}`);
  }

  private posterRail<T>(row: HomeRow, title: string, rail: HomeRail<T>, tile: (item: T) => Safe): Safe | '' {
    if (!rail.items.length) return '';
    return this.section(row, title, html`${rail.items.map(tile)}${rail.more ? this.posterSeeAll(row) : ''}`);
  }

  // The shared channel card, as in Live and Search.
  private channelTile(item: HomeChannelItem, row: HomeRow): Safe {
    const { channel, channelIndex, now: program } = item;
    return channelCard({
      key: `${row}:${channelKey(channel)}`,
      channel,
      subtitle: program?.title,
      favorite: row !== 'favorites' && StorageService.getFavorites().includes(channelKey(channel)),
      playing: channelIndex === this.options.sources.playingIndex(),
      attrs: html`data-home-action="watch" data-channel-index="${channelIndex}" ${
        raw(row === 'recent' ? 'data-long-press' : '')}`,
    });
  }

  // A reminder is a channel card for its channel, titled by the program.
  private reminderTile(reminder: Reminder, now: number): Safe {
    const start = new Date(reminder.startMs);
    const day = formatDayLabel(start);
    const today = formatDayLabel(new Date(now)).date === day.date;
    const resolved = PlaylistService.resolveChannelKey(reminder.channelKey);
    const when = today ? formatTime(start) : `${day.weekday} ${formatTime(start)}`;
    return channelCard({
      key: `reminders:${reminder.channelKey}:${String(reminder.startMs)}`,
      channel: resolved ? resolved.channel : null,
      title: reminder.title,
      subtitle: `${when} · ${reminder.channelName}`,
      status: html`<span class="home-reminder-icon">${raw(bellIcon(true))}</span>`,
      attrs: html`data-home-action="guide" data-channel-index="${resolved ? resolved.channelIndex : -1}"`,
    });
  }

  private channelSeeAll(row: HomeRow): Safe {
    return channelSeeAllCard(`${row}:all`, html`data-home-see-all="${row}"`);
  }

  // The shared poster card, as in Movies, Series, and Search.
  private resumeTile(entry: ResumeEntry): Safe {
    return posterCard({
      key: `resume:${entry.kind}:${entry.itemId}`,
      name: entry.name,
      poster: entry.poster,
      art: entry.kind === 'vod' ? 'movie' : 'series',
      lock: resumeLockBadge(entry),
      progress: entry,
      attrs: html`data-resume-kind="${entry.kind}" data-resume-id="${entry.itemId}" data-long-press`,
    });
  }

  private titleTile(title: HomeTitle, row: HomeRow): Safe {
    const id = titleId(title);
    return posterCard({
      key: `${row}:${title.kind}:${id}`,
      name: title.item.name,
      poster: title.item.poster,
      art: title.kind === 'vod' ? 'movie' : 'series',
      lock: title.kind === 'vod' ? vodLockBadge(title.item) : seriesLockBadge(title.item),
      attrs: html`data-title-kind="${title.kind}" data-title-id="${id}" ${
        raw(row === 'watchlist' ? 'data-long-press' : '')}`,
    });
  }

  private posterSeeAll(row: HomeRow): Safe {
    return posterSeeAllCard({ key: `${row}:all`, attrs: html`data-home-see-all="${row}"` });
  }

  // Bring the focused tile's whole row into view vertically, and the tile
  // itself inside its track's padding, so neither it nor its focus growth
  // ever sits off screen.
  private reveal(el: HTMLElement): void {
    const view = this.container.querySelector<HTMLElement>('.home-view');
    const row = el.closest<HTMLElement>('[data-home-row]');
    if (view && row) {
      // Clear of the search strip the view scrolls under, where it does.
      const top = row.offsetTop - REVEAL_MARGIN_Y - scrollInsetTop(view);
      const bottom = row.offsetTop + row.offsetHeight + REVEAL_MARGIN_Y;
      if (!row.previousElementSibling || top < view.scrollTop) {
        view.scrollTop = row.previousElementSibling ? Math.max(0, top) : 0;
      } else if (bottom > view.scrollTop + view.clientHeight) {
        view.scrollTop = Math.min(top, bottom - view.clientHeight);
      }
    }
    const track = el.closest<HTMLElement>('.home-rail-track');
    if (track) {
      // Screen-relative, so it holds in either reading direction: scrollLeft
      // moves content the same physical way in every engine.
      const box = el.getBoundingClientRect();
      const portLeft = track.getBoundingClientRect().left + track.clientLeft;
      const left = box.left - REVEAL_MARGIN_X - portLeft;
      const right = box.right + REVEAL_MARGIN_X - portLeft;
      if (left < 0) track.scrollLeft += left;
      else if (right > track.clientWidth) track.scrollLeft += right - track.clientWidth;
    }
  }

  private activate(control: HTMLElement): void {
    const seeAll = control.dataset.homeSeeAll as HomeRow | undefined;
    if (seeAll && this.model) {
      this.options.onSeeAll(seeAll, this.model);
      return;
    }
    const index = Number(control.dataset.channelIndex);
    if (control.dataset.homeAction === 'watch' && index >= 0) {
      this.options.onPlayChannel(index);
      return;
    }
    if (control.dataset.homeAction === 'guide') {
      this.options.onOpenGuide(index);
      return;
    }
    const id = control.dataset.titleId;
    if (id && this.model) {
      const kind = control.dataset.titleKind;
      const title = [
        ...this.model.watchlist.items.map(watchlistTitle),
        ...this.model.recentlyAdded.items,
        ...this.model.topRated.items.map(item => ({ kind: 'vod' as const, item })),
      ].find(entry => entry.kind === kind && titleId(entry) === id);
      if (title) this.options.onOpenTitle(title);
      return;
    }
    const resumeId = control.dataset.resumeId;
    const entry = resumeId
      ? this.model?.resume.items.find(e => e.itemId === resumeId && e.kind === control.dataset.resumeKind)
      : null;
    if (entry) this.options.onOpenResume(entry);
  }

  private cancelPointerHold(): void {
    if (this.pointerHold) clearTimeout(this.pointerHold);
    this.pointerHold = null;
  }

  private removal(control: HTMLElement): { item: HomeRemoval; name: string } | null {
    const model = this.model;
    const row = control.closest<HTMLElement>('[data-home-row]')?.dataset.homeRow;
    if (!model || !control.hasAttribute('data-long-press')) return null;
    if (row === 'recent') {
      const index = Number(control.dataset.channelIndex);
      const found = model.recent.items.find(item => item.channelIndex === index);
      return found ? { item: { row, channel: found.channel }, name: found.channel.name } : null;
    }
    if (row === 'watchlist') {
      const kind = control.dataset.titleKind;
      const entry = model.watchlist.items.find(e => e.kind === kind && e.itemId === control.dataset.titleId);
      return entry ? { item: { row, entry }, name: entry.name } : null;
    }
    if (row === 'resume') {
      const entry = model.resume.items.find(e =>
        e.kind === control.dataset.resumeKind && e.itemId === control.dataset.resumeId);
      return entry ? { item: { row, entry }, name: entry.name } : null;
    }
    return null;
  }

  // Holding OK on a Continue watching, Recently watched, or Watchlist tile
  // shows a tooltip that takes it off that list.
  private promptRemove(control: HTMLElement): void {
    const found = this.removal(control);
    if (!found) return;
    const { item } = found;
    const labels = REMOVE_LABELS[item.row];
    this.removeTip.show({
      anchor: control,
      label: t(labels.action),
      onRemove: () => {
        // Focus lands on the tile beside it, or on the next row when the
        // row empties and goes.
        const next = this.neighborKey(control);
        this.options.sources.remove(item);
        showToast(t(labels.done));
        this.render();
        this.refocus(next);
      },
      onClose: () => this.refocus(control.dataset.key ?? null),
    });
  }

  private neighborKey(control: HTMLElement): string | null {
    const track = control.closest('.home-rail-track');
    const tiles = track ? Array.from(track.querySelectorAll<HTMLElement>('[data-long-press]')) : [];
    const at = tiles.indexOf(control);
    const beside = tiles[at + 1] ?? tiles[at - 1];
    if (beside) return beside.dataset.key ?? null;
    const row = control.closest('[data-home-row]');
    const nextRow = row?.nextElementSibling ?? row?.previousElementSibling;
    return nextRow?.querySelector<HTMLElement>('[data-focusable]')?.dataset.key ?? null;
  }

  private refocus(key: string | null): void {
    const el = key ? this.container.querySelector<HTMLElement>(`[data-key="${key}"]`) : null;
    if (el) this.nav.focus(el);
    else this.focusFirst();
  }

  private focusFirst(): void {
    this.nav.focus(this.container.querySelector<HTMLElement>('[data-focusable]'));
  }
}
