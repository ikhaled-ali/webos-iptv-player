import type { Action, PlaylistEntry } from '../types';
import { html, raw, type Safe } from '../utils/dom';
import { morph } from '../utils/morph';
import { clockTime, onClockTick } from '../utils/clock';
import {
  APP_LOGO, MIC_ICON, SEARCH_ICON, SETTINGS_ICON, UNLOCK_ICON,
  RECORD_ICON, TAB_GUIDE_ICON, TAB_LIVE_ICON, TAB_MOVIES_ICON, TAB_SERIES_ICON, weatherIcon,
} from './icons';
import type { Weather } from '../services/weather-service';
import { AccountSwitcher, type AccountMenuCloseReason } from './account-switcher';

// `outside` is narrowed to a click on focusable content, which takes input and
// releases the bar's focus; `bar` is a click on the bar outside the avatar
// slot, `blank` one on nothing focusable.
export type TabBarAccountMenuCloseReason = AccountMenuCloseReason | 'bar' | 'blank';
import { t } from '../i18n';
import { createLogger } from '../utils/logger';
import { Focus, Tier, type FocusScope } from '../navigation/focus-scope';

// Cap for the expanded inline search box.
export const SEARCH_INPUT_MAX_WIDTH = 600;
// `.tab-bar-search.expanded .tab-bar-search-input` margin-right in tab-bar.css.
const SEARCH_INPUT_GAP = 14;
// A little past the box's 260 ms width transition, in case transitionend never fires.
const SEARCH_EXPAND_FALLBACK_MS = 320;

const log = createLogger('TabBar');

type SearchCollapseReason = 'toggle' | 'back' | 'escape' | 'dismiss' | 'hidden' | 'section-change';

// The single source of truth for the sections: order, label, the view each maps
// to, and whether it needs an Xtream account.
export const SECTIONS = [
  { id: 'live', labelKey: 'nav.live', view: 'channels', xtreamOnly: false },
  { id: 'series', labelKey: 'nav.series', view: 'series', xtreamOnly: true },
  { id: 'movies', labelKey: 'nav.movies', view: 'movies', xtreamOnly: true },
  { id: 'epg', labelKey: 'nav.epg', view: 'epg', xtreamOnly: false },
  { id: 'recordings', labelKey: 'nav.recordings', view: 'recordings', xtreamOnly: false },
  { id: 'search', labelKey: 'nav.search', view: 'search', xtreamOnly: false },
  { id: 'settings', labelKey: 'nav.settings', view: 'settings', xtreamOnly: false },
] as const;

export type Section = typeof SECTIONS[number]['id'];
type RingKey = Section | 'voice' | 'lock-now' | 'account-avatar';
export type VoiceSearchState = 'idle' | 'listening' | 'hint';
type SectionDef = typeof SECTIONS[number];

const TAB_ICONS: Partial<Record<Section, string>> = {
  live: TAB_LIVE_ICON,
  epg: TAB_GUIDE_ICON,
  movies: TAB_MOVIES_ICON,
  series: TAB_SERIES_ICON,
  recordings: RECORD_ICON,
};

// Xtream accounts get the full set; M3U-only accounts have no VOD/series catalog,
// so they see Live, Guide, Settings and Search only. Recordings shows only
// while there is at least one.
function visibleSections(hasXtream: boolean, hasRecordings: boolean): readonly SectionDef[] {
  return SECTIONS.filter((s) => (hasXtream || !s.xtreamOnly) && (hasRecordings || s.id !== 'recordings'));
}

// The section a view belongs to (null for the chromeless player / loading
// views, which own no tab).
export function sectionForView(view: string): Section | null {
  return SECTIONS.find((s) => s.view === view)?.id ?? null;
}

interface TabBarHandlers {
  // `pointer`: a click on the tab, which the pointer still rests on.
  onEnter: (section: Section, via: 'key' | 'pointer') => void;
  // The search query changed (typed / cleared); the host shows the results view
  // over the current one only while the query is non-empty.
  onSearchQuery: (query: string) => void;
  // Enter / Down in the search box: hand focus to the results or recent
  // searches below; false when there is nothing to take it.
  onSearchLeave: () => boolean;
  // The search box was closed (Back / Escape / toggle): restore the view the
  // search was opened from.
  onSearchClose: () => void;
  // The mic beside the magnifier was activated.
  onVoiceSearch: (via: 'key' | 'pointer') => void;
  // The mic lost focus while listening; its tooltip has closed.
  onVoiceFocusLost: () => void;
  // A different Xtream account was chosen in the avatar dropdown.
  onSelectAccount: (accountId: string) => void;
  // The avatar dropdown opened; overlays above the tab bar must give way.
  onAccountMenuOpen: () => void;
  // The avatar dropdown closed (picked, dismissed, or toggled).
  // `hit` is the element under a pointer click that closed it.
  onAccountMenuClose: (reason: TabBarAccountMenuCloseReason, hit?: Element) => void;
  // End a parental unlock session before it times out.
  onLockNow: () => void;
}

// Persistent, docked top section bar (hidden on the full-screen player / EPG).
// Content owns focus by default; D-pad Up off a view's top edge pushes the
// bar's `tabbar` scope onto the active tab, Left/Right switch section live,
// Down/Select/Back pop it and hand the keys back into the content. The
// Search tab expands an inline input instead of switching.
export class TabBar {
  private el: HTMLElement | null = null;
  private weather: Weather | null = null;
  private handlers: TabBarHandlers;
  private sections: readonly SectionDef[] = visibleSections(true, false);
  private hasXtream = true;
  private hasRecordings = false;
  private _shown = false;   // docked & visible on the current view
  private _focused = false; // holds input focus (ring + key capture)
  private active: Section = 'live';
  private focusIndex = 0;
  private searchExpanded = false;
  private expandGeneration = 0;
  private expandStartedAt = 0;
  private searchBound = false;
  private voiceState: VoiceSearchState = 'idle';
  private switcher: AccountSwitcher | null = null;
  private accounts: PlaylistEntry[] = [];
  private selectedAccountId = '';
  private lockShown = false;
  private readonly scope: FocusScope;

  constructor(handlers: TabBarHandlers) {
    this.handlers = handlers;
    this.scope = Focus.register({
      id: 'tabbar',
      root: () => this.el,
      restrict: 'self-first',
      tier: Tier.bar,
      when: () => this._shown,
      defaultKey: () => this.focusKey(),
      enterTo: 'default',
      onEnter: () => this.focus(),
      onAction: (action) => this.handleAction(action),
    });
  }

  get focused(): boolean { return this._focused; }
  get shown(): boolean { return this._shown; }
  // True while the inline search box is expanded (it overlays other views but
  // keeps Search active, so the host shouldn't re-sync the active tab then).
  get searchOpen(): boolean { return this.searchExpanded; }
  get accountMenuOpen(): boolean { return !!this.switcher?.menuOpen; }
  get micFocused(): boolean { return this._focused && this.onVoice(); }
  get activeSection(): Section { return this.active; }

  refresh(): void { this.render(); }

  private get accountShown(): boolean { return this.accounts.length > 0; }
  // Focus targets in bar order: the sections with voice search after Search,
  // then "Lock now" and the account avatar when present.
  private ring(): RingKey[] {
    const keys: RingKey[] = [];
    for (const s of this.sections) {
      keys.push(s.id);
      if (s.id === 'search') keys.push('voice');
    }
    if (this.lockShown) keys.push('lock-now');
    if (this.accountShown) keys.push('account-avatar');
    return keys;
  }
  private ringLength(): number { return this.ring().length; }
  private ringIndex(key: RingKey): number { return Math.max(0, this.ring().indexOf(key)); }
  private onLock(): boolean { return this.focusKey() === 'lock-now'; }
  private onAccount(): boolean { return this.focusKey() === 'account-avatar'; }
  private onVoice(): boolean { return this.focusKey() === 'voice'; }
  private focusKey(): RingKey {
    return this.ring()[this.focusIndex] ?? this.active;
  }
  // Keep the focused target across a ring change, or fall back to the active tab.
  private keepFocusKey(key: RingKey): void {
    const index = this.ring().indexOf(key);
    this.focusIndex = index >= 0 ? index : this.ringIndex(this.active);
  }

  // The bar owns the keys exactly while its scope is on the stack.
  private setFocused(focused: boolean): void {
    if (focused === this._focused) return;
    this._focused = focused;
    if (focused) Focus.push(this.scope);
    else Focus.pop(this.scope);
  }

  // Shown while a parental PIN entry keeps locked content open.
  setParentalSession(active: boolean): void {
    if (this.lockShown === active) return;
    const key = this.focusKey();
    this.lockShown = active;
    this.keepFocusKey(key);
    if (this._shown) this.render();
  }

  setRecordings(hasRecordings: boolean): void {
    if (this.hasRecordings === hasRecordings) return;
    this.hasRecordings = hasRecordings;
    this.setSections(this.hasXtream);
  }

  setSections(hasXtream: boolean): void {
    this.hasXtream = hasXtream;
    this.sections = visibleSections(hasXtream, this.hasRecordings);
    if (!this.sections.some((s) => s.id === this.active)) this.active = 'live';
    this.focusIndex = this.ringIndex(this.active);
    if (this._shown) this.render();
  }

  setAccounts(accounts: PlaylistEntry[], selectedId: string): void {
    // If the avatar just disappeared while focused on it, park focus on the active tab.
    const key = this.focusKey();
    this.accounts = accounts;
    this.selectedAccountId = selectedId;
    this.keepFocusKey(key);
    this.switcher?.setAccounts(accounts, selectedId);
    if (this._shown) this.render();
  }

  setShown(v: boolean): void {
    this._shown = v;
    if (!v) {
      this.setFocused(false);
      // Search first: closing the menu must not reopen recent searches.
      if (this.searchExpanded) this.dropSearch('hidden');
      this.switcher?.closeMenu();
    }
    document.body.classList.toggle('tabbar-docked', v);
    if (v) { this.ensureEl(); this.render(); }
    this.el?.classList.toggle('tab-bar--hidden', !v);
  }

  setActive(section: Section): void {
    if (section !== 'search' && this.searchExpanded) this.dropSearch('section-change');
    this.active = section;
    this.focusIndex = this.ringIndex(section);
    if (this._shown) this.render();
  }

  // Collapse the inline box's DOM back to width 0 when search is left via a route
  // other than collapseSearch() (switching section, hiding the bar), so the next
  // expand animates from 0 again instead of popping open.
  private dropSearch(reason: SearchCollapseReason): void {
    log.debug('Search box collapsed', 'event=search.box.collapsed', `reason=${reason}`);
    this.searchExpanded = false;
    this.voiceState = 'idle';
    this.resetSearchInput();
  }

  private resetSearchInput(): void {
    const input = this.el?.querySelector<HTMLInputElement>('.tab-bar-search-input');
    if (input) { input.style.width = ''; input.value = ''; input.blur(); }
  }

  // Fill the expanded search box from outside (a recent search was picked).
  setSearchQuery(query: string): void {
    const input = this.el?.querySelector<HTMLInputElement>('.tab-bar-search-input');
    if (input) input.value = query;
  }

  // Where a dropdown hangs from the expanded search box: under the input and
  // magnifier together. Read from the target width, since the box may still
  // be sliding open.
  searchAnchor(): { right: number; bottom: number; width: number } | null {
    const input = this.el?.querySelector<HTMLInputElement>('.tab-bar-search-input');
    const icon = this.el?.querySelector<HTMLElement>('.tab-bar-search .search-icon');
    if (!this.searchExpanded || !input || !icon) return null;
    const iconRect = icon.getBoundingClientRect();
    const inputWidth = parseFloat(input.style.width) || input.getBoundingClientRect().width;
    // The input may still be sliding open, so derive its settled edges from
    // the icon it ends beside and its target width.
    return {
      right: iconRect.left - SEARCH_INPUT_GAP,
      bottom: input.getBoundingClientRect().bottom,
      width: inputWidth,
    };
  }

  // Move input focus onto the bar (D-pad Up from a view's top row).
  focus(): void {
    if (!this._shown) return;
    this.setFocused(true);
    this.focusIndex = this.ringIndex(this.active);
    this.render();
    if (this.active === 'search' && this.searchExpanded) {
      this.el?.querySelector<HTMLInputElement>('.tab-bar-search-input')?.focus();
    }
  }

  private dropFocus(): void {
    this.setFocused(false);
    this.render();
  }

  // Give up input focus from outside (e.g. the host navigated into content via
  // the pointer, which doesn't route through the bar). Without this, a stale
  // `_focused` makes handleKey route later input into the bar and swallow it.
  blur(): void {
    this.el?.querySelector<HTMLInputElement>('.tab-bar-search-input')?.blur();
    if (this._focused) this.dropFocus();
  }

  init(): void {
    // Enter a tab (or expand search) by hit-testing the item under the pointer.
    document.addEventListener('click', (e: MouseEvent) => {
      if (!this._shown) return;
      const hit = document.elementFromPoint(e.clientX, e.clientY);
      if (hit?.closest('[data-lock-now]')) {
        this.dropFocus();
        this.handlers.onLockNow();
        // The click took focus from the open box; give the remote back to it.
        if (this.searchExpanded) this.focus();
        return;
      }
      if (hit?.closest('[data-voice-search]')) {
        // The mic keeps the keys, so OK listens again and its tooltip stays.
        this.el?.querySelector<HTMLInputElement>('.tab-bar-search-input')?.blur();
        this.focusIndex = this.ringIndex('voice');
        this.setFocused(true);
        this.render();
        this.handlers.onVoiceSearch('pointer');
        return;
      }
      const item = hit?.closest<HTMLElement>('.tab-bar-item');
      if (!item || !item.dataset.section) return;
      const section = item.dataset.section as Section;
      if (section === 'search') {
        // Toggle: a second click on the magnifier slides the box back in.
        if (this.searchExpanded) this.collapseSearch('toggle');
        else this.expandSearch('pointer');
        return;
      }
      this.active = section;
      this.focusIndex = this.ringIndex(section);
      this.dropFocus();
      this.handlers.onEnter(section, 'pointer');
    });
    // The pointer on the scope below or on the shown view hands the keys
    // below; left with the bar, the next key would switch section from under
    // it. The open search box keeps them, so typing is not cut off, and so
    // does anything above the bar. KeyHandler sends no hover for content
    // moving under a resting pointer.
    document.addEventListener('nav:hover', (e: Event) => {
      if (this.hoverReleasesTo(e)) this.releaseOnHover();
    });
    // Edge scrolling a rail below works the content as a hover would, even
    // from a gutter that has nothing to hover.
    document.addEventListener('nav:edge-scroll', (e: Event) => {
      if (this.hoverReleasesTo(e)) this.releaseOnHover();
    });
    // A self-only scope below, such as the Guide's open group menu, still
    // takes the keys, but a hover outside it stays out of the content, as
    // that scope's own hover gate would keep it. The capture phase runs
    // this before the content's listeners (and, registered first,
    // FocusRing's hover mark). The open account menu keeps the keys over
    // that scope too, and is not modal itself, so it keeps the same gate.
    document.addEventListener('nav:hover', (e: Event) => {
      if (this.blocksHoverUnderMenu(e)) {
        e.stopImmediatePropagation();
        return;
      }
      const under = this.hoverReleasesTo(e);
      if (!under?.modal || under.root()?.contains(e.target as Node)) return;
      e.stopImmediatePropagation();
      this.releaseOnHover();
    }, true);
  }

  // The scope a hover on `e.target` hands the bar's keys to, if any.
  private hoverReleasesTo(e: Event): FocusScope | null {
    if (!this._focused || this.searchExpanded || Focus.owner() !== this.scope) return null;
    const target = e.target;
    if (!(target instanceof Node) || this.el?.contains(target)) return null;
    const under = Focus.ownerWithout(this.scope);
    if (!under?.root()?.contains(target) && !Focus.base()?.root()?.contains(target)) return null;
    return under;
  }

  private blocksHoverUnderMenu(e: Event): boolean {
    const menu = this.switcher?.menuScope;
    if (!menu || Focus.owner() !== menu) return false;
    const target = e.target;
    if (!(target instanceof Node) || this.el?.contains(target)) return false;
    const under = Focus.ownerWithout(menu, this.scope);
    return !!under?.modal && !under.root()?.contains(target);
  }

  private releaseOnHover(): void {
    log.debug('Tab bar released', 'event=tab_bar.blur', 'reason=hover');
    this.blur();
  }

  handleAction(action: Action): void {
    if (!this._focused) return;
    if (this.searchExpanded && this.focusKey() === 'search') {
      // Reached only when the input lost DOM focus (e.g. to a pointer click),
      // since the global handler leaves keys typed into it alone.
      if (action === 'back') this.collapseSearch('back');
      else if (action === 'down' || action === 'select') this.leaveSearchInput();
      else this.el?.querySelector<HTMLInputElement>('.tab-bar-search-input')?.focus();
      return;
    }
    // Elsewhere on the bar over open results (the mic after a voice search):
    // Down goes into the results and Back closes the search, as from the box.
    if (this.searchExpanded && (action === 'down' || action === 'back')) {
      if (action === 'back') this.collapseSearch('back');
      else this.leaveSearchInput();
      return;
    }
    switch (action) {
      case 'left':
        this.focusIndex = (this.focusIndex - 1 + this.ringLength()) % this.ringLength();
        this.afterMove();
        break;
      case 'right':
        this.focusIndex = (this.focusIndex + 1) % this.ringLength();
        this.afterMove();
        break;
      case 'select':
      case 'down':
        if (this.onLock()) {
          if (action === 'select') {
            this.handlers.onLockNow();
          } else {
            this.enterActive();
          }
        } else if (this.onAccount()) {
          this.switcher?.openMenu('key');
        } else if (this.onVoice()) {
          if (action === 'select') this.handlers.onVoiceSearch('key');
          else this.enterActive();
        } else if (this.focusKey() === 'search') {
          if (action === 'select') this.expandSearch('key');
          else this.enterActive();
        } else if (action === 'select') {
          // OK opens the focused section; moving along the bar never does.
          this.active = this.focusKey() as Section;
          this.enterActive();
        } else {
          this.enterActive();
        }
        break;
      case 'back':
        this.enterActive();
        break;
      case 'up':
        break; // topmost — stay on the bar
      default:
        break;
    }
  }

  // Down and Back return to the shown section, wherever the bar's focus was.
  private enterActive(): void {
    this.focusIndex = this.ringIndex(this.active);
    this.dropFocus();
    this.handlers.onEnter(this.active, 'key');
  }

  // Moving along the bar only moves the focus; OK opens the section. Back
  // onto the open box puts the caret in it.
  private afterMove(): void {
    this.render();
    if (this.searchExpanded && this.focusKey() === 'search') {
      this.el?.querySelector<HTMLInputElement>('.tab-bar-search-input')?.focus();
    }
  }

  // Expand the inline search box: slide it out from the magnifier toward
  // Settings and focus it. The host keeps the current view; results only appear
  // (over it) once a query is typed.
  private expandSearch(mode: 'key' | 'pointer', focusInput = true): void {
    log.debug('Search box expanded', 'event=search.box.expanded', `mode=${mode}`);
    this.active = 'search';
    this.focusIndex = this.ringIndex('search');
    this.searchExpanded = true;
    this.voiceState = 'idle';
    this.setFocused(true);
    this.render();
    const input = this.el?.querySelector<HTMLInputElement>('.tab-bar-search-input');
    if (input) {
      input.value = '';
      this.setSearchWidth(input);
    }
    this.expandStartedAt = Date.now();
    // After sizing the box, so the host can hang recent searches from it.
    this.handlers.onEnter('search', mode); // host remembers the current view + preps results
    if (focusInput) input?.focus();
  }

  // Open the search box for a query from outside (a launch param, voice).
  openSearch(): void {
    if (!this.searchExpanded) this.expandSearch('key');
  }

  // Listening shows a tooltip under the focused mic; a hint in the box says how
  // to speak when the app can't listen itself.
  setVoiceState(state: VoiceSearchState): void {
    if (state === this.voiceState) return;
    this.voiceState = state;
    this.render();
  }

  // Open the search box without its caret, leaving the keys on the mic.
  openSearchOnMic(): void {
    if (!this.searchExpanded) this.expandSearch('key', false);
    this.el?.querySelector<HTMLInputElement>('.tab-bar-search-input')?.blur();
    this.focusIndex = this.ringIndex('voice');
    this.setFocused(true);
    this.render();
  }

  // Show what was said in the box over its results, with the keys left on the
  // mic so OK can listen again.
  showVoiceQuery(query: string): void {
    this.openSearchOnMic();
    this.setSearchQuery(query);
  }

  closeSearch(): void {
    if (this.searchExpanded) this.collapseSearch('dismiss');
  }

  // Run once the box has finished sliding open, so nothing else competes with
  // the slide for frames; skipped if the box closed meanwhile.
  afterSearchExpanded(callback: () => void): void {
    const input = this.el?.querySelector<HTMLInputElement>('.tab-bar-search-input');
    const generation = ++this.expandGeneration;
    // Timed from the width change, so synchronous prep before this call counts.
    const startedAt = this.expandStartedAt || Date.now();
    const delayMs = Date.now() - startedAt;
    let done = false;
    const finish = (source: 'transitionend' | 'timeout'): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      input?.removeEventListener('transitionend', onEnd);
      const current = generation === this.expandGeneration && this.searchExpanded;
      log.debug(
        'Search box slide settled',
        'event=search.box.expand.settled',
        `source=${source}`,
        `elapsedMs=${String(Date.now() - startedAt)}`,
        `delayMs=${String(delayMs)}`,
        `timeoutMs=${String(SEARCH_EXPAND_FALLBACK_MS)}`,
        `generation=${String(generation)}`,
        `reason=${current ? 'run' : 'stale'}`,
      );
      if (current) callback();
    };
    const onEnd = (e: TransitionEvent): void => {
      if (e.propertyName === 'width') finish('transitionend');
    };
    input?.addEventListener('transitionend', onEnd);
    const timer = window.setTimeout(() => finish('timeout'), Math.max(0, SEARCH_EXPAND_FALLBACK_MS - delayMs));
  }

  private collapseSearch(reason: SearchCollapseReason): void {
    log.debug('Search box collapsed', 'event=search.box.collapsed', `reason=${reason}`);
    this.searchExpanded = false;
    this.voiceState = 'idle';
    const input = this.el?.querySelector<HTMLInputElement>('.tab-bar-search-input');
    if (input) { input.value = ''; input.style.width = ''; input.blur(); }
    // The bar keeps the keys over the restored view, which Down resumes.
    this.setFocused(true);
    this.render();
    this.handlers.onSearchClose();
  }

  // Slide the input out from the magnifier toward the last text tab.
  private setSearchWidth(input: HTMLInputElement): void {
    const icon = this.el?.querySelector<HTMLElement>('.tab-bar-search .search-icon');
    const tabs = this.el?.querySelectorAll<HTMLElement>('.tab-bar-inner > .tab-bar-item:not(.tab-bar-icon)[data-section]');
    const lastTab = tabs && tabs.length ? tabs[tabs.length - 1] : null;
    if (!icon) return;
    const iconLeft = icon.getBoundingClientRect().left;
    const tabsRight = lastTab ? lastTab.getBoundingClientRect().right : (this.el!.getBoundingClientRect().left + 96);
    const gap = Math.max(160, Math.round(iconLeft - tabsRight - 24));
    input.style.width = `${Math.min(SEARCH_INPUT_MAX_WIDTH, gap)}px`;
  }

  private searchPlaceholder(): string {
    return this.hasXtream
      ? t('search.all')
      : t('search.channels');
  }

  private ensureEl(): void {
    if (this.el) return;
    this.el = document.createElement('div');
    this.el.className = 'tab-bar';
    // Self-activates on click (its own handler is the "OK" action); mark so the
    // global click handler skips this subtree (covers the account switcher slot).
    this.el.setAttribute('data-self-activate', '');
    document.body.appendChild(this.el);
    onClockTick(time => this.setClock(time));
  }

  setWeather(weather: Weather): void {
    this.weather = weather;
    const slot = this.el?.querySelector<HTMLElement>('.tab-bar-weather');
    if (slot) morph(slot, this.weatherContent());
  }

  private weatherContent(): Safe {
    const w = this.weather;
    if (!w) return html``;
    return html`<span class="tab-bar-weather-icon">${raw(weatherIcon(w.condition, w.isDay))}</span><span class="tab-bar-weather-temp">${String(w.temperature)}°</span>`;
  }

  // Only the clock's text changes each minute; the bar itself stays put.
  private setClock(time: string): void {
    const clock = this.el?.querySelector<HTMLElement>('.tab-bar-clock');
    if (!clock) return;
    clock.setAttribute('datetime', time);
    morph(clock, html`${time}`);
  }

  private render(): void {
    if (!this.el) return;
    // The tooltip lives only while the mic has the keys.
    const voiceLost = this.voiceState === 'listening' && !(this._shown && this._focused && this.onVoice());
    if (voiceLost) this.voiceState = 'idle';
    const listening = this.voiceState === 'listening';
    morph(this.el, html`
      <div class="tab-bar-inner" data-nav-container>
        <span class="tab-bar-brand">${raw(APP_LOGO)}</span>
        ${this.sections.filter((s) => s.id !== 'search' && s.id !== 'settings').map((s) => {
          const activeCls = s.id === this.active ? 'active' : '';
          return html`
          <button class="tab-bar-item tab-bar-tab ${activeCls}"
                  data-key="${s.id}" data-section="${s.id}" aria-label="${t(s.labelKey)}"><span class="tab-bar-tab-icon">${raw(TAB_ICONS[s.id] ?? '')}</span><span class="tab-bar-tab-label">${t(s.labelKey)}</span></button>
        `;
        })}
        <div class="tab-bar-search ${this.searchExpanded ? 'expanded' : ''}" data-key="search-slot" data-morph-preserve></div>
        <button class="tab-bar-item tab-bar-icon voice-search ${listening ? 'listening' : ''}"
                data-key="voice" data-voice-search aria-label="${t('search.voice')}">${raw(MIC_ICON)}${listening ? html`<span class="tab-bar-voice-tip" role="status">${t('search.listening')}</span>` : ''}</button>
        <button class="tab-bar-item tab-bar-icon ${this.active === 'settings' ? 'active' : ''}"
                data-key="settings" data-section="settings" aria-label="${t('nav.settings')}">${raw(SETTINGS_ICON)}</button>
        ${this.lockShown ? html`
          <button class="tab-bar-item tab-bar-lock"
                  data-key="lock-now" data-lock-now>${raw(UNLOCK_ICON)}<span>${t('parental.lockNow')}</span></button>
        ` : ''}
        <time class="tab-bar-clock" data-key="clock" datetime="${clockTime()}">${clockTime()}</time>
        <span class="tab-bar-weather" data-key="weather">${this.weatherContent()}</span>
        <div class="tab-bar-account" data-key="account-slot" data-morph-preserve></div>
      </div>
    `);
    this.mountSearch();
    this.mountAccount();
    if (voiceLost) this.handlers.onVoiceFocusLost();
    if (!this._focused) return;
    this.scope.focus(this.focusKey(), 'key');
    // The box's caret marks where the keys go.
    if (this.searchExpanded && this.focusKey() === 'search') this.scope.conceal();
  }

  // The search slot's children are owned here (preserved from morph): build the
  // input + magnifier once, then keep the placeholder and icon state in sync.
  private mountSearch(): void {
    const wrap = this.el?.querySelector<HTMLElement>('.tab-bar-search');
    if (!wrap) return;
    if (!wrap.querySelector('.search-icon')) {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'tab-bar-search-input';
      input.setAttribute('aria-label', t('common.search'));
      const btn = document.createElement('button');
      btn.className = 'tab-bar-item tab-bar-icon search-icon';
      btn.dataset.key = 'search';
      btn.dataset.section = 'search';
      btn.setAttribute('aria-label', t('common.search'));
      btn.innerHTML = SEARCH_ICON; // trusted constant
      wrap.appendChild(input);
      wrap.appendChild(btn);
      if (!this.searchBound) { this.bindSearchInput(input); this.searchBound = true; }
    }
    const input = wrap.querySelector<HTMLInputElement>('.tab-bar-search-input')!;
    input.placeholder = this.voiceState === 'hint' ? t('search.voiceHint') : this.searchPlaceholder();
    const btn = wrap.querySelector<HTMLElement>('.search-icon')!;
    btn.classList.toggle('active', this.active === 'search');
  }

  // Release DOM focus so d-pad/OK reach what is below; stay in the box when
  // nothing there can take focus.
  private leaveSearchInput(): void {
    this.setFocused(false);
    this.el?.querySelector<HTMLInputElement>('.tab-bar-search-input')?.blur();
    if (!this.handlers.onSearchLeave()) this.focus();
  }

  private bindSearchInput(input: HTMLInputElement): void {
    input.addEventListener('input', () => {
      if (this.voiceState === 'hint') this.voiceState = 'idle';
      this.handlers.onSearchQuery(input.value);
    });
    // The global key handler ignores INPUT keydowns, so the box owns Enter/Down
    // (blur + hand off to the results) and Escape (collapse + clear).
    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === 'ArrowDown') {
        e.preventDefault();
        this.leaveSearchInput();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.collapseSearch('escape');
      }
    });
  }

  // The account slot's DOM is owned by the AccountSwitcher (preserved across
  // morph). Create it once, then keep its accounts in sync. The open menu is
  // a scope above the bar that keeps the keys but not the hover below it;
  // closing it hands the keys back below.
  private mountAccount(): void {
    const slot = this.el?.querySelector<HTMLElement>('.tab-bar-account');
    if (!slot) return;
    if (!this.switcher) {
      this.switcher = new AccountSwitcher(slot, {
        onSelect: (id) => this.handlers.onSelectAccount(id),
        onMenuOpen: (mode) => {
          log.debug('Account menu opened', 'event=account.menu.opened', `mode=${mode}`);
          // A pointer click opens the menu without routing through the bar:
          // its keys come back to the avatar when the menu closes.
          if (!this._focused || !this.onAccount()) {
            this.el?.querySelector<HTMLInputElement>('.tab-bar-search-input')?.blur();
            this.focusIndex = this.ringIndex('account-avatar');
            this.setFocused(true);
            this.render();
          }
          this.handlers.onAccountMenuOpen();
        },
        onMenuClose: (reason, hit) => {
          // A click on focusable content moves the user there, so the bar lets
          // the keys go with it; any other click leaves them on the avatar.
          let effective: TabBarAccountMenuCloseReason = reason;
          if (reason === 'outside') {
            if (hit && this.el?.contains(hit)) effective = 'bar';
            else if (!hit || !hit.closest('[data-focusable]')) effective = 'blank';
          }
          log.debug('Account menu closed', 'event=account.menu.closed', `reason=${effective}`);
          if (effective === 'outside' && this._focused) this.dropFocus();
          this.handlers.onAccountMenuClose(effective, hit);
        },
      }, 'tabbar.accounts');
      this.switcher.init();
    }
    this.switcher.setAccounts(this.accounts, this.selectedAccountId);
  }
}
