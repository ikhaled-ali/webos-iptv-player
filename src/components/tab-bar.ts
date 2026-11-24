import type { Action, PlaylistEntry } from '../types';
import { html, raw } from '../utils/dom';
import { morph } from '../utils/morph';
import {
  APP_LOGO, MIC_ICON, SEARCH_ICON, SETTINGS_ICON, UNLOCK_ICON,
  RECORD_ICON, TAB_GUIDE_ICON, TAB_HOME_ICON, TAB_LIVE_ICON, TAB_MOVIES_ICON, TAB_SERIES_ICON,
} from './icons';
import { StatusClock } from './status-clock';
import { AccountSwitcher, type AccountMenuCloseReason } from './account-switcher';

// `outside` is narrowed to a click on focusable content, which takes input and
// releases the bar's focus; `bar` is a click on the bar outside the avatar
// slot, `blank` one on nothing focusable.
export type TabBarAccountMenuCloseReason = AccountMenuCloseReason | 'bar' | 'blank';
import { t } from '../i18n';
import { createLogger } from '../utils/logger';
import { Focus, Tier, type FocusScope } from '../navigation/focus-scope';

const log = createLogger('TabBar');

type SearchCollapseReason = 'back' | 'escape' | 'dismiss' | 'hidden' | 'section-change';

// The single source of truth for the sections: order, label, the view each maps
// to, and whether it needs an Xtream account.
export const SECTIONS = [
  { id: 'home', labelKey: 'nav.home', view: 'home', xtreamOnly: false },
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
  home: TAB_HOME_ICON,
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

// Persistent, docked left rail of section icons (hidden on the full-screen
// player). Content owns focus by default; D-pad Left off a view's left edge
// (or Up off its top) pushes the bar's `tabbar` scope onto the active
// section, Up/Down move along the rail, and Right/Select/Back pop it and hand
// the keys back into the content. The search box, mic, and Settings sit in a
// strip beside the logo, always shown; OK on the box puts the caret in it.
// The clock and weather float apart, top-right.
export class TabBar {
  private el: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private scrimEl: HTMLElement | null = null;
  private handlers: TabBarHandlers;
  private sections: readonly SectionDef[] = visibleSections(true, false);
  private hasXtream = true;
  private hasRecordings = false;
  private _shown = false;   // docked & visible on the current view
  private _focused = false; // holds input focus (ring + key capture)
  private active: Section = 'live';
  private focusIndex = 0;
  // Where on screen the item Left came from sat; the rail lands level with it.
  private entryY: number | null = null;
  // Up off a page lands on the top strip, and Down from the strip goes back.
  private entryTop = false;
  private fromTop = false;
  private searchExpanded = false;
  private expandGeneration = 0;
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
  // Focus targets in bar order: the search box, mic, and account avatar in
  // the top strip, the sections, then "Lock now" and Settings at the foot.
  private ring(): RingKey[] {
    const keys: RingKey[] = ['search', 'voice'];
    if (this.accountShown) keys.push('account-avatar');
    for (const s of this.sections) {
      if (s.id !== 'search' && s.id !== 'settings') keys.push(s.id);
    }
    if (this.lockShown) keys.push('lock-now');
    keys.push('settings');
    return keys;
  }
  private ringIndex(key: RingKey): number { return Math.max(0, this.ring().indexOf(key)); }
  // The rail target whose center is level with `y`; the upper one on a tie.
  private nearestIndex(y: number): number {
    let best = this.ringIndex(this.active);
    let bestDistance = Infinity;
    this.ring().forEach((key, index) => {
      const rect = this.el?.querySelector<HTMLElement>(`[data-key="${key}"]`)?.getBoundingClientRect();
      if (!rect || !rect.height) return;
      const distance = Math.abs(rect.top + rect.height / 2 - y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });
    return best;
  }

  private onLock(): boolean { return this.focusKey() === 'lock-now'; }
  private onAccount(): boolean { return this.focusKey() === 'account-avatar'; }
  private onVoice(): boolean { return this.focusKey() === 'voice'; }
  // The mic and the avatar follow the box on the strip's row.
  private onStrip(): boolean { return this.onVoice() || this.onAccount(); }
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
    this.statusEl?.classList.toggle('tab-bar--hidden', !v);
    this.scrimEl?.classList.toggle('tab-bar--hidden', !v);
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
    if (input) { input.value = ''; input.blur(); }
  }

  // Fill the expanded search box from outside (a recent search was picked).
  setSearchQuery(query: string): void {
    const input = this.el?.querySelector<HTMLInputElement>('.tab-bar-search-input');
    if (input) input.value = query;
  }

  // Where a dropdown hangs from the open search box: under it.
  searchAnchor(): { right: number; bottom: number; width: number } | null {
    const box = this.el?.querySelector<HTMLElement>('.tab-bar-search');
    if (!this.searchExpanded || !box) return null;
    const rect = box.getBoundingClientRect();
    return { right: rect.right, bottom: rect.bottom, width: rect.width };
  }

  // Left off a page: the next focus() lands on the rail icon nearest this
  // height, not the shown section.
  enterNear(y: number | null): void {
    this.entryY = y;
  }

  // Up off a page: the next focus() lands on the search box in the top strip.
  enterTop(top: boolean): void {
    this.entryTop = top;
  }

  // Whether the keys last came back down from the top strip, not across the rail.
  get returnedFromTop(): boolean { return this.fromTop; }

  // Move input focus onto the rail (D-pad Left or Up off a view's edge).
  focus(): void {
    if (!this._shown) return;
    this.setFocused(true);
    const y = this.entryY;
    const top = this.entryTop;
    this.entryY = null;
    this.entryTop = false;
    this.fromTop = top;
    this.focusIndex = top ? this.ringIndex('search')
      : y === null ? this.ringIndex(this.active) : this.nearestIndex(y);
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
        // The box is always shown: a click puts the caret in it.
        if (this.searchExpanded) {
          this.focusIndex = this.ringIndex('search');
          this.setFocused(true);
          this.render();
          this.el?.querySelector<HTMLInputElement>('.tab-bar-search-input')?.focus();
        } else {
          this.expandSearch('pointer');
        }
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
      if (action === 'back') { this.collapseSearch('back'); return; }
      if (action === 'right' || action === 'select') { this.leaveSearchInput(); return; }
      if (action !== 'up' && action !== 'down') {
        this.el?.querySelector<HTMLInputElement>('.tab-bar-search-input')?.focus();
        return;
      }
    }
    // The box, the mic, and the avatar share a row: Left and Right move along it.
    if (action === 'left' && this.onStrip()) {
      this.focusIndex = this.ringIndex(this.onVoice() ? 'search' : 'voice');
      this.afterMove();
      return;
    }
    if (action === 'right' && this.onVoice() && this.accountShown) {
      this.focusIndex = this.ringIndex('account-avatar');
      this.afterMove();
      return;
    }
    if (action === 'right' && !this.searchExpanded && this.focusKey() === 'search') {
      this.focusIndex = this.ringIndex('voice');
      this.afterMove();
      return;
    }
    // The strip's row ends at the avatar, or at the mic without one.
    if (action === 'right' && (this.onAccount() || (this.onVoice() && !this.accountShown))) return;
    // The strip over open results (the mic after a voice search): Down goes
    // into the results below, as from the box.
    if (this.searchExpanded && action === 'down' && this.onStrip()) {
      this.leaveSearchInput();
      return;
    }
    // Elsewhere on the rail over open results: Right goes into the results
    // and Back closes the search, as from the box.
    if (this.searchExpanded && (action === 'right' || action === 'back')) {
      if (action === 'back') this.collapseSearch('back');
      else this.leaveSearchInput();
      return;
    }
    // Down from the strip goes back into the page Up left.
    if (action === 'down' && this.fromTop && (this.focusKey() === 'search' || this.onStrip())) {
      this.enterActive();
      return;
    }
    switch (action) {
      case 'up':
      case 'down': {
        const next = this.stepRail(action === 'up' ? -1 : 1);
        // The rail stops at its ends.
        if (next < 0) break;
        this.fromTop = false;
        this.focusIndex = next;
        this.afterMove();
        break;
      }
      case 'select':
      case 'right':
        if (this.onLock()) {
          if (action === 'select') {
            this.handlers.onLockNow();
          } else {
            this.enterActive();
          }
        } else if (this.onAccount()) {
          this.switcher?.openMenu('key');
        } else if (this.onVoice()) {
          this.handlers.onVoiceSearch('key');
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
      case 'left':
        break; // leftmost: stay on the rail
      default:
        break;
    }
  }

  // Up/Down along the rail: the mic and avatar share the box's row, so the
  // rail steps over them (Right from the box reaches them) and moves from
  // them as from the box.
  // -1 past either end: the rail does not wrap.
  private stepRail(step: 1 | -1): number {
    const ring = this.ring();
    let index = this.onStrip() ? this.ringIndex('search') : this.focusIndex;
    do {
      index += step;
    } while (index >= 0 && index < ring.length
      && (ring[index] === 'voice' || ring[index] === 'account-avatar'));
    return index >= 0 && index < ring.length ? index : -1;
  }

  // Right and Back return to the shown section, wherever the rail's focus was.
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

  // Open search mode: put the caret in the always-shown box. The host keeps the current view; results only appear
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
    if (input) input.value = '';
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

  // The app can't listen itself: put the caret in the box under the mic hint,
  // so the remote's mic (or the keyboard's) types into it.
  listenWithRemote(): void {
    if (!this.searchExpanded) this.expandSearch('key', false);
    this.focusIndex = this.ringIndex('search');
    this.voiceState = 'hint';
    this.setFocused(true);
    this.render();
    this.el?.querySelector<HTMLInputElement>('.tab-bar-search-input')?.focus();
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

  // Run once the box has opened, after the host's synchronous prep; skipped
  // if the box closed meanwhile.
  afterSearchExpanded(callback: () => void): void {
    const generation = ++this.expandGeneration;
    window.setTimeout(() => {
      const current = generation === this.expandGeneration && this.searchExpanded;
      log.debug(
        'Search box opened',
        'event=search.box.expand.settled',
        `generation=${String(generation)}`,
        `reason=${current ? 'run' : 'stale'}`,
      );
      if (current) callback();
    }, 0);
  }

  private collapseSearch(reason: SearchCollapseReason): void {
    log.debug('Search box collapsed', 'event=search.box.collapsed', `reason=${reason}`);
    this.searchExpanded = false;
    this.voiceState = 'idle';
    const input = this.el?.querySelector<HTMLInputElement>('.tab-bar-search-input');
    if (input) { input.value = ''; input.blur(); }
    // The bar keeps the keys over the restored view, which Down resumes.
    this.setFocused(true);
    this.render();
    this.handlers.onSearchClose();
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
    // Status, not navigation: the time and weather float top-right over the
    // content, on a scrim that keeps them legible on any picture.
    // A theme-colored fade from the top edge behind the search strip and the
    // clock, over the content that scrolls under them.
    this.scrimEl = document.createElement('div');
    this.scrimEl.className = 'tab-bar-scrim';
    document.body.appendChild(this.scrimEl);
    this.statusEl = document.createElement('div');
    this.statusEl.className = 'tab-bar-status';
    document.body.appendChild(this.statusEl);
    new StatusClock(this.statusEl);
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
        <div class="tab-bar-item tab-bar-search ${this.searchExpanded ? 'expanded' : ''} ${this.active === 'search' ? 'active' : ''}"
             data-key="search" data-section="search" data-morph-preserve></div>
        <button class="tab-bar-item tab-bar-icon voice-search ${listening ? 'listening' : ''}"
                data-key="voice" data-voice-search aria-label="${t('search.voice')}">${raw(MIC_ICON)}${listening ? html`<span class="tab-bar-voice-tip" role="status">${t('search.listening')}</span>` : ''}</button>
        ${this.sections.filter((s) => s.id !== 'search' && s.id !== 'settings').map((s) => html`
          <button class="tab-bar-item tab-bar-icon tab-bar-tab ${s.id === this.active ? 'active' : ''}"
                  data-key="${s.id}" data-section="${s.id}" aria-label="${t(s.labelKey)}">${raw(TAB_ICONS[s.id] ?? '')}</button>
        `)}
        <span class="tab-bar-spacer" data-key="spacer"></span>
        ${this.lockShown ? html`
          <button class="tab-bar-item tab-bar-icon tab-bar-lock"
                  data-key="lock-now" data-lock-now aria-label="${t('parental.lockNow')}">${raw(UNLOCK_ICON)}</button>
        ` : ''}
        <button class="tab-bar-item tab-bar-icon tab-bar-settings ${this.active === 'settings' ? 'active' : ''}"
                data-key="settings" data-section="settings" aria-label="${t('nav.settings')}">${raw(SETTINGS_ICON)}</button>
        <div class="tab-bar-account" data-key="account-slot" data-morph-preserve></div>
      </div>
    `);
    this.mountSearch();
    this.mountAccount();
    this.statusEl?.classList.toggle('with-account', this.accountShown);
    if (voiceLost) this.handlers.onVoiceFocusLost();
    if (!this._focused) return;
    this.scope.focus(this.focusKey(), 'key');
    // The box's caret marks where the keys go.
    if (this.searchExpanded && this.focusKey() === 'search') this.scope.conceal();
  }

  // The search box's children are owned here (preserved from morph): build
  // the magnifier and input once, then keep the placeholder in sync.
  private mountSearch(): void {
    const wrap = this.el?.querySelector<HTMLElement>('.tab-bar-search');
    if (!wrap) return;
    if (!wrap.querySelector('.tab-bar-search-input')) {
      wrap.setAttribute('aria-label', t('common.search'));
      const glyph = document.createElement('span');
      glyph.className = 'tab-bar-search-glyph';
      glyph.setAttribute('aria-hidden', 'true');
      glyph.innerHTML = SEARCH_ICON; // trusted constant
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'tab-bar-search-input';
      input.setAttribute('aria-label', t('common.search'));
      wrap.appendChild(glyph);
      wrap.appendChild(input);
      if (!this.searchBound) { this.bindSearchInput(input); this.searchBound = true; }
    }
    const input = wrap.querySelector<HTMLInputElement>('.tab-bar-search-input')!;
    input.placeholder = this.voiceState === 'hint' ? t('search.voiceHint') : this.searchPlaceholder();
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
