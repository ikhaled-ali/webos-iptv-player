import { CONFIG } from '../config';
import type { Action, PlaylistEntry, SeriesCategory, SeriesItem, SeriesInfo, Episode, ResumeEntry, ResumeKind, VodQueueItem, WatchlistEntry, VodDetails } from '../types';
import { html, raw, Safe, visibleHeight } from '../utils/dom';
import { morph } from '../utils/morph';
import { StorageService } from '../services/storage-service';
import { loadSeriesCategories, loadSeries, loadSeriesInfo } from '../services/xtream-catalog';
import { xtreamEpisodeUrl, type XtreamCredentials } from '../utils/xtream-url';
import { CatalogView, type CatalogHandlers, type CollectionKind, type CollectionEntry } from './catalog-view';
import { PLAY_ICON, watchlistIcon } from './icons';
import { showToast } from './toast';
import { t, tp } from '../i18n';
import { VirtualList } from '../utils/virtual-list';

const EPISODE_GAP = 16;
const EPISODE_NO_PLOT_ESTIMATE = 138;
const EPISODE_PLOT_ESTIMATE = 216;
const EPISODE_OVERSCAN = 5;
// The whole detail page scrolls, so the fallback is the page viewport, not the
// space left under the header.
const EPISODE_VIEWPORT_FALLBACK = 984;

// The Series section: browse (Continue rail of resumed episodes + per-category
// rails + an "all categories" drill-in) → per-category poster grid → a detail
// screen with a season selector over an episode list. The browse/grid/nav
// machinery lives in CatalogView.
export class Series extends CatalogView<SeriesCategory, SeriesItem> {
  protected get kicker(): string { return t('common.series'); }
  protected readonly resumeKind: ResumeKind = 'episode';
  protected readonly parentalKind = 'series' as const;
  protected scopeName(): string { return 'series'; }
  protected get emptyMessage(): string { return t('catalog.noSeries'); }
  protected get gridEmptyMessage(): string { return t('catalog.noSeriesCategory'); }
  protected itemCount(count: number): string { return tp('catalog.seriesCount', count); }

  private currentSeries: SeriesItem | null = null;
  private currentInfo: SeriesInfo | null = null;
  private selectedSeason = 0;
  private detailLoading = false;
  private episodeFocusIndex = 0;
  private resumeRequest = 0;
  private episodeSource: Episode[] | null = null;
  private measuredEpisodes = new Set<number>();
  private detailController: AbortController | null = null;
  private readonly episodeVirtualizer = new VirtualList({
    revealMargin: CONFIG.NAVIGATION.REVEAL_MARGIN,
    overscan: EPISODE_OVERSCAN,
    fallbackViewportSize: EPISODE_VIEWPORT_FALLBACK,
  });
  private episodeScrollFrame: number | null = null;
  // A held key's reveal writes the list's offset without a smooth scroll.
  private instantEpisodeScroll = false;

  constructor(container: HTMLElement, handlers: CatalogHandlers) {
    super(container, handlers);
  }

  protected loadCategories(
    account: PlaylistEntry,
    signal: AbortSignal,
  ): Promise<SeriesCategory[]> {
    return loadSeriesCategories(account, signal);
  }
  protected loadItems(
    account: PlaylistEntry,
    categoryId: string,
    signal: AbortSignal,
  ): Promise<SeriesItem[]> {
    return loadSeries(account, categoryId, signal);
  }
  protected itemId(s: SeriesItem): string { return s.seriesId; }
  protected itemName(s: SeriesItem): string { return s.name; }
  protected itemPoster(s: SeriesItem): string { return s.poster; }
  protected itemCategoryId(s: SeriesItem): string { return s.categoryId; }
  protected clearDetail(): void {
    this.detailController?.abort();
    this.detailController = null;
    this.currentSeries = null;
  }
  protected onRequestSessionReset(): void {
    this.detailController?.abort();
    this.detailController = null;
  }

  protected collectionEntries(kind: CollectionKind): CollectionEntry[] {
    if (kind === 'continue') {
      return this.resume.map(entry => ({
        id: entry.itemId, key: `r:${entry.itemId}`,
        tile: managing => this.resumeTile(entry, managing),
      }));
    }
    return this.visibleWatchlist('series').map(entry => {
      const series = this.watchlistEntryToSeries(entry);
      const key = `i:${series.categoryId}:${series.seriesId}`;
      return {
        id: entry.itemId, key,
        tile: managing => this.tile(series, this.removeMark(managing, key), managing),
      };
    });
  }

  protected fallbackItem(seriesId: string): SeriesItem | null {
    const entry = this.visibleWatchlist('series')
      .find((item) => item.itemId === seriesId);
    return entry ? this.watchlistEntryToSeries(entry) : null;
  }

  private watchlistEntryToSeries(entry: WatchlistEntry): SeriesItem {
    return {
      accountId: entry.accountId,
      seriesId: entry.itemId,
      name: entry.name,
      poster: entry.poster,
      rating: entry.rating,
      categoryId: entry.categoryId,
    };
  }

  protected selectExtra(el: HTMLElement): boolean {
    if (el.dataset.action === 'watchlist') { this.toggleWatchlist(); return true; }
    if (el.dataset.resumeEpisode !== undefined) { void this.playResume(el.dataset.resumeEpisode); return true; }
    if (el.dataset.playEpisode !== undefined) { this.playEpisode(el.dataset.playEpisode); return true; }
    if (el.dataset.season !== undefined) { this.selectSeason(Number(el.dataset.season)); return true; }
    if (el.dataset.episodeId !== undefined) { this.playEpisode(el.dataset.episodeId); return true; }
    return false;
  }

  private toggleWatchlist(): void {
    const series = this.currentSeries;
    const account = this.account;
    if (!series || !account) return;
    const result = StorageService.toggleWatchlist({
      accountId: account.id,
      kind: 'series',
      itemId: series.seriesId,
      name: series.name,
      poster: this.currentInfo?.poster || series.poster,
      rating: this.currentInfo?.rating || series.rating,
      categoryId: series.categoryId,
      addedAt: Date.now(),
    });
    showToast(t(result === 'full' ? 'catalog.watchlistFull'
      : result === 'added' ? 'catalog.watchlistAdded' : 'catalog.watchlistRemoved'));
    this.renderDetail();
  }

  protected async openDetail(series: SeriesItem): Promise<void> {
    const account = this.account;
    if (!account || !this.requestSignal) return;
    this.detailController?.abort();
    this.detailController = new AbortController();
    const signal = this.detailController.signal;
    this.currentSeries = series;
    this.enterDetail();
    this.currentInfo = null;
    this.selectedSeason = 0;
    this.episodeFocusIndex = 0;
    this.episodeSource = null;
    this.episodeVirtualizer.setScrollOffset(0);
    this.detailLoading = true;
    this.renderDetail();
    try {
      this.currentInfo = await loadSeriesInfo(account, series.seriesId, signal);
    } catch (err) {
      if (!this.requestFailed('Series detail load', err, signal)) return;
      this.currentInfo = null;
    }
    if (this.mode === 'detail' && this.currentSeries === series) {
      this.detailLoading = false;
      // Open on the season of the episode the main button plays, with that
      // button focused unless the user already moved off the loading screen.
      const target = this.continueTarget();
      this.selectedSeason = (target && this.seasonListing(target.episode.id))
        ?? this.currentInfo?.seasons[0] ?? 0;
      const key = this.focusedKey();
      if (target && (key === null || key === 'watchlist')) this.focusScope.track(null);
      this.renderDetail();
    }
  }

  private selectSeason(season: number): void {
    this.selectedSeason = season;
    this.episodeFocusIndex = 0;
    this.episodeSource = null;
    this.episodeVirtualizer.setScrollOffset(0);
    this.renderDetail();
  }

  // The season group an episode is listed under, which a provider may number
  // differently from the episode's own season field.
  private seasonListing(episodeId: string): number | null {
    const info = this.currentInfo;
    if (!info) return null;
    for (const season of info.seasons) {
      if ((info.episodesBySeason[season] ?? []).some((e) => e.id === episodeId)) return season;
    }
    return null;
  }

  private findEpisode(episodeId: string, info = this.currentInfo): Episode | null {
    if (!info) return null;
    for (const season of info.seasons) {
      const ep = (info.episodesBySeason[season] ?? []).find((e) => e.id === episodeId);
      if (ep) return ep;
    }
    return null;
  }

  private episodeLabel(series: SeriesItem, ep: Episode): string {
    const code = episodeCode(ep);
    return ep.title ? `${series.name} — ${code} — ${ep.title}` : `${series.name} — ${code}`;
  }

  private episodePlayback(series: SeriesItem, ep: Episode, info = this.currentInfo): VodQueueItem {
    const a = this.account!;
    return {
      url: xtreamEpisodeUrl(this.creds(), ep.id, ep.containerExtension || 'mp4'),
      title: this.episodeLabel(series, ep),
      poster: ep.poster || series.poster,
      accountId: a.id,
      itemId: ep.id,
      kind: 'episode',
      categoryId: series.categoryId,
      parentalItemId: series.seriesId,
      subtitles: ep.subtitles,
      searchMeta: { season: ep.season, episode: ep.episode },
      watchlistOwner: { kind: 'series', itemId: series.seriesId },
      details: this.episodeDetails(series, ep, info),
    };
  }

  private episodeDetails(series: SeriesItem, ep: Episode, info: SeriesInfo | null): VodDetails {
    const code = episodeCode(ep);
    return {
      title: ep.title || `${series.name} — ${code}`,
      context: ep.title ? `${series.name} — ${code}` : '',
      plot: ep.plot || info?.plot || '',
      genre: info?.genre ?? '',
      year: info ? (info.releaseDate.match(/\d{4}/) || [''])[0] || (info.year ? String(info.year) : '') : '',
      rating: info?.rating || series.rating,
      durationSecs: ep.durationSecs || (info?.episodeRunTimeMins ?? 0) * 60,
      cast: info?.cast ?? '',
      director: info?.director ?? '',
    };
  }

  private allEpisodes(info = this.currentInfo): Episode[] {
    if (!info) return [];
    return info.seasons.reduce<Episode[]>(
      (all, season) => all.concat(info.episodesBySeason[season] ?? []), []);
  }

  private episodesAfter(episodeId: string, series: SeriesItem, info = this.currentInfo): VodQueueItem[] {
    const episodes = this.allEpisodes(info);
    const index = episodes.findIndex((ep) => ep.id === episodeId);
    return index < 0 ? [] : episodes.slice(index + 1).map((ep) => this.episodePlayback(series, ep, info));
  }

  // The episode the detail's main button plays: the series' latest Continue
  // Watching episode, else the one after the last watched, else the first.
  private continueTarget(): { episode: Episode; resume: ResumeEntry | null } | null {
    const series = this.currentSeries;
    const a = this.account;
    const episodes = this.allEpisodes();
    if (!series || !a || !episodes.length) return null;
    const byId: Record<string, Episode> = {};
    for (const ep of episodes) byId[ep.id] = ep;
    const latest = StorageService.getSeriesResumeList(a.id, series.seriesId)
      .find(entry => !!byId[entry.itemId]);
    if (latest) return { episode: byId[latest.itemId], resume: latest };
    const watched = StorageService.getWatchedEpisodes(a.id, series.seriesId);
    let last = -1;
    episodes.forEach((ep, index) => { if (watched.indexOf(ep.id) >= 0) last = index; });
    return { episode: episodes[last + 1] ?? episodes[0], resume: null };
  }

  private continueButton(): Safe | '' {
    const target = this.continueTarget();
    if (!target) return '';
    const resume = !!target.resume && !target.resume.upNext;
    return html`
      <button class="detail-btn detail-btn-primary" data-focusable data-key="continue"
              data-play-episode="${target.episode.id}">
        <span class="detail-btn-icon">${raw(PLAY_ICON)}</span>
        <span>${t(resume ? 'common.resume' : 'catalog.play')}</span>
        <span class="detail-btn-code">${episodeCode(target.episode)}</span>
      </button>
    `;
  }

  private playEpisode(episodeId: string): void {
    const ep = this.findEpisode(episodeId);
    const series = this.currentSeries;
    const a = this.account;
    if (!ep || !series || !a) return;
    const saved = StorageService.getResume(a.id, 'episode', ep.id);
    this.handlers.onPlayVod({
      ...this.episodePlayback(series, ep),
      resumeSecs: saved ? saved.position : 0,
      episodeQueue: this.episodesAfter(ep.id, series),
      seriesEpisodes: this.allEpisodes().map((episode) => this.episodePlayback(series, episode)),
    });
  }

  private creds(): XtreamCredentials {
    const a = this.account!;
    return { baseUrl: a.url, username: a.xtream!.username, password: a.xtream!.password };
  }

  // A Continue-rail tile carries only the resume entry, so the owning series'
  // info is loaded to give the player its episode list and details. Without
  // it, the episode still resumes from the entry alone.
  private async playResume(episodeId: string): Promise<void> {
    const a = this.account;
    const r = this.resume.find((e) => e.itemId === episodeId);
    const signal = this.requestSignal;
    if (!a || !r || !signal) return;
    const request = ++this.resumeRequest;
    const seriesId = r.watchlistOwner?.itemId;
    let info: SeriesInfo | null = null;
    if (seriesId) {
      try {
        info = await loadSeriesInfo(a, seriesId, signal);
      } catch (err) {
        if (!this.requestFailed('Series resume load', err, signal)) return;
      }
    }
    if (request !== this.resumeRequest || signal.aborted || this.account !== a) return;
    const ep = info ? this.findEpisode(r.itemId, info) : null;
    if (info && ep && seriesId) {
      const series = this.resumeSeries(r, seriesId, ep, info);
      this.handlers.onPlayVod({
        ...this.episodePlayback(series, ep, info),
        url: xtreamEpisodeUrl(this.creds(), r.itemId, r.ext || ep.containerExtension || 'mp4'),
        resumeSecs: r.position,
        episodeQueue: this.episodesAfter(ep.id, series, info),
        seriesEpisodes: this.allEpisodes(info).map((episode) => this.episodePlayback(series, episode, info)),
      });
      return;
    }
    this.handlers.onPlayVod({
      url: xtreamEpisodeUrl(this.creds(), r.itemId, r.ext || 'mp4'),
      title: r.name,
      poster: r.poster,
      accountId: a.id,
      itemId: r.itemId,
      kind: 'episode',
      categoryId: r.categoryId,
      parentalItemId: r.watchlistOwner?.itemId,
      resumeSecs: r.position,
      subtitles: r.subtitles ?? [],
      searchMeta: r.searchMeta,
      episodeQueue: r.episodeQueue,
      watchlistOwner: r.watchlistOwner,
    });
  }

  // The series a resume entry belongs to: the catalog's own item when loaded,
  // else one rebuilt from the entry, its name cut from the composed label.
  private resumeSeries(r: ResumeEntry, seriesId: string, ep: Episode, info: SeriesInfo): SeriesItem {
    const known = this.findItem(r.categoryId ?? '', seriesId);
    if (known) return known;
    const cut = r.name.indexOf(` — ${episodeCode(ep)}`);
    return {
      accountId: r.accountId,
      seriesId,
      name: cut > 0 ? r.name.slice(0, cut) : r.name,
      poster: info.poster || r.poster,
      rating: info.rating,
      categoryId: r.categoryId ?? '',
    };
  }

  private resumeTile(r: ResumeEntry, managing = false): Safe {
    return html`
      <div class="catalog-tile" ${raw(managing ? '' : 'data-focusable')} data-key="r:${r.itemId}" data-resume-episode="${r.itemId}">
        <div class="catalog-poster-wrap">${this.posterCell(r.name, r.poster)}${
          this.itemLockBadge(r.categoryId ?? '', r.watchlistOwner?.itemId ?? r.itemId)}${
          this.progressBar(r.position, r.duration)}${this.removeMark(managing, `r:${r.itemId}`)}</div>
        <div class="catalog-tile-name">${r.name}</div>
      </div>
    `;
  }

  private episodeRow(accountId: string, ep: Episode, watched: string[]): Safe {
    const saved = StorageService.getResume(accountId, 'episode', ep.id);
    // An up-next entry has no position yet; it isn't a resume point.
    const started = saved && !saved.upNext ? saved : null;
    const mins = ep.durationSecs > 0 ? t('catalog.minutes', { count: Math.floor(ep.durationSecs / 60) }) : '';
    return html`
      <div class="episode-row" data-focusable data-key="ep:${ep.id}" data-episode-id="${ep.id}">
        <span class="episode-badge">${raw(PLAY_ICON)}</span>
        <div class="episode-body">
          <div class="episode-title">
            <span class="episode-num">E${ep.episode}</span>
            <span class="episode-name">${ep.title}</span>
            ${started
              ? html`<span class="episode-resume">${t('common.resume')}</span>`
              : watched.indexOf(ep.id) >= 0
                ? html`<span class="episode-watched">${t('epg.watched')}</span>`
                : ''}
          </div>
          ${mins ? html`<div class="episode-meta">${mins}</div>` : ''}
          ${ep.plot ? html`<p class="episode-plot">${ep.plot}</p>` : ''}
        </div>
        ${started ? this.progressBar(started.position, started.duration) : ''}
      </div>
    `;
  }

  protected renderDetail(restoreFocus = true): void {
    const series = this.currentSeries;
    const a = this.account;
    if (!series || !a) return;
    const info = this.currentInfo;
    const episodes = info ? (info.episodesBySeason[this.selectedSeason] ?? []) : [];
    const poster = info?.poster || series.poster;
    const year = info?.year ? String(info.year) : '';
    const mins = info && info.episodeRunTimeMins > 0
      ? t('catalog.minutes', { count: info.episodeRunTimeMins })
      : '';
    const meta = [year, mins, info?.genre, info?.rating || series.rating]
      .filter((value) => !!value);
    if (episodes !== this.episodeSource) {
      this.episodeSource = episodes;
      this.measuredEpisodes.clear();
      this.episodeVirtualizer.setItemSizes(episodes.map(ep =>
        ep.plot ? EPISODE_PLOT_ESTIMATE : EPISODE_NO_PLOT_ESTIMATE));
    }
    const focusedKey = this.focusedKey();
    const watchlisted = StorageService.isWatchlisted(a.id, 'series', series.seriesId);
    const watched = StorageService.getWatchedEpisodes(a.id, series.seriesId);
    const previousScroller = this.layer('detail').querySelector<HTMLElement>('.series-detail');
    const previousEpisodes = this.layer('detail').querySelector<HTMLElement>('.series-episodes');
    this.episodeVirtualizer.setLeadingSize(
      this.episodeListStart(previousScroller, previousEpisodes),
    );
    if (restoreFocus && previousScroller) {
      this.episodeVirtualizer.setScrollOffset(previousScroller.scrollTop);
    }
    const episodeViewport = (previousScroller && visibleHeight(previousScroller)) || EPISODE_VIEWPORT_FALLBACK;
    const focusedEpisodeIndex = focusedKey === null ? -1 : this.episodeIndexOf(focusedKey);
    if (restoreFocus && focusedEpisodeIndex >= 0) this.episodeFocusIndex = focusedEpisodeIndex;
    this.episodeFocusIndex = Math.max(0, Math.min(this.episodeFocusIndex, episodes.length - 1));
    if (restoreFocus && focusedEpisodeIndex >= 0 && episodes.length) {
      this.episodeVirtualizer.ensureVisible(this.episodeFocusIndex, episodeViewport);
    }
    const episodeRange = this.episodeVirtualizer.getRange(episodes.length, episodeViewport);

    morph(this.layer('detail'), html`
      <div class="catalog-view series-detail" data-nav-container>
        <div class="series-detail-head">
          <div class="detail-poster-wrap series-detail-poster">${this.posterCell(series.name, poster)}</div>
          <div class="detail-body">
            <h1 class="detail-title">${series.name}</h1>
            ${meta.length ? html`<div class="detail-meta">${meta.join('  ·  ')}</div>` : ''}
            ${info?.plot ? html`<p class="detail-plot">${info.plot}</p>` : ''}
            ${info?.cast ? html`<div class="detail-cast"><span class="detail-label">${t('catalog.cast')}</span> ${info.cast}</div>` : ''}
            ${info?.director ? html`<div class="detail-cast"><span class="detail-label">${t('catalog.director')}</span> ${info.director}</div>` : ''}
            <div class="detail-actions">
              ${this.detailLoading ? '' : this.continueButton()}
              <button class="detail-btn" data-focusable data-key="watchlist" data-action="watchlist">
                <span class="detail-btn-icon">${raw(watchlistIcon(watchlisted))}</span>
                <span>${t(watchlisted ? 'catalog.removeWatchlist' : 'catalog.addWatchlist')}</span>
              </button>
            </div>
            ${this.detailLoading
              ? html`<p class="catalog-hint">${t('common.loading')}</p>`
              : !info
                ? html`<p class="catalog-hint">${t('catalog.loadEpisodesFailed')}</p>`
                : info.seasons.length === 0
                  ? html`<p class="catalog-hint">${t('catalog.noEpisodes')}</p>`
                  : html`
                  <div class="series-seasons">
                    ${info.seasons.map((n) => html`
                      <button class="series-season-btn ${n === this.selectedSeason ? 'active' : ''}"
                              data-focusable data-key="season:${n}" data-season="${n}">${t('catalog.season', { number: n })}</button>
                    `)}
                  </div>
                `}
          </div>
        </div>
        ${info && info.seasons.length > 0 ? html`
          <div class="series-episodes">
            ${episodes.length === 0
              ? html`<p class="catalog-hint">${t('catalog.noSeasonEpisodes')}</p>`
              : html`
                <div class="series-episodes-spacer"
                     style="height:${this.episodeVirtualizer.getTotalSize(episodes.length)}px">
                  ${episodes.slice(episodeRange.start, episodeRange.end).map((ep, offset) => {
                    const index = episodeRange.start + offset;
                    return html`
                      <div class="series-episode-cell"
                           data-key="episode-cell:${ep.id}"
                           data-episode-index="${index}"
                           style="top:${this.episodeVirtualizer.getItemOffset(index)}px">
                        ${this.episodeRow(a.id, ep, watched)}
                      </div>
                    `;
                  })}
                </div>
              `}
          </div>
        ` : ''}
      </div>
    `);
    const measuredSizes = Array.from(
      this.layer('detail').querySelectorAll<HTMLElement>('.series-episode-cell'),
    ).map(cell => ({
      cell,
      index: parseInt(cell.dataset.episodeIndex || '-1', 10),
    })).filter(item => item.index >= 0 && !this.measuredEpisodes.has(item.index))
      .map((item) => {
        this.measuredEpisodes.add(item.index);
        const row = item.cell.querySelector<HTMLElement>('.episode-row');
        return {
          index: item.index,
          size: row ? row.getBoundingClientRect().height + EPISODE_GAP : 0,
        };
      }).filter(item => item.index >= 0 && item.size > EPISODE_GAP);
    if (this.episodeVirtualizer.updateItemSizes(measuredSizes)) {
      this.renderDetail(restoreFocus);
      return;
    }
    const episodeList = this.layer('detail').querySelector<HTMLElement>('.series-episodes');
    const scroller = this.layer('detail').querySelector<HTMLElement>('.series-detail');
    if (scroller) {
      this.episodeVirtualizer.setLeadingSize(this.episodeListStart(scroller, episodeList));
      this.scrollGuard.syncOffset(
        scroller,
        'vertical',
        this.episodeVirtualizer.scrollOffset,
        this.instantEpisodeScroll,
      );
    }
    if (restoreFocus) this.settleDetailFocus();
  }

  private selectedEpisodes(): Episode[] {
    return this.currentInfo?.episodesBySeason[this.selectedSeason] ?? [];
  }

  private episodeIndexOf(key: string): number {
    return this.selectedEpisodes().findIndex((ep) => `ep:${ep.id}` === key);
  }

  protected hasExtraKey(key: string): boolean {
    return this.episodeIndexOf(key) >= 0;
  }

  // An episode the list scrolled away renders again before it is shown.
  protected revealExtraKey(key: string, instant: boolean): boolean | null | undefined {
    const index = this.episodeIndexOf(key);
    if (index < 0 || this.layer('detail').querySelector(`[data-episode-index="${index}"]`)) {
      return undefined;
    }
    const list = this.layer('detail').querySelector<HTMLElement>('.series-detail');
    const viewport = (list && visibleHeight(list)) || EPISODE_VIEWPORT_FALLBACK;
    this.episodeFocusIndex = index;
    this.episodeVirtualizer.ensureVisible(index, viewport);
    if (instant) this.instantEpisodeScroll = true;
    try {
      this.renderDetail(false);
      // The render measured the rows the estimate had placed it by.
      if (this.episodeVirtualizer.ensureVisible(index, viewport)) this.renderDetail(false);
    } finally {
      this.instantEpisodeScroll = false;
    }
    return true;
  }

  protected moveExtraFocus(action: Action): boolean {
    if (this.mode !== 'detail' || (action !== 'up' && action !== 'down')) return false;
    const key = this.focusedKey();
    const current = key === null ? -1 : this.episodeIndexOf(key);
    if (current < 0) return false;
    const episodes = this.selectedEpisodes();
    const next = current + (action === 'up' ? -1 : 1);
    if (next < 0 || next >= episodes.length) return false;
    const list = this.layer('detail').querySelector<HTMLElement>('.series-detail');
    this.episodeFocusIndex = next;
    this.episodeVirtualizer.ensureVisible(
      next,
      list?.clientHeight || EPISODE_VIEWPORT_FALLBACK,
    );
    this.renderDetail(false);
    this.place(
      this.layer('detail').querySelector<HTMLElement>(
        `[data-episode-index="${next}"] [data-focusable]`,
      ),
      'key',
    );
    return true;
  }

  protected handleExtraScroll(target: HTMLElement): boolean {
    if (this.mode !== 'detail' || !target.classList.contains('series-detail')) return false;
    const offset = this.scrollGuard.readUserOffset(target, 'vertical');
    if (offset === null) return true;
    this.episodeVirtualizer.setScrollOffset(offset);
    if (this.episodeScrollFrame === null) {
      this.episodeScrollFrame = requestAnimationFrame(() => {
        this.episodeScrollFrame = null;
        if (this.mode === 'detail') this.renderDetail(false);
      });
    }
    return true;
  }

  // Where the episode list starts inside the scrolling detail page, i.e. the
  // header the virtualizer has to skip before item 0. Both share an
  // offsetParent (the page is statically positioned), so the difference is the
  // in-content distance and stays correct while the page is scrolled.
  private episodeListStart(
    scroller: HTMLElement | null,
    list: HTMLElement | null,
  ): number {
    if (!scroller || !list) return 0;
    const top = list.offsetParent === scroller
      ? list.offsetTop
      : list.offsetTop - scroller.offsetTop;
    return Math.max(0, top);
  }
}

function episodeCode(ep: Pick<Episode, 'season' | 'episode'>): string {
  return `S${ep.season}E${ep.episode}`;
}
