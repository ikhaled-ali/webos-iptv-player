import type { Action, VodDetails } from '../types';
import { html, show, hide, inShownView } from '../utils/dom';
import { morph } from '../utils/morph';
import { Focus, type FocusScope } from '../navigation/focus-scope';
import { formatDuration } from '../utils/time';
import { t } from '../i18n';

// The panel's slide, as in `#vod-info`'s transition in player.css.
const SLIDE_MS = 250;

/**
 * The movie or episode's Title Info in a side panel like the player menu,
 * over the playing video: poster, title, year/length/genre/rating, plot,
 * cast, and director. A modal whose panel holds the keys itself, with no
 * controls; OK or Back closes it.
 * Its text comes from the provider, so it renders only through `html`.
 */
export class VodInfoOverlay {
  private isVisible = false;
  private scope: FocusScope | null = null;
  private slideTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private el: HTMLElement, private onClose: () => void = () => {}) {}

  get visible(): boolean {
    return this.isVisible;
  }

  open(details: VodDetails, poster: string): void {
    this.isVisible = true;
    this.render(details, poster);
    if (this.slideTimer !== null) clearTimeout(this.slideTimer);
    this.slideTimer = null;
    show(this.el);
    // One frame shown off-screen first, so the panel slides in.
    void this.el.offsetWidth;
    this.el.classList.add('visible');
    if (!this.scope) {
      const el = this.el;
      this.scope = Focus.register({
        id: 'player.title_info',
        root: el,
        restrict: 'self-only',
        when: () => inShownView(el),
        defaultKey: () => 'info-panel',
        // Its one target is the whole panel, off-screen while it slides in: a
        // reveal would scroll the player view, controls and all, sideways.
        reveal: () => null,
        onAction: (action) => this.handleAction(action),
      });
    }
    Focus.push(this.scope);
    this.scope.focus('info-panel', 'key');
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
    this.onClose();
  }

  handleAction(action: Action): void {
    if (action === 'select' || action === 'back') this.close();
  }

  private render(d: VodDetails, poster: string): void {
    const length = d.durationSecs > 0 ? formatDuration(d.durationSecs * 1000) : '';
    const meta = [d.year, length, d.genre, d.rating].filter(part => !!part);
    morph(this.el, html`
      <div class="menu-header">
        <h2>${t('player.titleInfo')}</h2>
      </div>
      <div class="vod-info-card" data-self-activate data-focusable data-key="info-panel">
        <div class="vod-info-head">
          ${poster ? html`<img class="vod-info-poster" src="${poster}" alt="">` : ''}
          <div class="vod-info-heading">
            ${d.context ? html`<div class="vod-info-context">${d.context}</div>` : ''}
            <h2 class="vod-info-title">${d.title}</h2>
            ${meta.length ? html`<div class="vod-info-meta">${meta.join('  ·  ')}</div>` : ''}
          </div>
        </div>
        ${d.plot ? html`<p class="vod-info-plot">${d.plot}</p>` : ''}
        ${d.cast ? html`<div class="vod-info-credit"><span class="vod-info-label">${t('catalog.cast')}</span> ${d.cast}</div>` : ''}
        ${d.director ? html`<div class="vod-info-credit"><span class="vod-info-label">${t('catalog.director')}</span> ${d.director}</div>` : ''}
      </div>
    `);
  }
}
