import type { Action } from '../types';
import type { SpatialNav } from '../navigation/spatial-nav';
import { html, raw, type Safe } from '../utils/dom';
import { t, tp, type TextMessageKey } from '../i18n';
import { CONFIG } from '../config';
import { VirtualList } from '../utils/virtual-list';
import { foldSearchText } from '../utils/channel-search';
import { StorageService } from '../services/storage-service';
import { BroadcastCache } from '../services/broadcast-cache';
import { BroadcastService, type LoadFailure } from '../services/broadcast-service';
import type { BroadcastChannel, BroadcastKind } from '../services/broadcast-normalize';
import { applyOrder, dropFromOrder, kindCount, moveInOrder } from '../services/broadcast-order';
import { SatelliteScan } from '../services/satellite-scan';
import type { ConfirmationPrompt } from './confirmation-prompt';
import { toggleGroup } from './toggle-controls';
import { backKey, keyHint, okHint } from './key-hints';
import { KEY_ICON, LOCK_ICON, SEARCH_ICON } from './icons';
import { showToast } from './toast';

// A row's height plus the gap below it (css/satellite-tools.css).
export const ROW_STRIDE = 88;
const OVERSCAN = 6;
const VIEWPORT_FALLBACK = 620;
// The moved channel stays marked in the new order this long.
const MOVED_MARK_MS = 1600;

type Side = 'left' | 'right';
type Sort = 'default' | 'az' | 'za';

const FAILURE_TEXT: Record<LoadFailure, TextMessageKey> = {
  unsupported: 'satellite.unsupportedBody',
  'no-root': 'satellite.noRootBody',
  'no-channels': 'satellite.noChannelsBody',
  'no-satellite': 'satellite.noSatelliteBody',
  failed: 'satellite.failedBody',
};

export interface ChannelManagerHost {
  readonly nav: SpatialNav;
  ui(): HTMLElement;
  render(): void;
  focusKey(key: string): void;
  readonly prompt: ConfirmationPrompt;
  // The saved order changed: the Satellite section renumbers.
  onOrderChanged(): void;
  // A channel left the TV's list.
  onChannelsChanged(): void;
}

// A channel's place in a list of channels of one kind, filtered and sorted.
export function filterChannels(
  channels: readonly BroadcastChannel[],
  kind: BroadcastKind,
  query: string,
  sort: Sort,
): BroadcastChannel[] {
  const needle = foldSearchText(query.trim());
  const list = channels.filter(channel => channel.kind === kind
    && (!needle || foldSearchText(channel.name).indexOf(needle) !== -1));
  if (sort === 'default') return list;
  const sign = sort === 'az' ? 1 : -1;
  return list.sort((a, b) => sign * a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
}

/**
 * The Satellite tools' channel manager: the TV's order on the left (with a
 * name filter and sort), the section's own order on the right. OK on either
 * list, or a typed digit, asks for a new number; the channel moves there in
 * the new order, which is saved at once. Red deletes the channel from the
 * TV. Channel names come from the broadcast, through `html`.
 */
export class SatelliteChannelManager {
  private phase: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
  private failure: LoadFailure = 'failed';
  private sample = false;
  // The TV's channels in the TV's own order.
  private tvList: BroadcastChannel[] = [];
  private order: string[] = [];
  private kind: BroadcastKind = 'tv';
  private query = '';
  private sort: Sort = 'default';
  private left: BroadcastChannel[] = [];
  private right: BroadcastChannel[] = [];
  private readonly index: Record<Side, number> = { left: 0, right: 0 };
  private side: Side = 'left';
  private entry: { key: string; side: Side; text: string } | null = null;
  private moved: string | null = null;
  private movedTimer: ReturnType<typeof setTimeout> | null = null;
  private deleting: string | null = null;
  private token = 0;
  private scrollFrame = 0;
  private readonly virtual: Record<Side, VirtualList> = {
    left: new VirtualList({ itemSize: ROW_STRIDE, overscan: OVERSCAN, fallbackViewportSize: VIEWPORT_FALLBACK }),
    right: new VirtualList({ itemSize: ROW_STRIDE, overscan: OVERSCAN, fallbackViewportSize: VIEWPORT_FALLBACK }),
  };

  constructor(private readonly host: ChannelManagerHost) {}

  get entryOpen(): boolean {
    return this.entry !== null;
  }

  // --- Lifecycle -----------------------------------------------------------

  async open(): Promise<void> {
    const token = ++this.token;
    this.entry = null;
    this.query = '';
    this.sort = 'default';
    this.index.left = 0;
    this.index.right = 0;
    this.side = 'left';
    this.virtual.left.setScrollOffset(0);
    this.virtual.right.setScrollOffset(0);
    this.phase = 'loading';
    await BroadcastCache.load();
    if (token !== this.token) return;
    // The cached lineup shows at once while the TV is asked again.
    const cached = BroadcastService.activeRoute === 'sample' ? null : BroadcastCache.channels();
    const shown = !!cached && cached.length > 0;
    if (cached && shown) {
      this.adopt(cached, false);
      this.host.render();
      this.focusFirst();
    }
    const load = await BroadcastService.loadChannels();
    if (token !== this.token) return;
    if (load.ok) {
      if (load.route !== 'sample') BroadcastCache.saveChannels(load.channels);
      this.adopt(load.channels, load.route === 'sample');
      this.host.render();
      if (shown) this.restoreFocus();
      else this.focusFirst();
      return;
    }
    if (shown) return;
    this.phase = 'failed';
    this.failure = load.reason;
    this.host.render();
    this.focusFirst();
  }

  close(): void {
    this.token++;
    this.entry = null;
    if (this.movedTimer) clearTimeout(this.movedTimer);
    this.movedTimer = null;
    this.moved = null;
    this.blurField();
  }

  private adopt(list: BroadcastChannel[], sample: boolean): void {
    this.sample = sample;
    this.tvList = list.slice();
    const lineup = applyOrder(this.tvList, StorageService.getSatelliteOrder());
    if (lineup.changed) StorageService.setSatelliteOrder(lineup.order);
    this.order = lineup.order;
    if (!kindCount(this.tvList, this.kind)) this.kind = this.kind === 'tv' ? 'radio' : 'tv';
    this.phase = 'ready';
    this.rebuild();
  }

  private rebuild(): void {
    this.left = filterChannels(this.tvList, this.kind, this.query, this.sort);
    this.right = applyOrder(this.tvList, this.order).channels.filter(channel => channel.kind === this.kind);
    this.index.left = Math.max(0, Math.min(this.index.left, this.left.length - 1));
    this.index.right = Math.max(0, Math.min(this.index.right, this.right.length - 1));
  }

  // --- Focus ---------------------------------------------------------------

  private rowKey(side: Side, channel: BroadcastChannel): string {
    return `cm-${side === 'left' ? 'l' : 'r'}:${channel.serviceKey}`;
  }

  private list(side: Side): BroadcastChannel[] {
    return side === 'left' ? this.left : this.right;
  }

  // The channel Red and the number entry act on: the focused row's.
  private get selected(): { side: Side; channel: BroadcastChannel } | null {
    const channel = this.list(this.side)[this.index[this.side]];
    return channel ? { side: this.side, channel } : null;
  }

  // Ready: the original order's selected row, where looking for a channel
  // starts; otherwise the notice's first button.
  private focusFirst(): void {
    if (this.phase === 'ready' && this.left.length) {
      this.focusRow('left');
      return;
    }
    const el = this.host.ui().querySelector<HTMLElement>('.sat-cm [data-focusable], .sat-cm-notice [data-focusable]');
    if (el) this.host.nav.focus(el);
  }

  private focusRow(side: Side): void {
    const channel = this.list(side)[this.index[side]];
    if (channel) this.host.focusKey(this.rowKey(side, channel));
  }

  private restoreFocus(): void {
    const focused = this.host.nav.focused;
    if (focused && this.host.ui().contains(focused)) return;
    this.focusRow(this.side);
  }

  // Where the nav landed; a row also becomes the selection.
  trackFocus(el: HTMLElement | null): void {
    const side = el?.dataset.cmSide as Side | undefined;
    if (!el || !side) return;
    const at = this.list(side).findIndex(channel => channel.serviceKey === el.dataset.cmService);
    if (at < 0) return;
    this.side = side;
    this.index[side] = at;
  }

  // Digits typed on a row start the new number.
  digitSinkFor(el: HTMLElement | null): ((digit: number) => void) | null {
    if (!el || (!el.dataset.cmSide && !el.hasAttribute('data-cm-entry'))) return null;
    return (digit) => this.typeDigit(digit);
  }

  private reveal(side: Side): void {
    const scroller = this.scroller(side);
    const viewport = scroller?.clientHeight || VIEWPORT_FALLBACK;
    const virtual = this.virtual[side];
    if (scroller) virtual.setScrollOffset(scroller.scrollTop);
    if (virtual.ensureVisible(this.index[side], viewport, ROW_STRIDE) && scroller) {
      scroller.scrollTop = virtual.scrollOffset;
    }
  }

  private scroller(side: Side): HTMLElement | null {
    return this.host.ui().querySelector<HTMLElement>(`[data-cm-scroller="${side}"]`);
  }

  // A wheel or drag scroll renders the rows it brings into view.
  onScroll(target: HTMLElement): void {
    const side = target.dataset.cmScroller as Side | undefined;
    if (!side || this.scrollFrame) return;
    this.scrollFrame = requestAnimationFrame(() => {
      this.scrollFrame = 0;
      this.virtual[side].setScrollOffset(target.scrollTop);
      this.host.render();
    });
  }

  // --- Keys ----------------------------------------------------------------

  // True when the manager used the action; otherwise the tools screen
  // moves focus or goes back.
  handleAction(action: Action, focused: HTMLElement | null): boolean {
    if (this.phase !== 'ready') return false;
    if (this.entry) {
      if (action === 'select') this.commitEntry();
      else if (action === 'back') this.cancelEntry();
      return true;
    }
    if (action === 'red') {
      this.confirmDelete();
      return true;
    }
    const side = focused?.dataset.cmSide as Side | undefined;
    if (!side) return false;
    const page = Math.max(1, Math.floor((this.scroller(side)?.clientHeight || VIEWPORT_FALLBACK) / ROW_STRIDE) - 1);
    switch (action) {
      case 'up': return this.step(side, -1);
      case 'down': return this.step(side, 1);
      case 'channel_up': return this.step(side, -page) || true;
      case 'channel_down': return this.step(side, page) || true;
      default: return false;
    }
  }

  // Up from a list's first row leaves it for the toolbar.
  private step(side: Side, delta: number): boolean {
    const list = this.list(side);
    const next = Math.max(0, Math.min(list.length - 1, this.index[side] + delta));
    if (next === this.index[side]) return delta > 0;
    this.index[side] = next;
    this.side = side;
    this.reveal(side);
    this.host.render();
    this.focusRow(side);
    return true;
  }

  // True when the element was the manager's.
  activate(el: HTMLElement): boolean {
    const side = el.dataset.cmSide as Side | undefined;
    if (side) {
      this.trackFocus(el);
      this.openEntry('');
      return true;
    }
    if (el.hasAttribute('data-cm-entry')) {
      if (this.entry && this.entry.text) this.commitEntry();
      else (el as HTMLInputElement).focus();
      return true;
    }
    if (el.dataset.cmFilter !== undefined) {
      (el as HTMLInputElement).focus();
      return true;
    }
    const group = el.closest<HTMLElement>('.toggle-group');
    if (group && el.dataset.value !== undefined && group.id.indexOf('sat-cm-') === 0) {
      this.pick(group.id, el.dataset.value);
      return true;
    }
    switch (el.dataset.cmAction) {
      case 'clear': this.setQuery('', true); return true;
      case 'delete': this.confirmDelete(); return true;
      case 'retry':
      case 'sample':
        if (el.dataset.cmAction === 'sample') BroadcastService.useSample();
        void this.open();
        this.host.render();
        return true;
      default: return false;
    }
  }

  private pick(groupId: string, value: string): void {
    if (groupId === 'sat-cm-kind') {
      const kind: BroadcastKind = value === 'radio' ? 'radio' : 'tv';
      if (kind === this.kind) return;
      this.kind = kind;
      this.index.left = 0;
      this.index.right = 0;
      this.virtual.left.setScrollOffset(0);
      this.virtual.right.setScrollOffset(0);
    } else if (groupId === 'sat-cm-sort') {
      const sort: Sort = value === 'az' || value === 'za' ? value : 'default';
      if (sort === this.sort) return;
      this.sort = sort;
      this.index.left = 0;
      this.virtual.left.setScrollOffset(0);
    }
    this.rebuild();
    this.host.render();
    this.host.focusKey(`${groupId}:${value}`);
  }

  // --- Filter --------------------------------------------------------------

  onInput(input: HTMLInputElement): void {
    if (input.dataset.cmFilter !== undefined) this.setQuery(input.value, false);
    else if (input.hasAttribute('data-cm-entry') && this.entry) {
      this.entry.text = input.value.replace(/\D/g, '').slice(0, this.maxDigits());
      if (input.value !== this.entry.text) input.value = this.entry.text;
    }
  }

  private setQuery(query: string, refocus: boolean): void {
    this.query = query;
    this.index.left = 0;
    this.virtual.left.setScrollOffset(0);
    const scroller = this.scroller('left');
    if (scroller) scroller.scrollTop = 0;
    this.rebuild();
    this.host.render();
    if (refocus) this.host.focusKey('sat-cm-filter');
  }

  // The fields own their keys while typing: Enter and the arrows leave
  // them, Back leaves the filter as typed and cancels a number.
  onFieldKey(event: KeyboardEvent): boolean {
    const input = event.target as HTMLInputElement;
    const isEntry = input.hasAttribute('data-cm-entry');
    if (!isEntry && input.dataset.cmFilter === undefined) return false;
    const back = event.key === 'Escape' || event.keyCode === CONFIG.KEYS.BACK;
    const enter = event.key === 'Enter' || event.keyCode === CONFIG.KEYS.ENTER;
    const up = event.key === 'ArrowUp' || event.keyCode === CONFIG.KEYS.UP;
    const down = event.key === 'ArrowDown' || event.keyCode === CONFIG.KEYS.DOWN;
    if (!back && !enter && !up && !down) return false;
    event.preventDefault();
    event.stopPropagation();
    input.blur();
    if (isEntry) {
      if (back) this.cancelEntry();
      else if (enter) this.commitEntry();
      return true;
    }
    this.host.focusKey('sat-cm-filter');
    if (enter || down) this.focusRow('left');
    else if (up) this.host.nav.move('up');
    return true;
  }

  private blurField(): void {
    const active = document.activeElement;
    if (active instanceof HTMLInputElement && this.host.ui().contains(active)) active.blur();
  }

  // --- Moving --------------------------------------------------------------

  private maxDigits(): number {
    return String(Math.max(1, this.right.length)).length;
  }

  private openEntry(text: string): void {
    const selected = this.selected;
    if (!selected || this.deleting) return;
    this.entry = { key: selected.channel.serviceKey, side: selected.side, text };
    this.host.render();
    this.host.focusKey('sat-cm-entry');
  }

  private typeDigit(digit: number): void {
    if (!this.entry) {
      this.openEntry(String(digit));
      return;
    }
    if (this.entry.text.length >= this.maxDigits()) return;
    this.entry.text += String(digit);
    this.host.render();
  }

  private cancelEntry(): void {
    const entry = this.entry;
    this.entry = null;
    this.blurField();
    this.host.render();
    if (entry) this.focusRow(entry.side);
  }

  private commitEntry(): void {
    const entry = this.entry;
    if (!entry) return;
    const value = parseInt(entry.text, 10);
    if (!isFinite(value) || value < 1) {
      this.cancelEntry();
      return;
    }
    this.entry = null;
    this.blurField();
    this.order = moveInOrder(this.tvList, this.order, entry.key, value);
    StorageService.setSatelliteOrder(this.order);
    this.rebuild();
    this.markMoved(entry.key);
    // The moved channel shows in the new order; a moved row of the new
    // order keeps the focus on its way.
    const at = this.right.findIndex(channel => channel.serviceKey === entry.key);
    if (at >= 0) this.index.right = at;
    this.reveal('right');
    this.host.render();
    this.focusRow(entry.side);
    this.host.onOrderChanged();
  }

  private markMoved(key: string): void {
    this.moved = key;
    if (this.movedTimer) clearTimeout(this.movedTimer);
    this.movedTimer = setTimeout(() => {
      this.movedTimer = null;
      this.moved = null;
      this.host.render();
    }, MOVED_MARK_MS);
  }

  // --- Deleting ------------------------------------------------------------

  private confirmDelete(): void {
    const selected = this.selected;
    if (!selected || this.deleting || this.entry) return;
    const { side, channel } = selected;
    this.host.prompt.show({
      title: t('satelliteTools.deleteChannelTitle', { name: channel.name }),
      message: t('satelliteTools.deleteChannelsBody'),
      confirmLabel: t('common.delete'),
      cancelLabel: t('common.cancel'),
      onConfirm: () => { void this.delete(side, channel); },
      onCancel: () => this.focusRow(side),
    });
  }

  private async delete(side: Side, channel: BroadcastChannel): Promise<void> {
    const token = this.token;
    this.deleting = channel.serviceKey;
    this.host.render();
    this.focusRow(side);
    const ok = this.sample
      ? BroadcastService.removeSample([channel.id])
      : await SatelliteScan.deleteChannels([channel.id]);
    if (ok) {
      this.order = dropFromOrder(this.order, [channel.serviceKey]);
      StorageService.setSatelliteOrder(this.order);
    }
    const load = await BroadcastService.loadChannels();
    if (load.ok && load.route !== 'sample') BroadcastCache.saveChannels(load.channels);
    this.deleting = null;
    if (ok) this.host.onChannelsChanged();
    if (token !== this.token) return;
    if (load.ok) {
      this.tvList = load.channels.slice();
      this.rebuild();
    }
    if (!ok) showToast(t('satelliteTools.deleteChannelFailed'));
    this.host.render();
    if (this.list(side).length) this.focusRow(side);
    else this.focusFirst();
  }

  // --- Rendering -----------------------------------------------------------

  render(): Safe {
    if (this.phase === 'idle' || this.phase === 'loading') {
      return html`<p class="sat-tools-empty">${t('common.loading')}</p>`;
    }
    if (this.phase === 'failed') {
      const sample = this.failure !== 'no-channels' && this.failure !== 'no-satellite';
      return html`
        <p class="sat-tools-empty">${t(FAILURE_TEXT[this.failure])}</p>
        <div class="settings-item settings-item--action sat-cm-notice">
          <button class="btn btn-primary" data-focusable data-key="sat-cm-retry" data-cm-action="retry">${
            t('common.retry')}</button>
          ${sample ? html`<button class="btn" data-focusable data-key="sat-cm-sample" data-cm-action="sample">${
            t('satellite.exploreSample')}</button>` : ''}
        </div>`;
    }
    const hasRadio = kindCount(this.tvList, 'radio') > 0 && kindCount(this.tvList, 'tv') > 0;
    return html`
      <div class="sat-cm" data-key="sat-cm">
        <div class="sat-cm-toolbar" data-nav-container>
          ${hasRadio ? toggleGroup('sat-cm-kind', [
            { value: 'tv', label: t('satellite.tv') },
            { value: 'radio', label: t('satellite.radio') },
          ], this.kind) : ''}
          <label class="sat-cm-filter">
            <span class="sat-cm-filter-icon">${raw(SEARCH_ICON)}</span>
            <input class="sat-cm-filter-input" type="text" data-focusable data-key="sat-cm-filter" data-cm-filter
                   value="${this.query}" placeholder="${t('satelliteTools.filterByName')}" autocomplete="off">
          </label>
          ${this.query ? html`<button class="btn btn-secondary sat-cm-clear" data-focusable data-key="sat-cm-clear"
                                      data-cm-action="clear">${t('common.clear')}</button>` : ''}
          ${toggleGroup('sat-cm-sort', [
            { value: 'default', label: t('catalog.sortDefault') },
            { value: 'az', label: t('catalog.sortAToZ') },
            { value: 'za', label: t('catalog.sortZToA') },
          ], this.sort)}
        </div>
        <div class="sat-cm-columns">
          ${this.renderColumn('left', t('satelliteTools.originalOrder'))}
          ${this.renderColumn('right', t('satelliteTools.newOrder'))}
        </div>
      </div>
      ${this.renderHints()}`;
  }

  private renderColumn(side: Side, title: string): Safe {
    const list = this.list(side);
    const scroller = this.scroller(side);
    const virtual = this.virtual[side];
    if (scroller) virtual.setScrollOffset(scroller.scrollTop);
    const range = virtual.getRange(list.length, scroller?.clientHeight || VIEWPORT_FALLBACK);
    const rows: Safe[] = [];
    for (let i = range.start; i < range.end; i++) rows.push(this.renderRow(side, list[i], i));
    return html`
      <section class="sat-cm-column" data-nav-container data-nav-enter="last-focused" data-key="sat-cm-col-${side}">
        <div class="sat-list-heading sat-cm-heading">
          <span class="sat-list-title">${title}</span>
          <span class="sat-list-count">${tp('channel.count', list.length)}</span>
        </div>
        <div class="sat-cm-list" data-cm-scroller="${side}" data-key="sat-cm-list-${side}">
          ${list.length
            ? html`<div class="channel-list-spacer" data-key="sat-cm-spacer-${side}"
                        style="height:${virtual.getTotalSize(list.length)}px">${rows}</div>`
            : html`<div class="empty-state">${t('search.empty')}</div>`}
        </div>
      </section>`;
  }

  private renderRow(side: Side, channel: BroadcastChannel, index: number): Safe {
    const entry = this.entry && this.entry.key === channel.serviceKey && this.entry.side === side ? this.entry : null;
    const moved = side === 'right' && this.moved === channel.serviceKey;
    const deleting = this.deleting === channel.serviceKey;
    return html`
      <div class="channel-item sat-channel sat-cm-row ${moved ? 'sat-cm-moved' : ''} ${entry ? 'sat-cm-entering' : ''}"
           data-key="${this.rowKey(side, channel)}" ${raw(entry ? '' : 'data-focusable')}
           data-cm-side="${side}" data-cm-service="${channel.serviceKey}"
           style="top:${this.virtual[side].getItemOffset(index)}px">
        <span class="sat-number">${channel.numberLabel}</span>
        <div class="channel-info">
          <div class="channel-name" dir="auto">${channel.name}</div>
        </div>
        ${entry ? this.renderEntry(entry.text)
          : deleting ? html`<span class="sat-cm-status">${t('satelliteTools.deleting')}</span>`
          : html`<span class="sat-badges">${this.badges(channel)}</span>`}
      </div>`;
  }

  private renderEntry(text: string): Safe {
    return html`
      <span class="sat-cm-entry">
        <span class="sat-cm-entry-label">${t('satelliteTools.moveToNumber')}</span>
        <input class="sat-tools-input sat-cm-entry-input editing" type="text" inputmode="numeric"
               data-focusable data-key="sat-cm-entry" data-cm-entry value="${text}"
               maxlength="${String(this.maxDigits())}" placeholder="1–${String(this.right.length)}" autocomplete="off">
      </span>`;
  }

  private badges(channel: BroadcastChannel): Safe {
    return html`
      ${channel.hd ? html`<span class="sat-badge">${t('satellite.hd')}</span>` : ''}
      ${channel.scrambled ? html`<span class="sat-badge sat-badge-icon" title="${t('satellite.encrypted')}">${raw(KEY_ICON)}</span>` : ''}
      ${channel.locked ? html`<span class="sat-badge sat-badge-icon sat-badge-lock">${raw(LOCK_ICON)}</span>` : ''}`;
  }

  // A field's typed value outlives its attribute: one not being typed in
  // is set to what the manager holds (a cleared filter, a typed digit).
  syncFields(): void {
    this.host.ui().querySelectorAll<HTMLInputElement>('input[data-cm-filter], input[data-cm-entry]').forEach((input) => {
      const value = input.getAttribute('value') ?? '';
      if (input !== document.activeElement && input.value !== value) input.value = value;
    });
  }

  private renderHints(): Safe {
    if (this.entry) {
      return html`
        <div class="edit-hints sat-cm-hints">
          ${okHint(t('satelliteTools.moveToNumber'))}
          <span class="edit-hint">${backKey()}<span>${t('common.cancel')}</span></span>
          <span class="edit-hint sat-cm-range">${t('satelliteTools.moveRange', { count: this.right.length })}</span>
        </div>`;
    }
    return html`
      <div class="edit-hints sat-cm-hints">
        ${okHint(t('satelliteTools.moveToNumber'))}
        ${keyHint('red', t('common.delete'), 'sat-cm-delete', { 'data-cm-action': 'delete' })}
      </div>`;
  }
}
