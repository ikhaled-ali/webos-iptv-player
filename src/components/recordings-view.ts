import type { Action } from '../types';
import { SpatialNav } from '../navigation/spatial-nav';
import { Focus, type FocusScope } from '../navigation/focus-scope';
import { html, raw } from '../utils/dom';
import { morph } from '../utils/morph';
import { t } from '../i18n';
import { formatDayLabel, formatPosition, formatTime } from '../utils/time';
import { StorageService } from '../services/storage-service';
import { RecordingClient, type RecordingEntry } from '../services/recording-client';
import { ConfirmationPrompt } from './confirmation-prompt';
import { formatBytes, locationLabel } from './recording-controller';
import { showToast } from './toast';
import { PLAY_ICON, RECORD_ICON, TRASH_ICON } from './icons';

// Resume entries for recordings live under this pseudo-account, apart from
// every Xtream account's Continue Watching.
export const RECORDINGS_ACCOUNT = 'recordings';

interface RecordingsViewOptions {
  onRevealTabBar: () => void;
  onBack: () => void;
  onPlay: (entry: RecordingEntry, resumeSecs: number) => void;
  // The list was read: the host shows the tab only while it holds any.
  onCountChanged: (count: number) => void;
}

/**
 * Saved recordings, newest first: channel, program, when, how long, and where
 * it is stored. OK plays one in the VOD player; Red or its Delete button
 * deletes it after asking. Channel and program names come from the stream's
 * source, so they render only through `html`.
 */
export class RecordingsView {
  private nav: SpatialNav;
  readonly focusScope: FocusScope;
  private confirmationPrompt = new ConfirmationPrompt('prompt.recordings');
  private entries: RecordingEntry[] = [];
  private loaded = false;

  constructor(private container: HTMLElement, private options: RecordingsViewOptions) {
    this.focusScope = Focus.register({
      id: 'view.recordings',
      root: container,
      leaveFor: { up: 'tabbar' },
      defaultKey: () => {
        const el = this.nav.focused;
        return el && this.container.contains(el) ? el.dataset.key ?? null : null;
      },
    });
    this.nav = new SpatialNav(container, undefined, { scope: this.focusScope });
    this.container.setAttribute('data-self-activate', '');
    this.container.addEventListener('click', (event: MouseEvent) => {
      const control = (event.target as HTMLElement).closest<HTMLElement>('[data-focusable]');
      if (!control) return;
      this.nav.focus(control, 'pointer');
      this.activate(control);
    });
  }

  get count(): number {
    return this.entries.length;
  }

  // Re-reads the list; the host calls it at boot and after any change.
  async refresh(): Promise<void> {
    if (!RecordingClient.available()) return;
    this.entries = await RecordingClient.list();
    this.loaded = true;
    this.options.onCountChanged(this.entries.length);
  }

  async open(): Promise<void> {
    this.render();
    this.focusFirst();
    await this.refresh();
    const key = this.nav.focused?.dataset.key ?? null;
    this.render();
    this.refocus(key);
  }

  resumeFocus(): void {
    this.refocus(this.nav.focused?.dataset.key ?? null);
  }

  dismissPrompt(): void {
    this.confirmationPrompt.hide();
  }

  handleAction(action: Action): void {
    if (this.confirmationPrompt.visible) {
      this.confirmationPrompt.handleAction(action);
      return;
    }
    const focused = this.nav.focused;
    if (action === 'back') {
      this.options.onBack();
    } else if (action === 'select' && focused) {
      this.activate(focused);
    } else if (action === 'red' && focused?.dataset.recordingId) {
      this.confirmDelete(focused.dataset.recordingId);
    } else if (action === 'up' || action === 'down' || action === 'left' || action === 'right') {
      if (!this.nav.move(action) && action === 'up') this.options.onRevealTabBar();
    }
  }

  private render(): void {
    const entries = this.entries;
    morph(this.container, html`
      <div class="recordings-view">
        <header class="recordings-heading">
          <h1>${t('recording.title')}</h1>
          ${this.loaded ? html`<p>${t('recording.summary', { count: entries.length })}</p>` : ''}
        </header>
        ${entries.length
          ? html`<div class="recordings-list" data-nav-container>
              ${entries.map(entry => this.row(entry))}
            </div>`
          : html`<div class="recordings-empty">
              <span class="recordings-empty-icon">${raw(RECORD_ICON)}</span>
              <p>${this.loaded ? t('recording.empty') : t('common.loading')}</p>
              ${this.loaded ? html`<p class="recordings-empty-hint">${t('recording.emptyHint')}</p>` : ''}
            </div>`}
      </div>
    `);
  }

  private row(entry: RecordingEntry) {
    const start = new Date(entry.startedAt);
    const day = formatDayLabel(start);
    const title = entry.programTitle || entry.channelName;
    return html`
      <div class="recordings-row" data-key="row:${entry.id}">
        <button class="recordings-play" data-focusable data-key="play:${entry.id}"
                data-recording-action="play" data-recording-id="${entry.id}">
          <span class="recordings-logo">
            ${entry.logo
              ? html`<img src="${entry.logo}" alt="" loading="lazy">`
              : html`<span class="recordings-logo-fallback">${raw(PLAY_ICON)}</span>`}
          </span>
          <span class="recordings-details">
            <span class="recordings-title">${title}</span>
            <span class="recordings-meta">
              ${entry.programTitle ? html`<span>${entry.channelName}</span>` : ''}
              <span>${day.weekday} ${day.date} · ${formatTime(start)}</span>
              <span>${formatPosition(entry.durationSecs)}</span>
              <span>${formatBytes(entry.bytes)}</span>
              <span>${locationLabel(entry.kind, entry.name)}</span>
            </span>
          </span>
        </button>
        <button class="recordings-delete" data-focusable data-key="delete:${entry.id}"
                data-recording-action="delete" data-recording-id="${entry.id}">
          <span class="recordings-delete-icon">${raw(TRASH_ICON)}</span>
          <span>${t('common.delete')}</span>
        </button>
      </div>
    `;
  }

  private activate(control: HTMLElement): void {
    const id = control.dataset.recordingId;
    const entry = this.entries.find(e => e.id === id);
    if (!entry) return;
    if (control.dataset.recordingAction === 'delete') {
      this.confirmDelete(entry.id);
      return;
    }
    const resume = StorageService.getResume(RECORDINGS_ACCOUNT, 'vod', entry.id);
    this.options.onPlay(entry, resume?.position ?? 0);
  }

  private confirmDelete(id: string): void {
    const entry = this.entries.find(e => e.id === id);
    if (!entry) return;
    this.confirmationPrompt.show({
      title: t('recording.deleteTitle'),
      message: t('recording.deleteMessage', { name: entry.programTitle || entry.channelName }),
      confirmLabel: t('common.delete'),
      cancelLabel: t('common.cancel'),
      onConfirm: () => { void this.remove(entry); },
      onCancel: () => {},
    });
  }

  private async remove(entry: RecordingEntry): Promise<void> {
    const index = this.entries.indexOf(entry);
    if (!await RecordingClient.remove(entry.id)) {
      showToast(t('recording.deleteFailed'));
      return;
    }
    StorageService.clearResume(RECORDINGS_ACCOUNT, 'vod', entry.id);
    this.entries = this.entries.filter(e => e !== entry);
    this.options.onCountChanged(this.entries.length);
    showToast(t('recording.deleted'));
    if (!this.entries.length) {
      this.options.onBack();
      return;
    }
    this.render();
    const next = this.entries[Math.min(index, this.entries.length - 1)];
    this.refocus(`play:${next.id}`);
  }

  private refocus(key: string | null): void {
    const el = key ? this.container.querySelector<HTMLElement>(`[data-key="${key}"]`) : null;
    if (el) this.nav.focus(el);
    else this.focusFirst();
  }

  private focusFirst(): void {
    this.nav.focus(this.container.querySelector<HTMLElement>('.recordings-play'));
  }
}
