import type {
  Action, Channel, PlaylistEntry, Programme, Reminder, ResumeEntry, SeriesItem, VodItem, WatchlistEntry,
} from '../types';
import { SpatialNav } from '../navigation/spatial-nav';
import { Focus, type FocusScope } from '../navigation/focus-scope';
import { html, raw, type Safe } from '../utils/dom';
import { morph } from '../utils/morph';
import { onClockTick } from '../utils/clock';
import { formatDayLabel, formatTime } from '../utils/time';
import { channelKey } from '../utils/channel';
import { latestPerSeries } from '../utils/vod-progress';
import { t, type TextMessageKey } from '../i18n';
import { EpgService } from '../services/epg-service';
import { PlaylistService } from '../services/playlist-service';
import { ReminderService } from '../services/reminder-service';
import { StorageService } from '../services/storage-service';
import {
  loadAllSeries, loadAllVodStreams, onCatalogListRefreshed, onCatalogListWritten,
} from '../services/xtream-catalog';
import {
  isResumeConcealed,
  isSeriesConcealed,
  isWatchlistConcealed,
  isVodConcealed,
  liveParentalRequest,
  ParentalControlService,
} from '../services/parental-control';
import { channelLockBadge } from './parental-badge';
import {
  bellIcon, favoriteIcon, RECORD_ICON, SEARCH_ICON, SEE_ALL_ICON, SETTINGS_ICON,
  TAB_GUIDE_ICON, TAB_LIVE_ICON, TAB_MOVIES_ICON, TAB_SERIES_ICON,
} from './icons';

export type HomeShortcut =
  | 'live' | 'epg' | 'movies' | 'series' | 'recordings' | 'reminders' | 'search' | 'settings';

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
  hasRecordings(): boolean;
  channelCount(): number;
}

export interface HomeShortcutTile {
  id: HomeShortcut;
  count: number | null;
}

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
  shortcuts: HomeShortcutTile[];
  favorites: HomeRail<HomeChannelItem>;
  topRated: HomeRail<VodItem>;
  recentlyAdded: HomeRail<HomeTitle>;
  reminders: HomeRail<Reminder>;
}

const SHORTCUT_LABELS: Record<HomeShortcut, TextMessageKey> = {
  live: 'nav.live',
  epg: 'nav.epg',
  movies: 'nav.movies',
  series: 'nav.series',
  recordings: 'nav.recordings',
  reminders: 'reminderManager.title',
  search: 'nav.search',
  settings: 'nav.settings',
};

const SHORTCUT_ICONS: Record<HomeShortcut, string> = {
  live: TAB_LIVE_ICON,
  epg: TAB_GUIDE_ICON,
  movies: TAB_MOVIES_ICON,
  series: TAB_SERIES_ICON,
  recordings: RECORD_ICON,
  reminders: bellIcon(false),
  search: SEARCH_ICON,
  settings: SETTINGS_ICON,
};

// Each row shows this many, then See all opens the full list.
export const HOME_ROW_ITEMS = 10;
// Extra catalog picks leave room for titles parental controls hide, and still
// tell whether there are more than a row shows.
const CATALOG_PICKS = HOME_ROW_ITEMS * 3;

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
  const recordings = sources.hasRecordings();
  const shortcuts: HomeShortcutTile[] = [
    { id: 'live', count: sources.channelCount() },
    { id: 'epg', count: null },
    ...(xtream ? [{ id: 'movies' as const, count: null }, { id: 'series' as const, count: null }] : []),
    ...(recordings ? [{ id: 'recordings' as const, count: null }] : []),
    { id: 'reminders', count: reminders.length },
    { id: 'search', count: null },
    { id: 'settings', count: null },
  ];
  const catalog = xtream ? sources.catalog() : null;
  return {
    resume: rail(xtream ? sources.resume() : []),
    watchlist: rail(xtream ? sources.watchlist() : []),
    recent: channelRail(sources.recent()),
    shortcuts,
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
  hasRecordings: () => boolean,
): HomeSources {
  const activeAccountId = () => activeAccount()?.id ?? null;
  let catalog: HomeCatalog | null = null;
  let catalogAccount: string | null = null;
  let loading: string | null = null;
  const invalidate = (key: string) => {
    if (catalogAccount && key.startsWith(`${catalogAccount}|`)) catalogAccount = null;
  };
  onCatalogListRefreshed(invalidate);
  onCatalogListWritten(invalidate);
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
      if (!catalog || catalogAccount !== activeAccountId()) return null;
      return {
        topRated: catalog.topRated.filter(item => !isVodConcealed(item)),
        recentlyAdded: catalog.recentlyAdded.filter(title => !titleConcealed(title)),
      };
    },
    loadCatalog: (onReady) => {
      const account = activeAccount();
      if (!account || account.id === catalogAccount || account.id === loading) return;
      const id = account.id;
      loading = id;
      Promise.all([loadAllVodStreams(account), loadAllSeries(account)])
        .then(([movies, series]) => {
          if (activeAccountId() !== id) return;
          catalog = pickHomeCatalog(movies, series);
          catalogAccount = id;
          onReady();
        })
        // The catalog loader logs its own failures; the rows just stay hidden.
        .catch(() => undefined)
        .then(() => { if (loading === id) loading = null; });
    },
    reminders: (now) => ReminderService.listManageable(now),
    hasXtream: () => activeAccountId() !== null,
    hasRecordings,
    channelCount: () => PlaylistService.channels.length,
  };
}

interface HomeViewOptions {
  sources: HomeSources;
  onRevealTabBar: () => void;
  onBack: () => void;
  onShortcut: (id: HomeShortcut) => void;
  onPlayChannel: (channelIndex: number) => void;
  onOpenGuide: (channelIndex: number) => void;
  onOpenResume: (entry: ResumeEntry) => void;
  onOpenTitle: (title: HomeTitle) => void;
  onSeeAll: (row: HomeRow, model: HomeModel) => void;
}

/**
 * The landing section: rows for Continue watching, the Watchlist, recently
 * watched channels, one-press shortcuts to every section, favorite channels, top rated and
 * recently added titles, and upcoming reminders. Each row borrows its
 * section's tile, so it looks and focuses the same as there. Channel, program,
 * and title text is untrusted, so it renders only through `html`.
 */
export class HomeView {
  readonly focusScope: FocusScope;
  private nav: SpatialNav;
  private model: HomeModel | null = null;

  constructor(private container: HTMLElement, private options: HomeViewOptions) {
    this.focusScope = Focus.register({
      id: 'view.home',
      root: container,
      leaveFor: { up: 'tabbar' },
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
    this.container.setAttribute('data-self-activate', '');
    this.container.addEventListener('click', (event: MouseEvent) => {
      const control = (event.target as HTMLElement).closest<HTMLElement>('[data-focusable]');
      if (!control) return;
      this.nav.focus(control, 'pointer');
      this.activate(control);
    });
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
    } else if (action === 'up' || action === 'down' || action === 'left' || action === 'right') {
      if (!this.nav.move(action) && action === 'up') this.options.onRevealTabBar();
    }
  }

  private render(): void {
    const now = Date.now();
    const model = buildHomeModel(this.options.sources, now);
    this.model = model;
    morph(this.container, html`
      <div class="home-view">
        ${this.posterRail('resume', t('catalog.continueWatching'), model.resume,
          entry => this.resumeTile(entry))}
        ${this.posterRail('watchlist', t('common.watchlist'), model.watchlist,
          entry => this.titleTile(watchlistTitle(entry), 'watchlist'))}
        ${this.channelRail('recent', t('channel.recentlyWatched'), model.recent)}
        <section class="home-row" data-home-row="shortcuts">
          <div class="home-shortcuts" data-nav-container data-nav-enter="last-focused">
            ${model.shortcuts.map(tile => this.shortcut(tile))}
          </div>
        </section>
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

  private shortcut(tile: HomeShortcutTile): Safe {
    return html`
      <button class="home-shortcut" type="button" data-focusable
              data-key="sc:${tile.id}" data-home-shortcut="${tile.id}">
        <span class="home-shortcut-icon">${raw(SHORTCUT_ICONS[tile.id])}</span>
        <span class="home-shortcut-label">${t(SHORTCUT_LABELS[tile.id])}</span>
        ${tile.count ? html`<span class="home-shortcut-count">${String(tile.count)}</span>` : ''}
      </button>
    `;
  }

  // The Live grid's own tile, so a channel looks and focuses the same here.
  private channelTile(item: HomeChannelItem, row: HomeRow): Safe {
    const { channel, channelIndex, now: program } = item;
    const favorite = row !== 'favorites' && StorageService.getFavorites().includes(channelKey(channel));
    return html`
      <div class="channel-item channel-tile" data-focusable
           data-key="${row}:${channelKey(channel)}" data-home-action="watch" data-channel-index="${channelIndex}">
        <div class="channel-tile-art">
          <div class="channel-logo-wrap">${this.logo(channel)}</div>
          <div class="channel-number">${channelIndex + 1}</div>
        </div>
        <div class="channel-info">
          <div class="channel-name">${raw(channelLockBadge(channel))}${
            favorite ? raw(favoriteIcon(true)) : ''}${channel.name}</div>
          ${program ? html`<div class="channel-now">${program.title}</div>` : ''}
        </div>
      </div>
    `;
  }

  // A reminder is a Live tile for its channel, titled by the program.
  private reminderTile(reminder: Reminder, now: number): Safe {
    const start = new Date(reminder.startMs);
    const day = formatDayLabel(start);
    const today = formatDayLabel(new Date(now)).date === day.date;
    const resolved = PlaylistService.resolveChannelKey(reminder.channelKey);
    const when = today ? formatTime(start) : `${day.weekday} ${formatTime(start)}`;
    return html`
      <div class="channel-item channel-tile" data-focusable
           data-key="reminders:${reminder.channelKey}:${String(reminder.startMs)}"
           data-home-action="guide" data-channel-index="${resolved ? resolved.channelIndex : -1}">
        <div class="channel-tile-art">
          <div class="channel-logo-wrap">${resolved
            ? this.logo(resolved.channel)
            : html`<span class="channel-logo-placeholder">${reminder.channelName.charAt(0)}</span>`}</div>
          <div class="channel-tile-status"><span class="home-reminder-icon">${raw(bellIcon(true))}</span></div>
        </div>
        <div class="channel-info">
          <div class="channel-name">${reminder.title}</div>
          <div class="channel-now">${when} · ${reminder.channelName}</div>
        </div>
      </div>
    `;
  }

  private channelSeeAll(row: HomeRow): Safe {
    return html`
      <div class="channel-item channel-tile home-see-all" data-focusable
           data-key="${row}:all" data-home-see-all="${row}">
        <div class="channel-tile-art">${raw(SEE_ALL_ICON)}</div>
        <div class="channel-info"><div class="channel-name">${t('catalog.seeAll')}</div></div>
      </div>
    `;
  }

  // The Movies section's own poster tile.
  private resumeTile(entry: ResumeEntry): Safe {
    const percent = entry.duration > 0
      ? Math.max(2, Math.min(100, Math.round(entry.position / entry.duration * 100))) : 0;
    return html`
      <div class="catalog-tile" data-focusable data-key="resume:${entry.kind}:${entry.itemId}"
           data-resume-kind="${entry.kind}" data-resume-id="${entry.itemId}">
        <div class="catalog-poster-wrap">
          ${this.poster(entry.name, entry.poster)}
          ${percent ? html`<div class="catalog-progress"><div class="catalog-progress-fill" style="width:${percent}%"></div></div>` : ''}
        </div>
        <div class="catalog-tile-name">${entry.name}</div>
      </div>
    `;
  }

  private titleTile(title: HomeTitle, row: HomeRow): Safe {
    const id = titleId(title);
    const { name, poster } = title.item;
    return html`
      <div class="catalog-tile" data-focusable data-key="${row}:${title.kind}:${id}"
           data-title-kind="${title.kind}" data-title-id="${id}">
        <div class="catalog-poster-wrap">${this.poster(name, poster)}</div>
        <div class="catalog-tile-name">${name}</div>
      </div>
    `;
  }

  // The Movies section's See all tile.
  private posterSeeAll(row: HomeRow): Safe {
    return html`
      <div class="catalog-tile catalog-see-all" data-focusable data-key="${row}:all" data-home-see-all="${row}">
        <div class="catalog-poster-wrap catalog-see-all-card">
          ${raw(SEE_ALL_ICON)}
          <div class="catalog-see-all-label">${t('catalog.seeAll')}</div>
        </div>
      </div>
    `;
  }

  private poster(name: string, poster: string): Safe {
    return poster
      ? html`<img class="catalog-poster" src="${poster}" alt="" loading="lazy" decoding="async" onerror="this.style.display='none'">`
      : html`<div class="catalog-poster catalog-poster-empty">${name.charAt(0)}</div>`;
  }

  private logo(channel: Channel): Safe {
    return channel.logo
      ? html`<img class="channel-logo" src="${channel.logo}" alt="" loading="lazy" onerror="this.style.display='none'">`
      : html`<span class="channel-logo-placeholder">${channel.name.charAt(0)}</span>`;
  }

  // Bring the focused tile's whole row into view vertically, and the tile
  // itself inside its track's padding, so neither it nor its focus growth
  // ever sits off screen.
  private reveal(el: HTMLElement): void {
    const view = this.container.querySelector<HTMLElement>('.home-view');
    const row = el.closest<HTMLElement>('[data-home-row]');
    if (view && row) {
      const top = row.offsetTop - REVEAL_MARGIN_Y;
      const bottom = row.offsetTop + row.offsetHeight + REVEAL_MARGIN_Y;
      if (!row.previousElementSibling || top < view.scrollTop) {
        view.scrollTop = row.previousElementSibling ? Math.max(0, top) : 0;
      } else if (bottom > view.scrollTop + view.clientHeight) {
        view.scrollTop = Math.min(top, bottom - view.clientHeight);
      }
    }
    const track = el.closest<HTMLElement>('.home-rail-track');
    if (track) {
      const left = el.offsetLeft - REVEAL_MARGIN_X;
      const right = el.offsetLeft + el.offsetWidth + REVEAL_MARGIN_X;
      if (left < track.scrollLeft) track.scrollLeft = Math.max(0, left);
      else if (right > track.scrollLeft + track.clientWidth) track.scrollLeft = right - track.clientWidth;
    }
  }

  private activate(control: HTMLElement): void {
    const shortcut = control.dataset.homeShortcut as HomeShortcut | undefined;
    if (shortcut) {
      this.options.onShortcut(shortcut);
      return;
    }
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

  private refocus(key: string | null): void {
    const el = key ? this.container.querySelector<HTMLElement>(`[data-key="${key}"]`) : null;
    if (el) this.nav.focus(el);
    else this.focusFirst();
  }

  private focusFirst(): void {
    this.nav.focus(this.container.querySelector<HTMLElement>('[data-focusable]'));
  }
}
