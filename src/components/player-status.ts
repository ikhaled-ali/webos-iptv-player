import { t } from '../i18n';
import { html } from '../utils/dom';
import { morph } from '../utils/morph';
import { safePlaybackDetail } from '../utils/playback-error';

export type PlayerStatusState = 'loading' | 'buffering' | 'reconnecting' | 'error';
const MESSAGES = {
  loading: 'common.loading',
  buffering: 'player.buffering',
  reconnecting: 'player.reconnecting',
  error: 'player.streamError',
} as const;

export class PlayerStatus {
  private readonly root: HTMLElement;
  private current: PlayerStatusState | null = null;
  private engine = '';
  private detail = '';

  constructor(container: HTMLElement) {
    this.root = container.querySelector<HTMLElement>('.player-status') ?? document.createElement('div');
    this.root.classList.add('player-status', 'hidden');
    this.root.setAttribute('role', 'status');
    this.root.setAttribute('aria-live', 'polite');
    if (!this.root.parentNode) container.appendChild(this.root);
  }

  get state(): PlayerStatusState | null { return this.current; }

  set(state: PlayerStatusState | null, engine = this.engine, detail = state === this.current ? this.detail : ''): void {
    detail = state === 'error' || state === 'reconnecting' ? safePlaybackDetail(detail) : '';
    if (state === this.current && engine === this.engine && detail === this.detail) return;
    this.current = state;
    this.engine = engine;
    this.detail = detail;
    this.root.classList.toggle('hidden', state === null);
    if (!state) { this.root.removeAttribute('data-state'); return; }
    this.root.setAttribute('data-state', state);
    morph(this.root, html`
      <div class="player-status-text">${t(MESSAGES[state])}</div>
      <div class="player-status-engine">${engine}</div>
      ${detail ? html`<div class="player-status-detail">${detail}</div>` : ''}
    `);
  }
}
