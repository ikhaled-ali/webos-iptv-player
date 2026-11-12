import type { Action, VodQueueItem } from '../types';
import { html, raw, show, hide, inShownView, type Safe } from '../utils/dom';
import { morph } from '../utils/morph';
import { Focus, type FocusScope } from '../navigation/focus-scope';
import { formatDuration } from '../utils/time';
import { t } from '../i18n';
import { CONFIG } from '../config';
import { PLAY_ICON } from './icons';

// The panel's slide, as in `#vod-episodes`'s transition in player.css.
const SLIDE_MS = 250;

export interface EpisodesPanelOptions {
  // How far into an episode the user got, 0..1; 0 when never started.
  progress: (item: VodQueueItem) => number;
  onPick: (item: VodQueueItem) => void;
  onClose: () => void;
}

/**
 * Every episode of the playing series, in a side panel like the player menu,
 * over the video: grouped by season, the playing one selected, each
 * with how much of it was watched. Up/Down move, OK plays the episode, Back
 * closes. Titles come from the provider, so they render only through `html`.
 */
export class EpisodesPanel {
  private isVisible = false;
  private scope: FocusScope | null = null;
  private slideTimer: ReturnType<typeof setTimeout> | null = null;
  private items: VodQueueItem[] = [];
  private currentId = '';
  private focusIndex = 0;

  constructor(private el: HTMLElement, private options: EpisodesPanelOptions) {
    this.el.setAttribute('data-self-activate', '');
    this.el.addEventListener('click', (e: MouseEvent) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('[data-episode-index]');
      if (!row) return;
      const item = this.items[parseInt(row.dataset.episodeIndex ?? '-1', 10)];
      if (item) this.options.onPick(item);
    });
  }

  get visible(): boolean {
    return this.isVisible;
  }

  open(items: VodQueueItem[], currentId: string): void {
    this.items = items;
    this.currentId = currentId;
    this.focusIndex = Math.max(0, items.findIndex(item => item.itemId === currentId));
    this.isVisible = true;
    this.render();
    if (this.slideTimer !== null) clearTimeout(this.slideTimer);
    this.slideTimer = null;
    show(this.el);
    // One frame shown off-screen first, so the panel slides in.
    void this.el.offsetWidth;
    this.el.classList.add('visible');
    if (!this.scope) {
      const el = this.el;
      this.scope = Focus.register({
        id: 'player.episodes',
        root: el,
        restrict: 'self-only',
        when: () => inShownView(el),
        defaultKey: () => this.rowKey(this.focusIndex),
        reveal: (key) => this.revealRow(key),
        onAction: (action) => this.handleAction(action),
      });
    }
    Focus.push(this.scope);
    this.focusRow(true);
  }

  close(): void {
    if (!this.isVisible) return;
    this.isVisible = false;
    if (this.scope) Focus.pop(this.scope);
    // Close mirrors open: it slides out, then leaves the layout.
    this.el.classList.remove('visible');
    this.slideTimer = setTimeout(() => {
      this.slideTimer = null;
      if (!this.isVisible) hide(this.el);
    }, SLIDE_MS);
    this.options.onClose();
  }

  handleAction(action: Action): void {
    if (action === 'back') {
      this.close();
    } else if (action === 'up' || action === 'down') {
      const next = this.focusIndex + (action === 'up' ? -1 : 1);
      if (next < 0 || next >= this.items.length) return;
      this.focusIndex = next;
      this.focusRow(false);
    } else if (action === 'select') {
      const item = this.items[this.focusIndex];
      if (item) this.options.onPick(item);
    }
  }

  private rowKey(index: number): string {
    return `episode:${this.items[index]?.itemId ?? ''}`;
  }

  // Opening centers the playing episode; after that the scope's reveal
  // brings each focused row in.
  private focusRow(center: boolean): void {
    if (center) {
      const list = this.el.querySelector<HTMLElement>('.vod-episodes-list');
      const row = this.el.querySelector<HTMLElement>(`[data-episode-index="${String(this.focusIndex)}"]`);
      if (list && row) {
        list.scrollTop = Math.max(0, row.offsetTop - list.offsetTop - (list.clientHeight - row.offsetHeight) / 2);
      }
    }
    this.scope?.focus(this.rowKey(this.focusIndex), 'key');
  }

  // Scrolls the list alone, by layout offsets the slide doesn't move: a
  // geometric reveal while the panel slides in would scroll the player view,
  // controls and all, sideways.
  private revealRow(key: string): null {
    const list = this.el.querySelector<HTMLElement>('.vod-episodes-list');
    const row = list?.querySelector<HTMLElement>(`[data-key="${key}"]`);
    if (!list || !row) return null;
    const margin = CONFIG.NAVIGATION.REVEAL_MARGIN;
    const top = row.offsetTop - list.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top - margin < list.scrollTop) list.scrollTop = Math.max(0, top - margin);
    else if (bottom + margin > list.scrollTop + list.clientHeight) list.scrollTop = bottom + margin - list.clientHeight;
    return null;
  }

  private render(): void {
    let season: number | null = null;
    const rows: Safe[] = [];
    this.items.forEach((item, index) => {
      const s = item.searchMeta?.season ?? null;
      if (s !== null && s !== season) {
        season = s;
        rows.push(html`<div class="vod-episodes-season" data-key="season:${String(s)}">${
          t('catalog.season', { number: s })}</div>`);
      }
      rows.push(this.row(item, index));
    });
    morph(this.el, html`
      <div class="menu-header">
        <h2>${t('player.episodes')}</h2>
      </div>
      <div class="vod-episodes-list">${rows}</div>
    `);
  }

  private row(item: VodQueueItem, index: number): Safe {
    const current = item.itemId === this.currentId;
    const progress = Math.max(0, Math.min(1, this.options.progress(item)));
    const number = item.searchMeta?.episode;
    const title = item.details?.title || item.title;
    const length = item.details && item.details.durationSecs > 0
      ? formatDuration(item.details.durationSecs * 1000)
      : '';
    return html`
      <div class="vod-episode ${current ? 'current' : ''}" data-focusable
           data-key="${this.rowKey(index)}" data-episode-index="${String(index)}">
        <div class="vod-episode-number">${current ? raw(PLAY_ICON) : number !== undefined ? String(number) : ''}</div>
        <div class="vod-episode-body">
          <div class="vod-episode-title">${title}</div>
          ${length ? html`<div class="vod-episode-length">${length}</div>` : ''}
          ${progress > 0 ? html`
            <div class="vod-episode-progress"><div class="vod-episode-progress-fill"
                 style="width:${String(Math.round(progress * 100))}%"></div></div>` : ''}
        </div>
      </div>
    `;
  }
}
