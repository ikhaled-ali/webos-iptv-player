import type { Action } from '../types';
import { Focus, type FocusScope } from '../navigation/focus-scope';
import { html, raw } from '../utils/dom';
import { morph } from '../utils/morph';
import { t } from '../i18n';
import { REMOVE_ICON } from './icons';

interface RemoveTipOptions {
  anchor: HTMLElement;
  label: string;
  onRemove: () => void;
  onClose: () => void;
}

// A small tooltip over a tile holding one focused Remove row: OK removes,
// Back (or any other key, or a press elsewhere) closes it.
export class RemoveTip {
  private el: HTMLElement | null = null;
  private options: RemoveTipOptions | null = null;
  private scope: FocusScope | null = null;

  constructor(private readonly id: string) {}

  get visible(): boolean {
    return this.el !== null && !this.el.classList.contains('hidden');
  }

  show(options: RemoveTipOptions): void {
    if (!this.scope) {
      this.scope = Focus.register({
        id: this.id,
        root: () => this.el,
        restrict: 'self-only',
        onAction: (action) => this.handleAction(action),
        defaultKey: () => 'remove',
      });
    }
    this.options = options;
    if (!this.el) {
      this.el = document.createElement('div');
      this.el.className = 'remove-tip';
      this.el.setAttribute('data-self-activate', '');
      this.bindEvents();
    }
    document.body.appendChild(this.el);
    this.el.classList.remove('hidden');
    this.render();
    this.place(options.anchor);
    Focus.push(this.scope);
    this.scope.focus('remove', 'key');
    Focus.flush();
  }

  hide(): void {
    this.el?.classList.add('hidden');
    this.options = null;
    if (this.scope) Focus.pop(this.scope);
  }

  handleAction(action: Action): void {
    if (!this.visible) return;
    if (action === 'select') this.remove();
    else this.close();
  }

  private remove(): void {
    const options = this.options;
    this.hide();
    options?.onRemove();
  }

  private close(): void {
    const options = this.options;
    this.hide();
    options?.onClose();
  }

  // Centered over the anchor, or under it when there is no room above.
  private place(anchor: HTMLElement): void {
    const el = this.el;
    if (!el) return;
    const rect = anchor.getBoundingClientRect();
    const tipHeight = el.offsetHeight;
    const above = rect.top - tipHeight - 12 >= 0;
    el.classList.toggle('below', !above);
    el.style.left = `${Math.round(rect.left + rect.width / 2)}px`;
    el.style.top = `${Math.round(above ? rect.top - tipHeight - 12 : rect.bottom + 12)}px`;
  }

  private render(): void {
    if (!this.el || !this.options) return;
    morph(this.el, html`
      <button class="remove-tip-btn" data-focusable data-key="remove"
              aria-label="${this.options.label}">${raw(REMOVE_ICON)}<span>${t('common.remove')}</span></button>
    `);
  }

  private bindEvents(): void {
    this.el!.addEventListener('click', (event: MouseEvent) => {
      if ((event.target as HTMLElement).closest('[data-key="remove"]')) this.remove();
    });
    // A press elsewhere dismisses; the release of the hold that opened the
    // tip is not a press, so it never does.
    document.addEventListener('mousedown', (event: MouseEvent) => {
      if (this.visible && !this.el!.contains(event.target as Node)) this.close();
    }, true);
  }
}
