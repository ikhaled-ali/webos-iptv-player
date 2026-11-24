import type {
  Action,
  PlaylistEntry,
  ResumeEntry,
  ResumeKind,
  VodPlayback,
  WatchlistEntry,
  WatchlistKind,
} from '../types';
import { SpatialNav, isFocusMove } from '../navigation/spatial-nav';
import { Focus, type FocusScope, type Via } from '../navigation/focus-scope';
import { FocusRing, ringShown } from '../navigation/focus-ring';
import { InputMode } from '../navigation/input-mode';
import { html, raw, Safe, scrollInsetTop, visibleHeight, withInstantScroll } from '../utils/dom';
import { groupIcon } from './group-icon';
import { categoryLockBadge, lockBadge } from './parental-badge';
import { SORT_ASCENDING_ICON, SORT_DESCENDING_ICON, REMOVE_ICON, CHECK_ICON, TRASH_ICON, PENCIL_ICON, LIVE_CATEGORIES_ICON } from './icons';
import { ConfirmationPrompt } from './confirmation-prompt';
import { artBoxClass, posterCard, posterImage, posterSeeAllCard, progressBar, type ArtKind } from './item-cards';
import { backKey, okHint } from './key-hints';
import { showToast } from './toast';
import { dropdown, toggleDropdown, closeDropdown, commitDropdownOption } from './dropdown';
import { morph } from '../utils/morph';
import { StorageService } from '../services/storage-service';
import { latestPerSeries, resumeSeriesId } from '../utils/vod-progress';
import {
  catalogParentalRequest,
  isResumeConcealed,
  isWatchlistConcealed,
  ParentalControlService,
} from '../services/parental-control';
import { CONFIG } from '../config';
import { getLocale, t } from '../i18n';
import { VirtualGrid } from '../utils/virtual-grid';
import { VirtualList } from '../utils/virtual-list';
import { VirtualScrollGuard } from '../utils/virtual-scroll';
import { createLogger } from '../utils/logger';
import {
  defaultSortDirection, isCatalogSort, sortCatalogItems,
  type CatalogSort, type CatalogSortDirection, type CatalogSortItem, type CatalogSortPreference,
} from '../utils/catalog-sort';
import { inlineScrollStart, inlineStartSide, setInlineScrollStart } from '../utils/scroll-axis';

const log = createLogger('Catalog');

const SORT_DIRECTION_LABELS = {
  name: { asc: 'catalog.sortAToZ', desc: 'catalog.sortZToA' },
  added: { asc: 'catalog.sortOldest', desc: 'catalog.sortNewest' },
  year: { asc: 'catalog.sortOldest', desc: 'catalog.sortNewest' },
  rating: { asc: 'catalog.sortLowest', desc: 'catalog.sortHighest' },
} as const;

function sortDirectionLabel(by: Exclude<CatalogSort, 'default'>, direction: CatalogSortDirection): string {
  return t(SORT_DIRECTION_LABELS[by][direction]);
}

// The field's starting direction leads, so Newest sits before Oldest.
function sortDirections(by: CatalogSort): CatalogSortDirection[] {
  return defaultSortDirection(by) === 'asc' ? ['asc', 'desc'] : ['desc', 'asc'];
}

const CATALOG_GRID_COLUMN_STRIDE = 244;
const CATALOG_GRID_POSTER_WIDTH = 220;
const CATALOG_GRID_ROW_STRIDE = 395;
const CATALOG_GRID_OVERSCAN_ROWS = 2;
const CATALOG_GRID_VIEWPORT_WIDTH = 1760;
// Beside the category panel: the 1920 canvas less the 380px panel and the gutters.
const CATALOG_GRID_PANEL_VIEWPORT_WIDTH = 1400;
const PANEL_RAIL = 'all-categories';
// The panel's first row: the rails page. No provider category key starts without `c:`.
const FEATURED_PANEL_ENTRY = 'featured';
const CATALOG_GRID_VIEWPORT_HEIGHT = 900;
// A category row is Live's .group-item: 60px plus its 8px vertical margin.
const CATEGORY_ROW_STRIDE = 68;
const CATEGORY_PANEL_VIEWPORT = 900;

// Matches the rail track's padding and its end spacer in catalog-view.css.
const RAIL_EDGE_GUTTER = CONFIG.NAVIGATION.REVEAL_MARGIN;

export interface CatalogHandlers {
  onRevealTabBar: (dir?: 'up' | 'left') => void;
  onBack: () => void;
  onPlayVod: (req: Omit<VodPlayback, 'onBack'>) => void;
}

type Mode = 'browse' | 'grid' | 'detail';

export type CollectionKind = 'continue' | 'watchlist';

export interface CollectionEntry {
  id: string;
  key: string;
  tile: (managing: boolean) => Safe;
}

interface GridSource {
  count: number;
  keyAt: (index: number) => string;
  render: (index: number) => Safe;
}

interface BrowseReturn {
  el: HTMLElement;
  railKey: string;
  index: number;
}

// Tile keys repeat across rails (a resumed title is also in its category) and
// detail buttons across items, so a focus key names the mode and rail too.
// The category panel sits beside browse and grid, so its keys outlive a mode switch.
type KeyMode = Mode | 'panel';

interface CatalogKey {
  mode: KeyMode;
  rail: string;
  key: string;
}

function parseKey(key: string | null): CatalogKey | null {
  if (key === null) return null;
  try {
    const parts: unknown = JSON.parse(key);
    if (!Array.isArray(parts) || parts.length !== 3) return null;
    const [mode, rail, item] = parts as unknown[];
    if (mode !== 'browse' && mode !== 'grid' && mode !== 'detail' && mode !== 'panel') return null;
    if (typeof rail !== 'string' || typeof item !== 'string') return null;
    return { mode, rail, key: item };
  } catch {
    return null;
  }
}

function isScroller(overflow: string): boolean {
  return overflow === 'auto' || overflow === 'scroll';
}

// Shared browse/grid/detail machinery for the Xtream catalog sections (Movies,
// Series): a poster rails browse view, a per-category poster grid, and a
// detail screen. One focus scope holds the focused tile or button across all
// modes, and a SpatialNav only picks the next one geometrically. Up at the top
// row hands off to the tab bar; Back walks detail -> grid -> browse -> Live.
// Each mode renders into its own stacked layer. Browse stays resident (hidden,
// not rebuilt) while a grid or detail is open, so Back finds its rails, scroll
// positions, and focused tile exactly as they were.
// Subclasses supply the catalog loaders, item accessors, and the detail
// rendering / playback specifics.

export abstract class CatalogView<C extends { id: string; name: string }, I extends CatalogSortItem> {
  protected nav: SpatialNav;
  protected account: PlaylistEntry | null = null;
  protected mode: Mode = 'browse';
  protected categories: C[] = [];
  protected railGroups: { category: C; items: I[] }[] = [];
  protected resume: ResumeEntry[] = [];
  protected itemsByCategory: Record<string, I[]> = {};
  private serverItemsByCategory: Record<string, I[]> = {};
  private sort: CatalogSortPreference = { by: 'default', direction: 'asc' };
  private resetBrowseRailOffsets = false;
  private browseSortReturn: string | null = null;
  protected gridCategory: C | null = null;
  private collection: CollectionKind | null = null;
  private managing = false;
  private readonly clearPrompt: ConfirmationPrompt;
  protected deepLinkBack: (() => void) | null = null;
  private gridFocusIndex = 0;
  private gridReturnKey: string | null = null;
  // The browse tile that opened a grid or detail, refocused on Back.
  private readonly gridVirtualizer = new VirtualGrid({
    revealMargin: CONFIG.NAVIGATION.REVEAL_MARGIN,
    columnStride: CATALOG_GRID_COLUMN_STRIDE,
    rowStride: CATALOG_GRID_ROW_STRIDE,
    overscanRows: CATALOG_GRID_OVERSCAN_ROWS,
    fallbackViewportWidth: CATALOG_GRID_VIEWPORT_WIDTH,
    fallbackViewportHeight: CATALOG_GRID_VIEWPORT_HEIGHT,
  });
  private gridScrollFrame: number | null = null;
  private readonly categoryVirtualizer = new VirtualList({
    revealMargin: CONFIG.NAVIGATION.REVEAL_MARGIN,
    itemSize: CATEGORY_ROW_STRIDE,
    overscan: 12,
    fallbackViewportSize: CATEGORY_PANEL_VIEWPORT,
  });
  private categoryScrollFrame: number | null = null;
  // The All categories window last rendered; its cells sit at fixed offsets,
  // so a scroll inside the window needs no render.
  private categoryWindow = '';
  protected readonly scrollGuard = new VirtualScrollGuard();
  private requestController: AbortController | null = null;
  private readonly layers: Record<Mode, HTMLElement>;
  private readonly panel: HTMLElement;
  // The content focus Left left for the panel; Right goes back to it.
  private contentReturnKey: string | null = null;
  private browseReturn: BrowseReturn | null = null;
  private panelReturnKey: string | null = null;
  // The category whose items the shown grid is still waiting for.
  private gridLoadingId: string | null = null;
  private gridRequest = 0;
  private browseStale = false;
  readonly focusScope: FocusScope;
  // How the element SpatialNav is picking was asked for; null only follows it.
  private pickVia: Via | null = null;
  private lastRevealKey: string | null = null;
  private lastRevealAt = 0;
  private lastRevealInstant = false;

  constructor(protected container: HTMLElement, protected handlers: CatalogHandlers) {
    const layer = (mode: Mode): HTMLElement => {
      const el = document.createElement('div');
      el.className = `catalog-layer catalog-layer-${mode}`;
      if (mode !== 'browse') el.classList.add('catalog-layer-hidden');
      container.appendChild(el);
      return el;
    };
    this.panel = document.createElement('div');
    this.panel.className = 'catalog-panel-host';
    container.appendChild(this.panel);
    this.layers = { browse: layer('browse'), grid: layer('grid'), detail: layer('detail') };
    this.nav = new SpatialNav(container, (el) => this.onFocusChanged(el), { follow: false });
    this.nav.setRestrict(this.layers.browse);
    this.clearPrompt = new ConfirmationPrompt(`prompt.${this.scopeName()}.collection`);
    this.focusScope = Focus.register({
      id: `${this.scopeName()}.catalog`,
      root: container,
      leaveFor: { up: 'tabbar', left: 'tabbar' },
      defaultKey: () => this.defaultKey(),
      resolve: (key) => this.resolveKey(key),
      has: (key) => this.hasKey(key),
      reveal: (key) => this.revealKey(key),
      concealOnLeave: true,
    });
    // The pointer lights a tile or button where it rests, without scrolling.
    this.container.addEventListener('nav:hover', (e: Event) => {
      const target = e.target as HTMLElement;
      if (!target.hasAttribute('data-focusable') || !this.inShownRegion(target)) return;
      const menu = this.openDropdown();
      if (menu && !menu.contains(target)) return;
      this.place(target, 'pointer');
    });
    this.container.addEventListener('click', (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.catalog-sort, .dropdown, [data-collection-manage], [data-collection-see-all], [data-collection-action]')) return;
      const el = target.closest<HTMLElement>('[data-focusable]');
      if (!el || !this.layers[this.mode].contains(el)) return;
      this.place(el, 'pointer');
      this.onSelect();
    });
    document.addEventListener('click', (e: MouseEvent) => {
      const menu = this.openDropdown();
      if (menu && !menu.contains(e.target as Node)) this.dismissDropdown(null);
    }, true);
    // A ring the pointer left stays off; the next key only shows it again.
    this.container.addEventListener('nav:unhover', (e: Event) => {
      if (e.target === this.current()) this.focusScope.conceal();
    });
    this.container.addEventListener('scroll', (event: Event) => {
      const target = event.target as HTMLElement;
      if (this.handleExtraScroll(target)) return;
      if (target.classList.contains('catalog-category-list')) {
        const offset = this.scrollGuard.readUserOffset(target, 'vertical');
        if (offset === null) return;
        this.categoryVirtualizer.setScrollOffset(offset);
        if (this.categoryScrollFrame === null) {
          this.categoryScrollFrame = requestAnimationFrame(() => {
            this.categoryScrollFrame = null;
            if (this.panelShown()) {
              const latest = this.scrollGuard.readUserOffset(target, 'vertical');
              if (latest !== null) this.categoryVirtualizer.setScrollOffset(latest);
              if (this.categoryWindow !== this.categoryWindowFor(target.clientHeight)) {
                this.renderPanel();
              }
            }
          });
        }
        return;
      }
      if (this.mode !== 'grid' || !target.classList.contains('catalog-grid')) return;
      const scrollTop = this.scrollGuard.readUserOffset(target, 'vertical');
      if (scrollTop === null) return;
      const track = this.layers.grid.querySelector<HTMLElement>('.catalog-grid-track');
      this.gridVirtualizer.setScrollOffset(
        Math.max(0, scrollTop - this.gridTrackStart(target, track)),
      );
      if (this.gridScrollFrame !== null) return;
      this.gridScrollFrame = requestAnimationFrame(() => {
        this.gridScrollFrame = null;
        if (this.mode === 'grid' && this.gridVirtualizer.rangeStale()) this.renderGrid(false, true);
      });
    }, true);
  }

  // Leaving for the tab bar rewinds only the way it left: Up scrolls back to
  // the top, Left scrolls the rails back to their first tiles.
  private leaveForTabBar(dir: 'up' | 'left'): void {
    this.handlers.onRevealTabBar(dir);
    if (this.mode === 'browse') this.rewindBrowse(dir);
    else if (this.mode === 'grid' && dir === 'up') this.rewindGrid();
  }

  // The same for a See all grid: its first row, and the focus on its first tile.
  private rewindGrid(): void {
    this.gridFocusIndex = 0;
    this.gridVirtualizer.setScrollOffset(0);
    this.nav.forgetLastFocused();
    this.renderGrid(false);
    const grid = this.layers.grid;
    const view = grid.querySelector<HTMLElement>('.catalog-grid');
    if (view) this.scrollGuard.syncOffset(view, 'vertical', 0, true);
    this.place(grid.querySelector<HTMLElement>('[data-grid-index="0"] [data-focusable]')
      ?? this.nav.first(), null);
  }

  // Up puts the rails back at their top, focus on the first tile; Left
  // scrolls every rail back to its first tile and keeps the focused row.
  private rewindBrowse(dir: 'up' | 'left'): void {
    const browse = this.layers.browse;
    if (dir === 'up') {
      const rails = browse.querySelector<HTMLElement>('.catalog-rails');
      if (rails) this.scrollGuard.syncOffset(rails, 'vertical', 0, true);
      this.browseSortReturn = null;
      this.renderBrowse(false);
      return;
    }
    browse.querySelectorAll<HTMLElement>('.catalog-rail-track')
      .forEach(track => this.scrollGuard.syncOffset(track, 'horizontal', 0, true));
    this.nav.forgetLastFocused();
    this.renderBrowse(false);
  }

  // --- subclass configuration ---
  // The focus scope's prefix, e.g. 'movies'; a method, as the constructor reads it.
  protected abstract scopeName(): string;
  protected abstract readonly kicker: string;             // section label, e.g. 'Movies'
  protected abstract readonly resumeKind: ResumeKind;     // which resume entries this section owns
  protected abstract readonly emptyMessage: string;       // no catalog on the account
  protected abstract readonly gridEmptyMessage: string;   // empty category grid
  protected abstract loadCategories(
    account: PlaylistEntry,
    signal: AbortSignal,
  ): Promise<C[]>;
  protected abstract loadItems(
    account: PlaylistEntry,
    categoryId: string,
    signal: AbortSignal,
  ): Promise<I[]>;
  protected abstract itemId(item: I): string;
  protected abstract itemName(item: I): string;
  protected abstract itemPoster(item: I): string;
  protected abstract itemCategoryId(item: I): string;
  protected abstract itemCount(count: number): string;
  protected abstract readonly parentalKind: 'vod' | 'series';
  protected abstract openDetail(item: I): Promise<void>;
  protected abstract renderDetail(restoreFocus?: boolean): void;
  protected abstract clearDetail(): void;                 // drop detail state on deep-link back
  // Section-specific selects (play/resume/season/episode). Returns true if handled.
  protected abstract selectExtra(el: HTMLElement): boolean;
  protected moveExtraFocus(_action: Action): boolean { return false; }
  // A detail key the subclass virtualizes: whether it is still listed, and
  // bringing it into view (true when that scrolled, null when nothing had to).
  protected hasExtraKey(_key: string): boolean { return false; }
  protected revealExtraKey(_key: string, _instant: boolean): boolean | null | undefined {
    return undefined;
  }
  protected handleExtraScroll(_target: HTMLElement): boolean { return false; }
  protected onRequestSessionReset(): void {}
  protected abstract collectionEntries(kind: CollectionKind): CollectionEntry[];
  // A tile id that isn't in a loaded category (Continue/Watchlist); default none.
  protected fallbackItem(_id: string): I | null { return null; }

  // The active mode's layer; hidden layers keep their DOM but never take focus.
  protected layer(mode: Mode = this.mode): HTMLElement {
    return this.layers[mode];
  }

  protected showLayer(mode: Mode): void {
    if (mode !== this.mode) this.dismissDropdown(null);
    if (this.mode === 'browse' && mode !== 'browse') this.leaveBrowse();
    this.mode = mode;
    (Object.keys(this.layers) as Mode[]).forEach((key) => {
      this.layers[key].classList.toggle('catalog-layer-hidden', key !== mode);
    });
    this.nav.setRestrict(this.layers[mode]);
    this.renderPanel();
  }

  // --- category panel ---

  // Beside browse and grid once the categories are in; detail covers it.
  private panelShown(): boolean {
    return this.mode !== 'detail' && this.categories.length > 0;
  }

  private inShownRegion(el: HTMLElement): boolean {
    return this.layers[this.mode].contains(el) || (this.panelShown() && this.panel.contains(el));
  }

  protected renderPanel(): void {
    const shown = this.panelShown();
    this.container.classList.toggle('catalog-with-panel', shown);
    if (!shown) {
      morph(this.panel, html``);
      return;
    }
    const count = this.panelCount();
    const list = this.panel.querySelector<HTMLElement>('.catalog-category-list');
    const range = this.categoryVirtualizer.getRange(count, this.categoryListHeight(list));
    this.categoryWindow = `${String(count)}:${String(range.start)}:${String(range.end)}`;
    const active = this.mode === 'grid' && !this.collection ? this.gridCategory?.id : undefined;
    const rows: Safe[] = [];
    for (let index = range.start; index < range.end; index++) {
      const top = this.categoryVirtualizer.getItemOffset(index);
      if (index === 0) {
        rows.push(html`
          <div class="group-item catalog-cat-featured${this.mode === 'browse' ? ' active' : ''}" data-focusable
               data-key="${FEATURED_PANEL_ENTRY}" data-category-virtual-index="0" style="top:${top}px">
            <span class="group-icon">${raw(groupIcon('', 'all'))}</span>
            <span class="group-name">${t('catalog.featuredCategory')}</span>
          </div>
        `);
        continue;
      }
      const c = this.categories[index - 1];
      rows.push(html`
        <div class="group-item catalog-cat${c.id === active ? ' active' : ''}" data-focusable
             data-key="c:${c.id}" data-category-id="${c.id}"
             data-category-virtual-index="${index}" style="top:${top}px">
          <span class="group-icon">${raw(groupIcon(c.name))}</span>
          <span class="group-name">${
            raw(categoryLockBadge(this.parentalKind, this.account!.id, c.id))
          }${c.name}</span>
        </div>
      `);
    }
    morph(this.panel, html`
      <div class="sidebar catalog-category-panel" data-rail-key="${PANEL_RAIL}" data-nav-container>
        <div class="sidebar-header">
          <span class="sidebar-label-icon">${raw(LIVE_CATEGORIES_ICON)}</span>
          <h2 class="sidebar-label">${t('catalog.allCategories')}</h2>
        </div>
        <div class="group-list catalog-category-list">
          <div class="group-list-spacer"
               style="height:${this.categoryVirtualizer.getTotalSize(count)}px">${rows}
          </div>
        </div>
      </div>
    `);
    const rendered = this.panel.querySelector<HTMLElement>('.catalog-category-list');
    if (rendered) {
      this.scrollGuard.syncOffset(rendered, 'vertical', this.categoryVirtualizer.scrollOffset);
    }
  }

  private panelFocused(): boolean {
    return parseKey(this.focusScope.focusKey)?.mode === 'panel';
  }

  private panelKey(categoryId: string): string {
    return this.panelKeyFor(`c:${categoryId}`);
  }

  private panelKeyFor(rowKey: string): string {
    return JSON.stringify(['panel', PANEL_RAIL, rowKey]);
  }

  // Featured first, then every category.
  private panelCount(): number {
    return this.categories.length + 1;
  }

  private panelIndexOf(rowKey: string): number {
    if (rowKey === FEATURED_PANEL_ENTRY) return 0;
    const index = this.categoryIndexOf(rowKey);
    return index < 0 ? -1 : index + 1;
  }

  private panelKeyAt(index: number): string {
    return index === 0 ? this.panelKeyFor(FEATURED_PANEL_ENTRY) : this.panelKey(this.categories[index - 1].id);
  }

  // Back to the rails page, keeping the focus where it is.
  private closeGrid(): void {
    this.managing = false;
    this.gridCategory = null;
    this.collection = null;
    this.contentReturnKey = null;
    this.renderBrowse();
    this.clearLayer('grid');
  }

  // The panel's own key: the open category, else the row last focused, else the first.
  private panelEntryKey(): string | null {
    if (!this.panelShown()) return null;
    const active = this.mode === 'grid' && !this.collection ? this.gridCategory : null;
    if (active && this.categoryIndexOf(`c:${active.id}`) >= 0) return this.panelKey(active.id);
    if (this.mode === 'browse') return this.panelKeyFor(FEATURED_PANEL_ENTRY);
    if (this.panelReturnKey && this.hasKey(this.panelReturnKey)) return this.panelReturnKey;
    return this.panelKeyFor(FEATURED_PANEL_ENTRY);
  }

  // Content is left of nothing but the panel; detail, with no panel, leaves for the tab bar.
  private leaveContentLeft(): void {
    if (!this.focusCategoryPanel()) this.leaveForTabBar('left');
  }

  // Into the panel from the content, remembering where Right comes back to.
  private focusCategoryPanel(): boolean {
    const key = this.panelEntryKey();
    if (!key) return false;
    this.contentReturnKey = this.focusScope.focusKey;
    this.request(key, 'key');
    return true;
  }

  // Out of the panel into the content: where Left came from, else its first item.
  private focusContent(): void {
    const back = this.contentReturnKey;
    this.contentReturnKey = null;
    if (back && parseKey(back)?.mode === this.mode && this.hasOrResolves(back)) {
      this.request(back, 'key');
      return;
    }
    if (this.mode === 'grid') {
      if (this.gridSource().count) {
        this.revealGridIndex(this.gridFocusIndex);
        const cell = this.layers.grid.querySelector<HTMLElement>(
          `[data-grid-index="${this.gridFocusIndex}"] [data-focusable]`,
        );
        if (cell) {
          this.place(cell, 'key');
          return;
        }
      }
      this.place(this.nav.first(), 'key');
      return;
    }
    this.place(this.layers.browse.querySelector<HTMLElement>('.catalog-tile[data-focusable]')
      ?? this.nav.first(), 'key');
  }

  private hasOrResolves(key: string): boolean {
    return this.hasKey(key) || this.resolveKey(key) !== null;
  }

  // Keys embed provider ids, so compare rather than build a selector from them.
  protected focusableByKey(root: HTMLElement, key: string): HTMLElement | null {
    return Array.from(root.querySelectorAll<HTMLElement>('[data-focusable][data-key]'))
      .find((el) => el.getAttribute('data-key') === key) ?? null;
  }

  protected clearLayer(mode: Mode): void {
    if (mode === 'grid') this.gridReturnKey = null;
    morph(this.layers[mode], html``);
  }

  // Detail entry for subclasses: remembers where browse focus was first.
  protected enterDetail(): void {
    if (this.mode === 'grid') this.gridReturnKey = this.focusedKey();
    this.showLayer('detail');
    // A new item's detail starts on its first button.
    this.focusScope.track(null);
  }

  // --- focus ---

  private keyFor(el: HTMLElement): string {
    if (this.panel.contains(el)) {
      return JSON.stringify(['panel', PANEL_RAIL, el.getAttribute('data-key') ?? '']);
    }
    const rail = el.closest<HTMLElement>('[data-rail-key]')?.dataset.railKey ?? '';
    return JSON.stringify([this.mode, rail, el.getAttribute('data-key') ?? '']);
  }

  // The focused item's own data-key, while the focus belongs to the shown mode.
  protected focusedKey(): string | null {
    const parsed = parseKey(this.focusScope.focusKey);
    return parsed && parsed.mode === this.mode ? parsed.key : null;
  }

  // The element that holds the focus, if it is rendered in the shown mode.
  protected current(): HTMLElement | null {
    const key = this.focusScope.focusKey;
    return key === null ? null : this.resolveKey(key);
  }

  private resolveKey(key: string): HTMLElement | null {
    const parsed = parseKey(key);
    if (parsed?.mode === 'panel') {
      return this.panelShown() ? this.focusableByKey(this.panel, parsed.key) : null;
    }
    if (!parsed || parsed.mode !== this.mode) return null;
    const layer = this.layers[parsed.mode];
    const rail = parsed.rail
      ? Array.from(layer.querySelectorAll<HTMLElement>('[data-rail-key]'))
        .find((el) => el.dataset.railKey === parsed.rail) ?? null
      : layer;
    return rail ? this.focusableByKey(rail, parsed.key) : null;
  }

  private defaultKey(): string | null {
    const panel = this.panelEntryKey();
    if (panel) return panel;
    const first = this.nav.first();
    return first ? this.keyFor(first) : null;
  }

  // Keys the virtualized grid, category rail, or episode list may not render.
  private hasKey(key: string): boolean {
    const parsed = parseKey(key);
    if (parsed?.mode === 'panel') return this.panelShown() && this.panelIndexOf(parsed.key) >= 0;
    if (!parsed || parsed.mode !== this.mode) return false;
    if (parsed.mode === 'grid') return this.gridIndexOf(parsed.key) >= 0;
    if (parsed.mode === 'browse') return false;
    return this.hasExtraKey(parsed.key);
  }

  private gridIndexOf(key: string): number {
    const source = this.gridSource();
    for (let index = 0; index < source.count; index++) {
      if (source.keyAt(index) === key) return index;
    }
    return -1;
  }

  private gridSource(): GridSource {
    if (this.collection) {
      const entries = this.collectionEntries(this.collection);
      return {
        count: entries.length,
        keyAt: index => entries[index].key,
        render: index => entries[index].tile(this.managing),
      };
    }
    const cat = this.gridCategory;
    const items = cat ? (this.itemsByCategory[cat.id] ?? []) : [];
    return {
      count: items.length,
      keyAt: index => `i:${this.itemCategoryId(items[index])}:${this.itemId(items[index])}`,
      render: index => this.tile(items[index]),
    };
  }

  private categoryIndexOf(key: string): number {
    return this.categories.findIndex((c) => `c:${c.id}` === key);
  }

  // Keeps the focus in view; a virtualized list scrolls its window first.
  private revealKey(key: string): boolean | null {
    const parsed = parseKey(key);
    if (!parsed || (parsed.mode !== this.mode && !(parsed.mode === 'panel' && this.panelShown()))) {
      return null;
    }
    const now = Date.now();
    if (key !== this.lastRevealKey) {
      // A held key steps instantly, so the focus never outruns its scroll.
      this.lastRevealInstant = this.lastRevealAt !== 0
        && now - this.lastRevealAt <= CONFIG.NAVIGATION.FOCUS_REPEAT_WINDOW_MS;
      this.lastRevealKey = key;
      this.lastRevealAt = now;
    } else if (now - this.lastRevealAt > CONFIG.NAVIGATION.FOCUS_REPEAT_WINDOW_MS) {
      // A later input that only reveals the same key scrolls smoothly again.
      this.lastRevealInstant = false;
    }
    const instant = this.lastRevealInstant;
    let scrolled = false;
    // The grid's window owns its scroll offset; it alone brings a cell in.
    if (parsed.mode === 'grid' && this.gridIndexOf(parsed.key) >= 0) {
      return this.revealGridIndex(this.gridIndexOf(parsed.key)) ? true : null;
    }
    if (parsed.mode === 'panel') {
      scrolled = this.revealCategoryIndex(this.panelIndexOf(parsed.key));
    } else if (parsed.mode === 'detail') {
      const extra = this.revealExtraKey(parsed.key, instant);
      if (extra !== undefined) return extra;
    }
    const el = this.resolveKey(key);
    // The detail's top row brings back the whole header, title and poster too.
    if (parsed.mode === 'detail' && el && this.onDetailTopRow(el)) {
      return this.scrollToTop(el, instant) ? true : null;
    }
    if (el && this.revealElement(el, instant)) scrolled = true;
    return scrolled ? true : null;
  }

  private onDetailTopRow(el: HTMLElement): boolean {
    const top = el.getBoundingClientRect().top;
    const items = this.layer('detail').querySelectorAll<HTMLElement>('[data-focusable]');
    for (let i = 0; i < items.length; i++) {
      const r = items[i].getBoundingClientRect();
      if (r.height > 0 && r.bottom <= top + 1) return false;
    }
    return true;
  }

  private scrollToTop(el: HTMLElement, instant: boolean): boolean {
    let scrolled = false;
    for (let n = el.parentElement; n && n !== this.container; n = n.parentElement) {
      if (n.scrollTop <= 0) continue;
      const scroller = n;
      if (instant) withInstantScroll([scroller], () => { scroller.scrollTop = 0; });
      else scroller.scrollTop = 0;
      scrolled = true;
    }
    return scrolled;
  }

  // Compares against the window's recorded offset, not the live scrollTop,
  // which lags a smooth scroll the last step started. Past the scroll
  // guard's two frames, the rest of that scroll reads as a user scroll and
  // moves the recorded offset with it.
  private revealGridIndex(index: number): boolean {
    if (index < 0) return false;
    this.gridFocusIndex = index;
    const view = this.layers.grid.querySelector<HTMLElement>('.catalog-grid');
    const track = this.layers.grid.querySelector<HTMLElement>('.catalog-grid-track');
    if (!this.gridVirtualizer.ensureVisible(
      index,
      track?.clientWidth || this.gridFallbackWidth(),
      view?.clientHeight || CATALOG_GRID_VIEWPORT_HEIGHT,
    )) return false;
    this.renderGrid(false);
    return true;
  }

  private revealCategoryIndex(index: number): boolean {
    if (index < 0) return false;
    const list = this.panel.querySelector<HTMLElement>('.catalog-category-list');
    if (!this.categoryVirtualizer.ensureVisible(index, this.categoryListHeight(list))) {
      return false;
    }
    this.renderPanel();
    return true;
  }

  // Scrolls each scroller around `el` just enough to show it whole; a rail
  // tile also keeps a gutter beside it. True when anything scrolled.
  private revealElement(el: HTMLElement, instant: boolean): boolean {
    const r = el.getBoundingClientRect();
    let scrolled = false;
    for (let n = el.parentElement; n && n !== this.container; n = n.parentElement) {
      const style = getComputedStyle(n);
      if (n === el.parentElement && n.classList.contains('catalog-rail-track')) {
        if (this.revealRailGutter(el, instant)) scrolled = true;
      }
      if (!isScroller(style.overflowY) || n.scrollHeight <= n.clientHeight) continue;
      const box = n.getBoundingClientRect();
      const margin = CONFIG.NAVIGATION.REVEAL_MARGIN;
      const top = box.top + n.clientTop + scrollInsetTop(n) + margin;
      // The scroller's own bottom edge: the inset only shortens it from the top.
      const bottom = box.top + n.clientTop + n.clientHeight - margin;
      let delta = 0;
      if (r.top < top) delta = r.top - top;
      else if (r.bottom > bottom) delta = Math.min(r.bottom - bottom, r.top - top);
      if (Math.abs(delta) < 1) continue;
      const target = n.scrollTop + delta;
      const scroller = n;
      if (instant) withInstantScroll([scroller], () => { scroller.scrollTop = target; });
      else scroller.scrollTop = target;
      scrolled = true;
    }
    return scrolled;
  }

  // Follows the element SpatialNav picked into the focus scope.
  protected place(el: HTMLElement | null, via: Via | null): void {
    this.pick(via, () => this.nav.focus(el));
  }

  private pick(via: Via | null, fn: () => void): void {
    const outer = this.pickVia;
    this.pickVia = via;
    try {
      fn();
    } finally {
      this.pickVia = outer;
    }
  }

  // How a render that settles focus on its own asks for it: in keys mode it
  // may bring it into view, otherwise it lights it where it is. Under a
  // surface that owns the keys it only follows the focus.
  private placementVia(): Via | null {
    if (Focus.owner() !== this.focusScope) return null;
    return InputMode.current === 'keys' ? 'key' : 'pointer';
  }

  // A focus request reaches the scope only while it owns the keys; otherwise
  // the scope just follows it, so no reveal waits for later.
  private request(key: string | null, via: Via | null): void {
    if (parseKey(key)?.mode === 'panel') this.panelReturnKey = key;
    // A pointer request never reveals, so it may wait for the keys.
    if (via === 'pointer' && Focus.owner() !== this.focusScope) {
      this.focusScope.focus(key, via);
      return;
    }
    if (via === null || Focus.owner() !== this.focusScope) {
      this.focusScope.track(key);
      return;
    }
    this.focusScope.focus(key, via);
    Focus.flush();
  }

  // Detail info lands, or a button changes: keep a key that is still there,
  // else start on the first button. A button that vanished only moves the
  // key, so a ring the pointer hid stays hidden.
  protected settleDetailFocus(): void {
    if (this.current()) return;
    this.pick(this.focusScope.focusKey === null ? this.placementVia() : null, () => {
      if (!this.nav.focusFirst()) this.nav.focus(null);
    });
  }

  // Back into the section from the tab bar: the focus Up left, in view.
  // Down from the top strip returns to the focus Up left; across from the
  // side rail, beside the panel, the keys land on the categories first.
  resumeFocus(fromTop = false): void {
    const panel = fromTop ? null : this.panelEntryKey();
    if (panel) {
      this.focusScope.focus(panel, 'resume');
      return;
    }
    this.focusScope.focus(this.focusScope.focusKey, 'resume');
  }

  // SpatialNav picks from where the scope's focus is, which a fallback may have moved.
  private syncNav(): void {
    const el = this.current();
    if (el && el !== this.nav.focused) this.place(el, null);
  }

  // After the pointer left, the first key only shows where focus is.
  private ringHidden(): boolean {
    const el = this.current();
    return !!el && Focus.owner() === this.focusScope && !FocusRing.deferred && !ringShown(el);
  }

  private leaveBrowse(): void {
    const el = this.current();
    if (!el || !this.layers.browse.contains(el)) {
      this.browseReturn = null;
      return;
    }
    const rail = el.closest<HTMLElement>('[data-rail-key]');
    const tiles = rail
      ? Array.from(rail.querySelectorAll<HTMLElement>('[data-focusable]'))
      : [];
    this.browseReturn = {
      el,
      railKey: rail?.dataset.railKey ?? '',
      index: Math.max(0, tiles.indexOf(el)),
    };
  }

  // Back lands on the tile browse was left from. A tile that is gone (e.g. a
  // title removed from the Watchlist) hands focus to its neighbor in the same
  // rail, and a rail that is gone falls back to the first tile.
  private restoreBrowseFocus(): void {
    const origin = this.browseReturn;
    this.browseReturn = null;
    const browse = this.layers.browse;
    const via = this.placementVia();
    // The panel's focus survives the switch; it is not browse's to move.
    if (this.panelFocused() && this.current()) return;
    if (origin && origin.el.isConnected && browse.contains(origin.el)) {
      this.place(origin.el, via);
      return;
    }
    // Rail keys embed provider category ids, so compare rather than build a selector.
    const rail = origin?.railKey
      ? Array.from(browse.querySelectorAll<HTMLElement>('[data-rail-key]'))
        .find((el) => el.dataset.railKey === origin.railKey) ?? null
      : null;
    const tiles = rail
      ? Array.from(rail.querySelectorAll<HTMLElement>('[data-focusable]'))
      : [];
    if (origin && tiles.length) {
      this.place(tiles[Math.min(origin.index, tiles.length - 1)], via);
      return;
    }
    // Otherwise the panel: the category whose grid just closed, or the first.
    const panel = this.panelEntryKey();
    if (panel) {
      this.request(panel, via);
      return;
    }
    this.place(browse.querySelector<HTMLElement>('.catalog-tile[data-focusable]') ?? this.nav.first(), via);
  }

  setAccount(account: PlaylistEntry): void {
    if (this.account?.id !== account.id) {
      this.clearPrompt.hide();
      this.dismissDropdown(null);
      this.requestController?.abort();
      this.onRequestSessionReset();
      this.nav.resetRecovery();
    }
    this.account = account;
  }

  protected get requestSignal(): AbortSignal | null {
    return this.requestController?.signal ?? null;
  }

  protected requestFailed(context: string, err: unknown, signal: AbortSignal): boolean {
    if (signal.aborted) return false;
    log.error(
      `${context} failed`,
      'event=xtream.view.load.failed',
      `operation=${context.toLowerCase().replace(/\s+/g, '_')}`,
      err,
    );
    return true;
  }

  private beginRequests(): AbortSignal {
    this.requestController?.abort();
    this.onRequestSessionReset();
    this.requestController = new AbortController();
    return this.requestController.signal;
  }

  refreshPlaybackState(): void {
    if (this.mode === 'detail') this.renderDetail();
    else if (this.mode === 'grid') this.renderGrid();
    else {
      this.leaveBrowse();
      this.renderBrowse();
    }
  }

  deactivate(): void {
    this.clearPrompt.hide();
    this.dismissDropdown(null);
    this.requestController?.abort();
    this.requestController = null;
    this.onRequestSessionReset();
  }

  async open(account: PlaylistEntry): Promise<void> {
    this.clearPrompt.hide();
    this.collection = null;
    this.managing = false;
    this.dismissDropdown(null);
    const signal = this.beginRequests();
    this.account = account;
    this.deepLinkBack = null;
    this.browseReturn = null;
    this.browseStale = false;
    this.clearLayer('grid');
    this.clearLayer('detail');
    this.categories = [];
    this.railGroups = [];
    this.itemsByCategory = {};
    this.serverItemsByCategory = {};
    this.sort = StorageService.getCatalogSort(this.parentalKind);
    this.browseSortReturn = null;
    this.resetBrowseRailOffsets = false;
    this.gridCategory = null;
    this.categoryVirtualizer.setScrollOffset(0);
    this.gridVirtualizer.setScrollOffset(0);
    this.resume = this.visibleResume(account.id);
    this.clearLayer('browse');
    this.renderLoading('browse');
    try {
      const categories = await this.loadCategories(account, signal);
      if (signal.aborted || this.account?.id !== account.id) return;
      this.categories = categories.filter(category => !ParentalControlService.isCategoryConcealed({
        kind: this.parentalKind === 'vod' ? 'vod-category' : 'series-category',
        accountId: account.id,
        categoryId: category.id,
      }));
      const railCats = this.categories.slice(0, CONFIG.XTREAM.RAIL_CATEGORIES);
      // Settle each rail on its own: one failing category must not blank the rest.
      const loaded = await Promise.all(
        railCats.map((c) => this.loadVisibleItems(account, c.id, signal).then(
          (items): I[] | null => items,
          (err: unknown): null => {
            if (!signal.aborted) {
              log.error(
                'Catalog rail load failed',
                'event=xtream.view.load.failed',
                'operation=rail',
                `mode=${this.parentalKind}`,
                err,
              );
            }
            return null;
          },
        )),
      );
      if (signal.aborted || this.account?.id !== account.id) return;
      const groups: { category: C; items: I[] }[] = [];
      railCats.forEach((category, i) => {
        const items = loaded[i];
        if (!items) return;
        this.setCategoryItems(category.id, items);
        groups.push({ category, items: this.itemsByCategory[category.id].slice(0, CONFIG.XTREAM.RAIL_ITEMS) });
      });
      this.railGroups = groups;
      if (groups.length < railCats.length) {
        log.warn(
          'Catalog rails partially loaded',
          'event=xtream.view.rails.partial',
          `mode=${this.parentalKind}`,
          `kept=${String(groups.length)}`,
          `total=${String(railCats.length)}`,
        );
      }
      this.renderBrowse();
    } catch (err) {
      if (signal.aborted) return;
      log.error(
        'Catalog browse load failed',
        'event=xtream.view.load.failed',
        'operation=browse',
        err,
      );
      if (this.account?.id === account.id) this.renderBrowse();
    }
  }

  // Deep-link entry (from Search): open this item's detail directly. Back returns
  // to the caller via onDetailBack (no browse is loaded underneath).
  async openItem(account: PlaylistEntry, item: I, onDetailBack: () => void): Promise<void> {
    this.beginRequests();
    // Showing this detail; deep-link Back recomputes whether browse is stale.
    this.browseStale = false;
    if (this.account && this.account.id !== account.id
        && this.layers.browse.querySelector('.catalog-view')) {
      this.gridCategory = null;
      this.collection = null;
      this.managing = false;
      this.browseReturn = null;
      this.clearLayer('grid');
      morph(this.layers.browse, this.loadingMarkup());
    }
    this.account = account;
    this.deepLinkBack = onDetailBack;
    await this.openDetail(item);
  }

  // A Search deep link opens over whatever this section last showed. Put that
  // back, so showing the section again never lands on an empty detail layer.
  // A detail the deep link replaced is not restored: Back skips to its grid or
  // browse.
  private restoreBeneathDeepLink(): void {
    if ((this.gridCategory || this.collection) && this.layers.grid.querySelector('.catalog-grid')) {
      this.renderGrid();
      return;
    }
    this.gridCategory = null;
    this.clearLayer('grid');
    if (this.layers.browse.querySelector('.catalog-browse')) {
      this.renderBrowse();
      return;
    }
    // The deep link aborted a browse load (or switched accounts). Reload it
    // only if the section is shown again (ensureLoaded), not behind Search.
    this.browseStale = !!this.layers.browse.querySelector('.catalog-loading');
    this.showLayer('browse');
    // Nothing to land on until browse loads; the detail's key is gone.
    if (parseKey(this.focusScope.focusKey)?.mode !== 'browse') this.focusScope.track(null);
  }

  // For re-showing the section without open(), e.g. when Search closes: reload
  // an interrupted browse, or one left on an account no longer active.
  ensureLoaded(account: PlaylistEntry | null): void {
    if (!account) return;
    if (!this.browseStale && this.account?.id === account.id) return;
    log.debug(
      'Catalog browse reloading',
      'event=xtream.view.reload',
      'operation=browse',
      `mode=${this.parentalKind}`,
      `reason=${this.browseStale ? 'stale' : 'account'}`,
    );
    void this.open(account);
  }

  invalidateAccount(id: string): void {
    if (this.account?.id === id) this.browseStale = true;
  }

  // Search is closing over this section: drop a deep-linked detail it left
  // here and show what it opened over.
  leaveDeepLink(): void {
    if (!this.deepLinkBack) return;
    this.beginRequests();
    this.deepLinkBack = null;
    this.clearDetail();
    this.restoreBeneathDeepLink();
    this.clearLayer('detail');
  }

  handleAction(action: Action): void {
    this.syncNav();
    if ((isFocusMove(action) || (action === 'select' && this.openDropdown())) && this.ringHidden()) {
      this.request(this.focusScope.focusKey, 'key');
      return;
    }
    this.pickVia = 'key';
    try {
      this.route(action);
    } finally {
      this.pickVia = null;
    }
  }

  private route(action: Action): void {
    const menu = this.openDropdown();
    if (menu) {
      if (action === 'back' || action === 'left') this.dismissDropdown('key');
      else if (action === 'select') this.onSelect();
      else if (action === 'up' || action === 'down') this.nav.move(action);
      return;
    }
    const current = this.current();
    const sortRow = current?.closest<HTMLElement>('.catalog-sort, .catalog-collection-actions');
    const horizontalRegion = sortRow ?? (this.mode === 'browse'
      ? current?.closest<HTMLElement>('.catalog-rail-track') : null);
    if (horizontalRegion && (action === 'left' || action === 'right')) {
      this.nav.setRestrict(horizontalRegion);
      const moved = this.nav.move(action);
      this.nav.setRestrict(this.layers[this.mode]);
      // Left past a row's first item enters the category panel.
      if (!moved && action === 'left') this.leaveContentLeft();
      return;
    }
    if (sortRow && action === 'down') {
      if (this.mode === 'grid') this.revealGridIndex(this.gridFocusIndex);
      const target = this.mode === 'grid'
        ? this.layers.grid.querySelector<HTMLElement>(
          `[data-grid-index="${this.gridFocusIndex}"] [data-focusable]`,
        )
        : (this.browseSortReturn ? this.resolveKey(this.browseSortReturn) : null)
          ?? this.layers.browse.querySelector<HTMLElement>(
            '[data-rail-key^="cat:"] .catalog-tile[data-focusable]',
          );
      if (target) {
        this.place(target, 'key');
        return;
      }
    }
    if (this.moveCategoryFocus(action)) return;
    if (this.moveExtraFocus(action)) return;
    if (this.mode === 'grid'
        && (action === 'up' || action === 'down' || action === 'left' || action === 'right')) {
      if (this.current()?.closest('.catalog-sort, .catalog-collection-actions')) {
        if (this.nav.move(action)) return;
        if (action === 'up') this.leaveForTabBar('up');
        else if (action === 'left') this.leaveContentLeft();
        return;
      }
      if (this.moveGridFocus(action)) return;
      if ((action === 'up' || action === 'left') && !this.nav.move(action)) {
        if (action === 'up') this.leaveForTabBar('up');
        else this.leaveContentLeft();
      }
      return;
    }
    switch (action) {
      case 'up': {
        const origin = this.focusScope.focusKey;
        const firstCategory = this.mode === 'browse' ? this.layers.browse.querySelector(
          '[data-rail-key^="cat:"]',
        ) : null;
        if (firstCategory && current?.closest('.catalog-rail') === firstCategory) {
          const trigger = this.layers.browse.querySelector<HTMLElement>('.catalog-sort .dropdown-trigger');
          if (trigger) {
            this.place(trigger, 'key');
            this.browseSortReturn = origin;
            return;
          }
        }
        if (!this.nav.move('up')) this.leaveForTabBar('up');
        else if (this.mode === 'browse' && !sortRow && this.current()?.closest('.catalog-sort')) {
          this.browseSortReturn = origin;
        }
        return;
      }
      case 'down':
      case 'left':
      case 'right':
        if (!this.nav.move(action) && action === 'left') this.leaveContentLeft();
        return;
      case 'select':
        this.onSelect();
        return;
      case 'back':
        this.onBack();
        return;
      default:
        return;
    }
  }

  private onBack(): void {
    if (this.mode === 'detail') {
      this.clearDetail();
      if (this.deepLinkBack) {
        const back = this.deepLinkBack;
        this.deepLinkBack = null;
        this.restoreBeneathDeepLink();
        this.clearLayer('detail');
        back();
        return;
      }
      this.gridCategory || this.collection ? this.renderGrid() : this.renderBrowse();
      this.clearLayer('detail');
      return;
    }
    if (this.mode === 'grid') {
      if (this.managing) {
        this.setManaging(false);
        return;
      }
      this.gridCategory = null;
      this.collection = null;
      this.renderBrowse();
      this.clearLayer('grid');
      return;
    }
    this.handlers.onBack();
  }

  private onSelect(): void {
    const el = this.current();
    if (!el || !this.account) return;
    const dd = el.closest<HTMLElement>('.dropdown');
    if (el.closest('.catalog-sort') || dd) {
      const direction = el.dataset.sortDirection;
      if (direction === 'asc' || direction === 'desc') {
        this.applySort({
          by: this.sort.by,
          direction,
        }, direction);
        return;
      }
      if (el.hasAttribute('data-dropdown-trigger') && dd) {
        if (this.openDropdown()) this.dismissDropdown(this.placementVia());
        else {
          this.nav.setRestrict(dd.querySelector<HTMLElement>('.dropdown-menu'));
          this.pick(this.placementVia(), () => toggleDropdown(this.container, this.nav, dd));
        }
      } else if (el.closest('.catalog-sort') && isCatalogSort(el.dataset.dropdownValue)) {
        const value = el.dataset.dropdownValue;
        commitDropdownOption(el);
        this.nav.setRestrict(this.layers[this.mode]);
        this.applySort(value === this.sort.by
          ? this.sort : { by: value, direction: defaultSortDirection(value) });
      } else if (dd && el.dataset.dropdownValue !== undefined) {
        // Another dropdown (a series' seasons): its view applies the choice.
        commitDropdownOption(el);
        this.nav.setRestrict(this.layers[this.mode]);
        this.place(dd.querySelector<HTMLElement>('.dropdown-trigger'), this.placementVia());
        this.selectExtra(el);
      }
      return;
    }
    if (this.selectCollection(el)) return;
    // Featured is the rails page: OK there opens it, or steps into it when shown.
    if (this.panel.contains(el) && el.dataset.key === FEATURED_PANEL_ENTRY) {
      if (this.mode === 'grid') this.closeGrid();
      else this.focusContent();
      return;
    }
    if (el.dataset.categoryId !== undefined
        && (el.classList.contains('catalog-cat') || el.classList.contains('catalog-see-all'))) {
      // OK on the category already open steps into its grid, as Right does.
      if (this.panel.contains(el) && this.mode === 'grid' && !this.collection
          && this.gridCategory?.id === el.dataset.categoryId && this.gridSource().count) {
        this.focusContent();
        return;
      }
      void this.openGrid(el.dataset.categoryId);
      return;
    }
    if (this.selectExtra(el)) return;
    if (el.dataset.itemId !== undefined) {
      const item = this.findItem(el.dataset.categoryId ?? '', el.dataset.itemId);
      if (item) void this.openDetail(item);
    }
  }

  // Open the section straight onto a collection's full grid (Home's See all).
  async openCollection(account: PlaylistEntry, kind: CollectionKind): Promise<void> {
    await this.open(account);
    if (this.account?.id === account.id) this.showCollection(kind, false);
  }

  private showCollection(kind: CollectionKind, managing: boolean): void {
    this.gridCategory = null;
    this.collection = kind;
    this.managing = managing;
    this.gridRequest++;
    this.clearLayer('grid');
    this.gridFocusIndex = 0;
    this.gridVirtualizer.setScrollOffset(0);
    this.renderGrid();
  }

  private selectCollection(el: HTMLElement): boolean {
    const manage = el.dataset.collectionManage;
    const seeAll = el.dataset.collectionSeeAll;
    const kind = manage ?? seeAll;
    if (kind === 'continue' || kind === 'watchlist') {
      this.showCollection(kind, manage !== undefined);
      return true;
    }
    const action = el.dataset.collectionAction;
    if (!this.collection || this.mode !== 'grid') return false;
    if (action === 'manage' || action === 'done') {
      this.setManaging(action === 'manage');
      return true;
    }
    if (action === 'clear') {
      this.confirmClear();
      return true;
    }
    const cell = el.closest<HTMLElement>('[data-grid-index]');
    if (this.managing && action === 'remove' && cell) {
      const index = Number(cell.dataset.gridIndex);
      const entries = this.collectionEntries(this.collection);
      const entry = entries[index];
      if (!entry) return true;
      this.removeCollectionEntry(this.collection, entry.id);
      if (entries.length === 1) {
        this.leaveCollection();
        return true;
      }
      this.gridFocusIndex = Math.min(index, entries.length - 2);
      this.renderGrid(false);
      this.revealGridIndex(this.gridFocusIndex);
      this.place(this.layers.grid.querySelector<HTMLElement>(
        `[data-grid-index="${this.gridFocusIndex}"] [data-focusable]`,
      ), this.placementVia());
      return true;
    }
    return false;
  }

  private removeCollectionEntry(kind: CollectionKind, id: string): void {
    const account = this.account;
    if (!account) return;
    if (kind === 'continue') {
      const entry = this.resume.find(item => item.itemId === id);
      const series = entry ? resumeSeriesId(entry) : null;
      if (series) StorageService.clearSeriesResume(account.id, series);
      else StorageService.clearResume(account.id, this.resumeKind, id);
      this.resume = this.visibleResume(account.id);
    } else {
      StorageService.removeWatchlist(account.id, this.parentalKind, id);
    }
  }

  private setManaging(managing: boolean): void {
    if (!this.collection) return;
    this.managing = managing;
    this.renderGrid(false);
    this.place(this.layers.grid.querySelector<HTMLElement>(managing
      ? `[data-grid-index="${this.gridFocusIndex}"] [data-focusable]`
      : '[data-collection-action="manage"]'), this.placementVia());
  }

  private leaveCollection(): void {
    this.collection = null;
    this.managing = false;
    this.renderBrowse();
    this.clearLayer('grid');
  }

  private confirmClear(): void {
    const kind = this.collection;
    const account = this.account;
    const returnKey = this.focusScope.focusKey;
    if (!kind || !account) return;
    this.clearPrompt.show({
      title: t(kind === 'continue' ? 'catalog.clearContinueWatchingTitle' : 'settings.clearWatchlistTitle'),
      message: t(kind === 'continue' ? 'catalog.clearContinueWatchingMessage' : 'catalog.clearWatchlistMessage', {
        account: account.name, section: this.kicker,
      }),
      confirmLabel: t('common.clearAll'),
      cancelLabel: t('common.cancel'),
      onConfirm: () => {
        if (this.account?.id !== account.id || this.collection !== kind) return;
        // Only the visible list is cleared; concealed titles stay untouched.
        this.collectionEntries(kind).forEach(entry => this.removeCollectionEntry(kind, entry.id));
        this.leaveCollection();
        showToast(t(kind === 'continue' ? 'catalog.continueWatchingCleared' : 'catalog.watchlistCleared'));
      },
      onCancel: () => {
        if (InputMode.current === 'keys') this.request(returnKey, 'back');
      },
    });
  }

  private collectionTitle(kind: CollectionKind): string {
    return t(kind === 'continue' ? 'catalog.continueWatching' : 'common.watchlist');
  }

  protected removeMark(managing: boolean, key: string): Safe | '' {
    return managing ? html`
      <button class="catalog-remove-mark" type="button" data-self-activate data-focusable data-key="${key}"
              data-collection-action="remove" aria-label="${t('common.remove')}">${raw(REMOVE_ICON)}</button>
    ` : '';
  }

  protected progressBar(position: number, duration: number): Safe | '' {
    return progressBar(position, duration);
  }

  // SpatialNav picked `el`: hand it to the scope.
  private onFocusChanged(el: HTMLElement | null): void {
    if (this.mode === 'browse' && !el?.closest('.catalog-sort')) this.browseSortReturn = null;
    this.request(el ? this.keyFor(el) : null, this.pickVia);
    const gridCell = el?.closest<HTMLElement>('[data-grid-index]');
    if (this.mode === 'grid' && gridCell?.dataset.gridIndex !== undefined) {
      this.gridFocusIndex = parseInt(gridCell.dataset.gridIndex, 10);
    }
  }

  // A tile flush with the rail's scrollport would clip its focus ring; keep a
  // gutter visible beside it. True when the rail scrolled.
  private revealRailGutter(el: HTMLElement, instant: boolean): boolean {
    const track = el.parentElement;
    if (!track || !track.classList.contains('catalog-rail-track')) return false;
    // Offsets run from the rail's reading start: its left edge, or its right
    // edge in a right-to-left language.
    const rtl = inlineStartSide() === 'right';
    const box = el.getBoundingClientRect();
    const portLeft = track.getBoundingClientRect().left + track.clientLeft;
    const current = inlineScrollStart(track);
    const start = (rtl ? portLeft + track.clientWidth - box.right : box.left - portLeft) + current;
    const end = start + el.offsetWidth;
    // A tile leaving at the start lines up with the rail's keyline, not the
    // screen edge the track bleeds to.
    const style = getComputedStyle(track);
    const lead = Math.max(RAIL_EDGE_GUTTER, parseFloat(rtl ? style.paddingRight : style.paddingLeft) || 0);
    let target: number;
    if (start - lead < current) target = Math.max(0, start - lead);
    else if (end + RAIL_EDGE_GUTTER > current + track.clientWidth) {
      target = end + RAIL_EDGE_GUTTER - track.clientWidth;
    } else return false;
    if (Math.abs(target - current) < 1) return false;
    // A tile already in view only needs an instant nudge; otherwise retarget
    // the running smooth scroll so it moves once.
    if (instant || (start >= current && end <= current + track.clientWidth)) {
      withInstantScroll([track], () => { setInlineScrollStart(track, target); });
    } else {
      setInlineScrollStart(track, target);
    }
    return true;
  }

  // Concealed titles are dropped at load, so every rail, grid, and hero built
  // from these lists stays free of them without per-render checks.
  private async loadVisibleItems(
    account: PlaylistEntry,
    categoryId: string,
    signal: AbortSignal,
  ): Promise<I[]> {
    const items = await this.loadItems(account, categoryId, signal);
    if (!ParentalControlService.concealing) return items;
    return items.filter(item => !ParentalControlService.isConcealed(
      catalogParentalRequest(this.parentalKind, {
        accountId: account.id,
        categoryId: this.itemCategoryId(item) || categoryId,
        name: this.itemName(item),
        id: this.itemId(item),
      }),
    ));
  }

  private setCategoryItems(categoryId: string, items: I[]): void {
    this.serverItemsByCategory[categoryId] = items;
    this.itemsByCategory[categoryId] = sortCatalogItems(
      items, this.sort.by, getLocale(), this.sort.direction,
    );
  }

  // The open menu of any dropdown on this layer: the sort, a series' seasons.
  private openDropdown(): HTMLElement | null {
    return this.layers[this.mode].querySelector<HTMLElement>('.dropdown.open');
  }

  private dismissDropdown(via: Via | null): void {
    const menu = this.openDropdown();
    if (!menu) return;
    this.nav.setRestrict(this.layers[this.mode]);
    this.pick(via, () => closeDropdown(this.nav, menu));
  }

  private applySort(sort: CatalogSortPreference, direction?: CatalogSortDirection): void {
    const changed = sort.by !== this.sort.by || sort.direction !== this.sort.direction;
    const applied = changed && StorageService.setCatalogSort(this.parentalKind, sort);
    if (applied) {
      this.sort = sort;
      this.browseSortReturn = null;
      Object.keys(this.serverItemsByCategory).forEach(id => {
        this.itemsByCategory[id] = sortCatalogItems(
          this.serverItemsByCategory[id], sort.by, getLocale(), sort.direction,
        );
      });
      this.railGroups = this.railGroups.map(group => ({
        category: group.category,
        items: this.itemsByCategory[group.category.id].slice(0, CONFIG.XTREAM.RAIL_ITEMS),
      }));
      this.gridFocusIndex = 0;
      this.gridVirtualizer.setScrollOffset(0);
      this.resetBrowseRailOffsets = true;
    }
    if (this.mode === 'grid') this.renderGrid(false);
    else this.renderBrowse(false);
    this.place(this.layer().querySelector<HTMLElement>(direction
      ? `[data-sort-direction="${direction}"]` : '.catalog-sort .dropdown-trigger'), this.placementVia());
  }

  // Series list one tile per show: its most recently watched episode.
  private visibleResume(accountId: string): ResumeEntry[] {
    return latestPerSeries(StorageService.getResumeList(accountId)
      .filter(entry => entry.kind === this.resumeKind && !isResumeConcealed(entry)));
  }

  protected visibleWatchlist(kind: WatchlistKind): WatchlistEntry[] {
    return StorageService.getWatchlist(this.account!.id, kind)
      .filter(entry => !isWatchlistConcealed(entry));
  }

  protected findItem(categoryId: string, id: string): I | null {
    const inCat = this.itemsByCategory[categoryId] ?? [];
    return inCat.find((x) => this.itemId(x) === id) ?? this.fallbackItem(id);
  }

  private async openGrid(categoryId: string): Promise<void> {
    if (!this.account) return;
    const account = this.account;
    const signal = this.requestSignal;
    if (!signal || signal.aborted) return;
    this.collection = null;
    this.managing = false;
    this.contentReturnKey = null;
    this.gridCategory = this.categories.find((c) => c.id === categoryId) ?? null;
    const request = ++this.gridRequest;
    this.gridFocusIndex = 0;
    this.gridVirtualizer.setScrollOffset(0);
    // A new category starts at the top of a fresh view; its title and sort
    // row show at once, with loading in place of the posters, so the grid
    // never blanks to a full-screen loading view and back.
    this.clearLayer('grid');
    if (!this.itemsByCategory[categoryId]) {
      this.gridLoadingId = categoryId;
      this.renderGrid();
      try {
        const items = await this.loadVisibleItems(
          account,
          categoryId,
          signal,
        );
        if (signal.aborted || this.account?.id !== account.id) return;
        this.setCategoryItems(categoryId, items);
      } catch (err) {
        if (signal.aborted) return;
        log.error(
          'Catalog category load failed',
          'event=xtream.view.load.failed',
          'operation=category',
          `mode=${this.parentalKind}`,
          err,
        );
      }
      if (signal.aborted || this.account?.id !== account.id) return;
      // Back (or another category) may have superseded this grid meanwhile.
      if (this.mode !== 'grid' || request !== this.gridRequest) {
        log.debug(
          'Catalog category load superseded',
          'event=xtream.view.load.superseded',
          'operation=category',
          `mode=${this.parentalKind}`,
          `reason=${this.mode !== 'grid' ? 'left' : 'replaced'}`,
        );
        return;
      }
    }
    this.gridLoadingId = null;
    this.renderGrid();
  }

  protected artKind(): ArtKind {
    return this.parentalKind === 'vod' ? 'movie' : 'series';
  }

  // The detail screen's poster box, with its placeholder.
  protected posterCell(poster: string, classes = ''): Safe {
    return html`<div class="detail-poster-wrap ${classes} ${artBoxClass(poster)}">${
      posterImage(this.artKind(), poster)}</div>`;
  }

  protected itemLockBadge(categoryId: string, id: string): Safe {
    return raw(lockBadge(ParentalControlService.lockState(
      catalogParentalRequest(this.parentalKind, {
        accountId: this.account?.id ?? '',
        categoryId,
        name: '',
        id,
      }),
    )));
  }

  // Lock badges follow the unlock session without changing what is listed.
  refreshLocks(): void {
    if (!this.layer().querySelector('.catalog-view')) return;
    if (this.mode === 'browse') this.renderBrowse(false);
    else if (this.mode === 'grid') this.renderGrid(false);
  }

  protected tile(item: I, overlay: Safe | '' = '', managing = false): Safe {
    const id = this.itemId(item);
    const cat = this.itemCategoryId(item);
    return posterCard({
      key: `i:${cat}:${id}`,
      name: this.itemName(item),
      poster: this.itemPoster(item),
      art: this.artKind(),
      lock: this.itemLockBadge(cat, id),
      overlay,
      focusable: !managing,
      attrs: html`data-item-id="${id}" data-category-id="${cat}"`,
    });
  }

  // A rail shows the first RAIL_ITEMS titles; a trailing tile opens the full grid.
  private categoryRail(group: { category: C; items: I[] }): Safe {
    const id = group.category.id;
    const total = this.itemsByCategory[id]?.length ?? group.items.length;
    const tiles = group.items.map((it) => this.tile(it));
    if (total > group.items.length) {
      tiles.push(posterSeeAllCard({
        key: `all:${id}`,
        count: this.itemCount(total),
        lock: categoryLockBadge(this.parentalKind, this.account!.id, id),
        attrs: html`data-category-id="${id}"`,
      }));
    }
    return this.rail(`cat:${id}`, group.category.name, tiles);
  }

  protected rail(key: string, title: string, items: Safe[]): Safe {
    return html`
      <div class="catalog-rail" data-key="rail:${key}" data-rail-key="${key}">
        <h2 class="catalog-rail-title">${title}</h2>
        <div class="catalog-rail-track" data-edge-scroll>${items}</div>
      </div>
    `;
  }

  private loadingMarkup(): Safe {
    return html`
      <div class="catalog-view catalog-loading" data-nav-container>
        <p class="catalog-hint">${t('common.loading')}</p>
      </div>
    `;
  }

  private renderLoading(mode: Mode): void {
    this.showLayer(mode);
    // Drop focus from the hidden layer so OK can't reselect it meanwhile;
    // the panel keeps its own.
    if (!this.panelFocused()) this.place(null, this.placementVia());
    morph(this.layers[mode], this.loadingMarkup());
  }

  private sortControls(): Safe {
    const by = this.sort.by;
    return html`
      <div class="catalog-sort" data-nav-container data-self-activate>
        <span class="catalog-sort-label">${t('catalog.sortBy')}</span>
        ${dropdown(`${this.scopeName()}-${this.mode}-sort`, [
          { value: 'default', label: t('catalog.sortDefault') },
          { value: 'name', label: t('settings.name') },
          { value: 'added', label: t('catalog.sortAdded') },
          { value: 'rating', label: t('catalog.sortRating') },
          { value: 'year', label: t('catalog.sortYear') },
        ], by)}
        ${by !== 'default' ? html`
          <div class="toggle-group" role="radiogroup"
               aria-label="${sortDirections(by).map(direction => sortDirectionLabel(by, direction)).join(' / ')}">
            ${sortDirections(by).map(direction => html`
              <button class="toggle-option catalog-sort-direction${direction === this.sort.direction ? ' active' : ''}"
                      type="button" role="radio" aria-checked="${direction === this.sort.direction}"
                      data-focusable data-key="sort-direction:${direction}" data-sort-direction="${direction}">
                <span class="catalog-sort-direction-icon">${raw(direction === 'asc'
                  ? SORT_ASCENDING_ICON : SORT_DESCENDING_ICON)}</span>
                <span>${sortDirectionLabel(by, direction)}</span>
              </button>
            `)}
          </div>
        ` : ''}
      </div>
    `;
  }

  protected renderBrowse(restoreFocus = true): void {
    this.dismissDropdown(null);
    this.showLayer('browse');
    const browse = this.layers.browse;
    this.resume = this.visibleResume(this.account!.id);
    // Continue Watching and the Watchlist live on Home; their full lists
    // still open here, from Home's See all.
    const hasContent = this.categories.length > 0;

    morph(browse, html`
      <div class="catalog-view catalog-browse" data-nav-container>
        ${!hasContent
          ? html`<p class="catalog-hint catalog-empty">${this.emptyMessage}</p>`
          : html`
            <div class="catalog-rails">
              <div class="catalog-rails-body">
                ${this.sortControls()}
                ${this.railGroups.map((r) => this.categoryRail(r))}
              </div>
            </div>
          `}
      </div>
    `);
    this.renderPanel();
    if (this.resetBrowseRailOffsets) {
      browse.querySelectorAll<HTMLElement>(
        '[data-rail-key^="cat:"] .catalog-rail-track',
      ).forEach(track => this.scrollGuard.syncOffset(track, 'horizontal', 0));
      this.resetBrowseRailOffsets = false;
    }
    if (restoreFocus) this.restoreBrowseFocus();
  }

  private collectionActions(width: number): Safe {
    return html`
      <div class="catalog-collection-actions" style="width:${width}px" data-nav-container data-self-activate>
        ${this.managing ? html`
          <button class="btn btn-primary catalog-collection-button" type="button" data-focusable
                  data-key="collection:done" data-collection-action="done">
            <span class="catalog-action-icon">${raw(CHECK_ICON)}</span>
            <span>${t('channel.editDone')}</span>
          </button>
          <button class="btn catalog-collection-button catalog-collection-clear" type="button" data-focusable
                  data-key="collection:clear" data-collection-action="clear">
            <span class="catalog-action-icon">${raw(TRASH_ICON)}</span>
            <span>${t('common.clearAll')}</span>
          </button>
        ` : html`
          <button class="btn catalog-collection-button catalog-collection-manage" type="button" data-focusable
                  data-key="collection:manage" data-collection-action="manage">
            <span class="catalog-action-icon">${raw(PENCIL_ICON)}</span>
            <span>${t('parental.manage')}</span>
          </button>
        `}
      </div>
    `;
  }

  // `followView`: the window follows a user scroll, whose offset stays as is;
  // above the first row the window's offset is 0 while the view's is not.
  protected renderGrid(restoreFocus = true, followView = false): void {
    this.dismissDropdown(null);
    this.showLayer('grid');
    const gridLayer = this.layers.grid;
    const cat = this.gridCategory;
    const kind = this.collection;
    if (kind && this.account) this.resume = this.visibleResume(this.account.id);
    const source = this.gridSource();
    const count = source.count;
    if (kind && count === 0) {
      this.leaveCollection();
      return;
    }
    if (restoreFocus) {
      const focused = parseKey(this.focusScope.focusKey);
      const key = this.gridReturnKey ?? (focused?.mode === 'grid' ? focused.key : null);
      if (kind && key) {
        const index = this.gridIndexOf(key);
        if (index >= 0) this.gridFocusIndex = index;
      }
      this.gridReturnKey = null;
    }
    this.gridFocusIndex = Math.max(0, Math.min(this.gridFocusIndex, count - 1));
    const previousView = gridLayer.querySelector<HTMLElement>('.catalog-grid');
    const previousTrack = gridLayer.querySelector<HTMLElement>('.catalog-grid-track');
    if (restoreFocus && previousView) {
      this.gridVirtualizer.setScrollOffset(
        Math.max(0, previousView.scrollTop - this.gridTrackStart(previousView, previousTrack)),
      );
    }
    const viewportWidth = previousTrack?.clientWidth || this.gridFallbackWidth();
    const viewportHeight = (previousView && visibleHeight(previousView)) || CATALOG_GRID_VIEWPORT_HEIGHT;
    if (restoreFocus && count) {
      this.gridVirtualizer.ensureVisible(this.gridFocusIndex, viewportWidth, viewportHeight);
    }
    const range = this.gridVirtualizer.getRange(count, viewportWidth, viewportHeight);
    const actionWidth = this.gridVirtualizer.getItemPosition(range.columns - 1, range.columns).left
      + CATALOG_GRID_POSTER_WIDTH;
    const cells: Safe[] = [];
    for (let index = range.start; index < range.end; index++) {
      const position = this.gridVirtualizer.getItemPosition(index, range.columns);
      cells.push(html`
        <div class="catalog-grid-cell" data-key="grid:${source.keyAt(index)}" data-grid-index="${index}"
             style="${inlineStartSide()}:${position.left}px;top:${position.top}px">${source.render(index)}</div>
      `);
    }
    const managing = !!kind && this.managing;
    morph(gridLayer, html`
      <div class="catalog-view catalog-grid${managing ? ' catalog-managing' : ''}" data-nav-container>
        <h1 class="catalog-grid-title">${kind ? html`
          ${this.collectionTitle(kind)} <span class="catalog-grid-count">${this.itemCount(count)}</span>
        ` : cat ? cat.name : this.kicker}</h1>
        ${kind ? this.collectionActions(actionWidth) : this.sortControls()}
        ${count === 0 && !kind && cat && this.gridLoadingId === cat.id
          ? html`<p class="catalog-hint">${t('common.loading')}</p>`
          : count === 0
          ? html`<p class="catalog-hint">${kind
            ? t(kind === 'continue' ? 'catalog.continueWatchingEmpty' : 'catalog.watchlistEmpty')
            : this.gridEmptyMessage}</p>`
          : html`
            <div class="catalog-grid-track"
                 style="height:${this.gridVirtualizer.getTotalSize(count, viewportWidth)}px">${cells}
            </div>
          `}
      </div>
      ${managing ? html`
        <div class="edit-hints catalog-manage-hints">
          ${okHint(t('common.remove'))}
          <span class="edit-hint">${backKey()}<span>${t('channel.editDone')}</span></span>
        </div>
      ` : ''}
    `);
    const view = gridLayer.querySelector<HTMLElement>('.catalog-grid');
    const track = gridLayer.querySelector<HTMLElement>('.catalog-grid-track');
    const viewOffset = this.gridVirtualizer.scrollOffset === 0
      ? 0
      : this.gridVirtualizer.scrollOffset + this.gridTrackStart(view, track);
    // A view already showing the window's offset keeps its own: above the
    // first row every position maps to 0, and an update in place must not
    // move it.
    if (view && !followView) {
      const shown = Math.max(0, view.scrollTop - this.gridTrackStart(view, track));
      this.scrollGuard.syncOffset(
        view,
        'vertical',
        !restoreFocus && shown === this.gridVirtualizer.scrollOffset ? view.scrollTop : viewOffset,
      );
    }
    if (restoreFocus && !(this.panelFocused() && this.current())) {
      const focused = gridLayer.querySelector<HTMLElement>(
        `[data-grid-index="${this.gridFocusIndex}"] [data-focusable]`,
      );
      // Nothing to land on until the posters load, so OK can't pick the sort row meanwhile.
      const loading = !!cat && !kind && this.gridLoadingId === cat.id;
      this.place(
        loading ? null : focused ?? gridLayer.querySelector<HTMLElement>('[data-focusable]'),
        this.placementVia(),
      );
    }
  }

  private moveGridFocus(direction: Action & ('up' | 'down' | 'left' | 'right')): boolean {
    const count = this.gridSource().count;
    if (!count) return false;
    const track = this.layers.grid.querySelector<HTMLElement>('.catalog-grid-track');
    const view = this.layers.grid.querySelector<HTMLElement>('.catalog-grid');
    const viewportWidth = track?.clientWidth || this.gridFallbackWidth();
    const next = this.gridVirtualizer.getAdjacentIndex(
      this.gridFocusIndex,
      direction,
      count,
      viewportWidth,
    );
    if (next === this.gridFocusIndex) return false;
    this.gridFocusIndex = next;
    const viewportHeight = (view && visibleHeight(view)) || CATALOG_GRID_VIEWPORT_HEIGHT;
    // Measured against the window's recorded offset, as revealGridIndex is,
    // which a smooth scroll still moves once the guard's frames pass.
    const scrolled = this.gridVirtualizer.ensureVisible(next, viewportWidth, viewportHeight);
    if (!scrolled && this.gridScrollFrame === null) {
      const cell = this.layers.grid.querySelector<HTMLElement>(
        `[data-grid-index="${next}"] [data-focusable]`,
      );
      // Same window and same offset: renderGrid() would morph byte-identical
      // markup, since tiles carry no focus state - the scope owns the class.
      // The channel list already moves focus this way (moveVirtualFocus).
      if (cell) {
        this.place(cell, 'key');
        return true;
      }
    }
    this.renderGrid(false);
    this.place(
      this.layers.grid.querySelector<HTMLElement>(`[data-grid-index="${next}"] [data-focusable]`),
      'key',
    );
    return true;
  }

  private gridFallbackWidth(): number {
    return this.panelShown() ? CATALOG_GRID_PANEL_VIEWPORT_WIDTH : CATALOG_GRID_VIEWPORT_WIDTH;
  }

  private categoryWindowFor(viewport: number): string {
    const count = this.panelCount();
    const range = this.categoryVirtualizer.getRange(count, viewport || CATEGORY_PANEL_VIEWPORT);
    return `${String(count)}:${String(range.start)}:${String(range.end)}`;
  }

  private categoryListHeight(list: HTMLElement | null): number {
    return list?.clientHeight || CATEGORY_PANEL_VIEWPORT;
  }

  // The panel steps one category at a time, so its virtual window can follow.
  // Right enters the content; Left, and Up past the first row, the tab bar.
  private moveCategoryFocus(action: Action): boolean {
    const parsed = parseKey(this.focusScope.focusKey);
    if (!parsed || parsed.mode !== 'panel') return false;
    if (action === 'right') {
      this.focusContent();
      return true;
    }
    if (action === 'left') {
      this.handlers.onRevealTabBar('left');
      return true;
    }
    if (action !== 'up' && action !== 'down') return false;
    const current = this.panelIndexOf(parsed.key);
    if (current < 0) return false;
    const next = current + (action === 'up' ? -1 : 1);
    if (next < 0) {
      this.handlers.onRevealTabBar('up');
      return true;
    }
    if (next >= this.panelCount()) return true;
    this.request(this.panelKeyAt(next), 'key');
    return true;
  }

  private gridTrackStart(
    view: HTMLElement | null,
    track: HTMLElement | null,
  ): number {
    if (!view || !track) return 0;
    return Math.max(
      0,
      track.getBoundingClientRect().top
        - view.getBoundingClientRect().top
        + view.scrollTop,
    );
  }
}
