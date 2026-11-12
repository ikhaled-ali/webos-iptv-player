import type { Action } from '../types';
import { Focus, type FocusScope, type Via } from '../navigation/focus-scope';
import { html } from '../utils/dom';
import { morph } from '../utils/morph';

export interface Choice {
  id: string;
  label: string;
  detail?: string;
  danger?: boolean;
}

interface ChoiceOptions {
  title: string;
  message?: string;
  choices: Choice[];
  // The choice focused on open; defaults to the first.
  initial?: string;
  onChoose: (id: string) => void;
  onCancel: () => void;
}

/**
 * A modal with a vertical list of choices, for decisions with more than a
 * yes and a no. Up/Down move, OK picks, Back cancels.
 */
export class ChoicePrompt {
  private el: HTMLElement | null = null;
  private options: ChoiceOptions | null = null;
  private focusIndex = 0;
  private scope: FocusScope | null = null;

  constructor(private readonly id: string) {}

  get visible(): boolean {
    return this.el !== null && !this.el.classList.contains('hidden');
  }

  show(options: ChoiceOptions): void {
    if (!this.scope) {
      this.scope = Focus.register({
        id: this.id,
        root: () => this.el,
        restrict: 'self-only',
        onAction: (action) => this.handleAction(action),
        defaultKey: () => this.keyAt(this.focusIndex),
      });
    }
    this.options = options;
    const initial = options.initial ? options.choices.findIndex(c => c.id === options.initial) : 0;
    this.focusIndex = Math.max(0, initial);
    if (!this.el) {
      this.el = document.createElement('div');
      this.el.className = 'confirmation-prompt choice-prompt';
      this.el.setAttribute('data-self-activate', '');
      this.bindEvents();
    }
    document.body.appendChild(this.el);
    this.el.classList.remove('hidden');
    this.render();
    Focus.push(this.scope);
    this.moveTo(this.focusIndex, 'key');
  }

  hide(): void {
    if (!this.options) return;
    this.el?.classList.add('hidden');
    this.options = null;
    if (this.scope) Focus.pop(this.scope);
  }

  handleAction(action: Action): void {
    const options = this.options;
    if (!this.visible || !options) return;
    switch (action) {
      case 'up':
        this.moveTo(Math.max(0, this.focusIndex - 1), 'key');
        break;
      case 'down':
        this.moveTo(Math.min(options.choices.length - 1, this.focusIndex + 1), 'key');
        break;
      case 'select':
        this.choose(this.focusIndex);
        break;
      case 'back':
        this.hide();
        options.onCancel();
        break;
    }
  }

  private keyAt(index: number): string | null {
    const choice = this.options?.choices[index];
    return choice ? `choice:${choice.id}` : null;
  }

  private moveTo(index: number, via: Via): void {
    this.focusIndex = index;
    this.scope?.focus(this.keyAt(index), via);
    Focus.flush();
  }

  private choose(index: number): void {
    const options = this.options;
    const choice = options?.choices[index];
    if (!options || !choice) return;
    this.hide();
    options.onChoose(choice.id);
  }

  private render(): void {
    if (!this.el || !this.options) return;
    const { title, message, choices } = this.options;
    morph(this.el, html`
      <div class="confirmation-dialog choice-dialog" role="dialog">
        <h2 class="confirmation-title">${title}</h2>
        ${message ? html`<p class="confirmation-message">${message}</p>` : ''}
        <div class="choice-buttons">
          ${choices.map((choice, index) => html`
            <button class="confirmation-btn choice-btn ${choice.danger ? 'danger' : ''}" data-focusable
                    data-key="choice:${choice.id}" data-choice-index="${index}">
              <span class="choice-label">${choice.label}</span>
              ${choice.detail ? html`<span class="choice-detail">${choice.detail}</span>` : ''}
            </button>
          `)}
        </div>
      </div>
    `);
  }

  private bindEvents(): void {
    const indexOf = (event: Event): number => {
      const button = (event.target as HTMLElement).closest<HTMLElement>('[data-choice-index]');
      return button ? Number(button.dataset.choiceIndex) : -1;
    };
    this.el!.addEventListener('nav:hover', (event: Event) => {
      const index = indexOf(event);
      if (index >= 0) this.moveTo(index, 'pointer');
    });
    this.el!.addEventListener('click', (event: MouseEvent) => {
      const index = indexOf(event);
      if (index >= 0) this.choose(index);
    });
  }
}
