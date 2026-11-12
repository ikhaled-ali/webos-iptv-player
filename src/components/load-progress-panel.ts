import type { Action } from '../types';
import { Focus, Tier, type FocusScope } from '../navigation/focus-scope';
import { html } from '../utils/dom';
import { morph } from '../utils/morph';
import { t } from '../i18n';
import { percentOf, type LoadPart, type LoadRow } from '../utils/load-progress';

const LABELS: Record<LoadPart, 'common.channels' | 'common.movies' | 'common.series'> = {
  channels: 'common.channels',
  movies: 'common.movies',
  series: 'common.series',
};

// Shows how far a load has come, one row per part. OK or Back leaves it to
// finish in the background.
export class LoadProgressPanel {
  private el: HTMLElement | null = null;
  private rows: LoadRow[] = [];
  private readonly scope: FocusScope;

  constructor(private readonly onDismiss: () => void) {
    this.scope = Focus.register({
      id: 'load-progress',
      root: () => this.el,
      restrict: 'self-only',
      tier: Tier.prompt,
      onAction: (action) => this.handleAction(action),
      defaultKey: () => 'dismiss',
    });
  }

  get visible(): boolean {
    return this.el !== null && !this.el.classList.contains('hidden');
  }

  show(rows: LoadRow[]): void {
    this.rows = rows;
    if (!this.el) {
      this.el = document.createElement('div');
      this.el.className = 'load-progress-prompt';
      this.el.setAttribute('data-self-activate', '');
      this.el.addEventListener('click', (event: MouseEvent) => {
        if ((event.target as HTMLElement).closest('[data-load-progress-dismiss]')) this.dismiss();
      });
      this.el.addEventListener('nav:hover', (event: Event) => {
        if ((event.target as HTMLElement).closest('[data-load-progress-dismiss]')) {
          this.scope.focus('dismiss', 'pointer');
        }
      });
    }
    // Last in <body>, so it paints above a prompt of its tier shown before it.
    document.body.appendChild(this.el);
    this.el.classList.remove('hidden');
    this.render();
    Focus.push(this.scope);
    this.scope.focus('dismiss', 'key');
    Focus.flush();
  }

  update(rows: LoadRow[]): void {
    this.rows = rows;
    if (this.visible) this.render();
  }

  hide(): void {
    if (!this.el) return;
    this.el.classList.add('hidden');
    Focus.pop(this.scope);
  }

  handleAction(action: Action): void {
    if (!this.visible) return;
    if (action === 'select' || action === 'back') this.dismiss();
  }

  private dismiss(): void {
    this.hide();
    this.onDismiss();
  }

  private render(): void {
    if (!this.el) return;
    morph(this.el, html`
      <div class="confirmation-dialog load-progress-dialog" role="dialog" aria-labelledby="load-progress-title">
        <h2 id="load-progress-title" class="confirmation-title">${t('common.loading')}</h2>
        <div class="load-progress-rows">
          ${this.rows.map(row => {
            const percent = percentOf(row);
            return html`
              <div class="load-progress-row" data-key="row-${row.part}" data-part="${row.part}"
                   data-status="${row.status}">
                <span class="load-progress-label">${t(LABELS[row.part])}</span>
                <div class="load-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100"
                     aria-valuenow="${percent}">
                  <div class="load-progress-fill" style="transform:scaleX(${percent / 100})"></div>
                </div>
                <span class="load-progress-value">${row.status === 'failed'
                  ? t('loadProgress.failed')
                  : t('loadProgress.percent', { percent })}</span>
              </div>
            `;
          })}
        </div>
        <div class="confirmation-buttons">
          <button class="confirmation-btn" data-focusable data-key="dismiss"
                  data-load-progress-dismiss>${t('loadProgress.continueInBackground')}</button>
        </div>
      </div>
    `);
  }
}
