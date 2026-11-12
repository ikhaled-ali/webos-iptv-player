import type { Channel } from '../types';
import { t, type TextMessageKey } from '../i18n';
import { createLogger } from '../utils/logger';
import { html } from '../utils/dom';
import { morph } from '../utils/morph';
import { formatPosition } from '../utils/time';
import { channelKey } from '../utils/channel';
import { EpgService } from '../services/epg-service';
import {
  RecordingClient,
  type ActiveRecording,
  type RecordingLocation,
  type RecordingStatusEvent,
  type StartFailure,
} from '../services/recording-client';
import { ChoicePrompt, type Choice } from './choice-prompt';
import { showToast } from './toast';

const log = createLogger('Recording');

export interface RecordingTarget {
  channel: Channel;
  url: string;
}

interface RecordingControllerOptions {
  // The live channel on screen, or null for VOD, catch-up, or nothing.
  target: () => RecordingTarget | null;
  // Saved recordings came or went: the Recordings tab may show or hide.
  onRecordingsChanged: () => void;
  // The recording started or stopped: the player menu re-reads its rows.
  onStateChanged: () => void;
}

const FAILURE_COPY: Record<StartFailure, TextMessageKey> = {
  unsupported: 'recording.unsupported',
  location: 'recording.storageUnavailable',
  busy: 'recording.failed',
  failed: 'recording.failed',
  unavailable: 'recording.notAvailable',
};

export function formatBytes(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return t('recording.sizeGb', { size: gb.toFixed(1) });
  return t('recording.sizeMb', { size: Math.max(1, Math.round(bytes / (1024 * 1024))) });
}

export function locationLabel(kind: 'internal' | 'usb', name: string): string {
  return kind === 'internal' ? t('recording.internalStorage')
    : name ? `${t('recording.usbStorage')} (${name})` : t('recording.usbStorage');
}

/**
 * Starts and stops live recordings through the bundled service, asks where to
 * save when there is more than one place, asks how to stop, and shows the
 * on-screen recording indicator. Any channel change or exit while recording
 * goes through `guard`, which asks first: most providers allow one stream.
 */
export class RecordingController {
  private active: ActiveRecording | null = null;
  private activeChannelName = '';
  private starting = false;
  private prompt = new ChoicePrompt('prompt.recording');
  private indicator: HTMLElement | null = null;
  private tick: ReturnType<typeof setInterval> | null = null;
  // Unknown until the status subscription answers. A service that never
  // answers (absent, as in the Simulator) keeps Record on offer, and Red
  // explains that this TV can't record.
  private service: 'unknown' | 'ready' | 'unavailable' = 'unknown';

  constructor(private container: HTMLElement, private options: RecordingControllerOptions) {
    RecordingClient.subscribe((status) => {
      this.service = 'ready';
      this.onStatus(status);
    }, () => { this.service = 'unavailable'; });
  }

  get recording(): boolean {
    return this.active !== null;
  }

  get promptVisible(): boolean {
    return this.prompt.visible;
  }

  canRecord(): boolean {
    return this.options.target() !== null;
  }

  // Red: start a recording of the channel on screen, or ask how to stop one.
  toggle(): void {
    if (this.prompt.visible || this.starting) return;
    if (this.active) {
      this.askStop(() => {});
      return;
    }
    const target = this.options.target();
    if (!target) return;
    if (this.service === 'unavailable') {
      showToast(t('recording.notAvailable'));
      return;
    }
    void this.chooseLocation(target);
  }

  /**
   * Called before the player leaves the recorded channel. Returns false when
   * nothing is recording (or the same channel stays), so the caller goes on;
   * true when it asked first and will run `proceed` once the user answered.
   */
  guard(nextChannel: Channel | null, proceed: () => void): boolean {
    if (!this.active) return false;
    if (nextChannel && channelKey(nextChannel) === this.active.channelId) return false;
    this.askStop(proceed);
    return true;
  }

  // The player stopped without asking (the app closing, another section).
  stopAndSave(): void {
    if (!this.active) return;
    void this.stop(true);
  }

  private async chooseLocation(target: RecordingTarget): Promise<void> {
    this.starting = true;
    let locations: RecordingLocation[] | null;
    try {
      locations = await RecordingClient.locations();
    } finally {
      this.starting = false;
    }
    if (!locations) {
      this.service = 'unavailable';
      showToast(t('recording.notAvailable'));
      return;
    }
    if (!locations.length) {
      showToast(t('recording.storageUnavailable'));
      return;
    }
    if (locations.length === 1) {
      void this.start(target, locations[0]);
      return;
    }
    const choices: Choice[] = locations.map(location => ({
      id: location.id,
      label: locationLabel(location.kind, location.name),
      detail: location.freeBytes !== null
        ? t('recording.free', { size: formatBytes(location.freeBytes) }) : undefined,
    }));
    choices.push({ id: '', label: t('common.cancel') });
    this.prompt.show({
      title: t('recording.recordTo'),
      choices,
      onChoose: (id) => {
        const location = locations.find(l => l.id === id);
        if (location) void this.start(target, location);
      },
      onCancel: () => {},
    });
  }

  private async start(target: RecordingTarget, location: RecordingLocation): Promise<void> {
    const { channel, url } = target;
    const epgId = EpgService.findChannelId(channel);
    const program = epgId ? EpgService.getNowPlaying(epgId) : null;
    const headers: Record<string, string> = { ...(channel.httpHeaders ?? {}) };
    const agent = channel.extras?.['http-user-agent'];
    if (agent && !headers['User-Agent']) headers['User-Agent'] = agent;
    const referrer = channel.extras?.['http-referrer'];
    if (referrer && !headers.Referer) headers.Referer = referrer;

    this.starting = true;
    showToast(t('recording.starting'));
    const result = await RecordingClient.start({
      locationId: location.id,
      url,
      headers,
      channelId: channelKey(channel),
      channelName: channel.name,
      logo: channel.logo,
      programTitle: program?.title ?? '',
    });
    this.starting = false;
    if (!result.ok) {
      showToast(t(FAILURE_COPY[result.reason]));
      return;
    }
    log.info('Recording started', 'event=recording.started', `location=${location.kind}`);
    this.activeChannelName = channel.name;
    this.setActive({ id: result.id, channelId: channelKey(channel), startedAt: result.startedAt, bytes: 0 });
  }

  private askStop(proceed: () => void): void {
    this.prompt.show({
      title: t('player.stopRecording'),
      message: this.activeChannelName ? t('recording.stopMessage', { name: this.activeChannelName }) : undefined,
      choices: [
        { id: 'save', label: t('recording.stopAndSave') },
        { id: 'discard', label: t('recording.stopWithoutSaving'), danger: true },
        { id: 'cancel', label: t('common.cancel') },
      ],
      onChoose: (id) => {
        if (id === 'cancel') return;
        void this.stop(id === 'save').then(proceed);
      },
      onCancel: () => {},
    });
  }

  private async stop(save: boolean): Promise<void> {
    const active = this.active;
    if (!active) return;
    this.setActive(null);
    const saved = await RecordingClient.stop(active.id, save);
    if (saved) showToast(t('recording.saved'));
    else if (save) showToast(t('recording.failed'));
    this.options.onRecordingsChanged();
  }

  private onStatus(status: RecordingStatusEvent): void {
    if (status.event === 'failed') {
      log.warn('Recording interrupted', 'event=recording.interrupted', `saved=${String(!!status.saved)}`);
      showToast(t(status.saved ? 'recording.interruptedSaved' : 'recording.interrupted'));
      this.setActive(null);
      if (status.saved) this.options.onRecordingsChanged();
      return;
    }
    // The first answer, or another start/stop: the service is the truth.
    if (!this.starting && (status.active?.id ?? null) !== (this.active?.id ?? null)) {
      this.setActive(status.active);
    }
  }

  private setActive(active: ActiveRecording | null): void {
    this.active = active;
    if (!active) this.activeChannelName = '';
    if (this.tick) clearInterval(this.tick);
    this.tick = active ? setInterval(() => this.renderIndicator(), 1000) : null;
    this.renderIndicator();
    this.options.onStateChanged();
  }

  private renderIndicator(): void {
    if (!this.indicator) {
      this.indicator = document.createElement('div');
      this.indicator.className = 'recording-indicator hidden';
      this.indicator.setAttribute('role', 'status');
      this.container.appendChild(this.indicator);
    }
    const active = this.active;
    this.indicator.classList.toggle('hidden', !active);
    if (!active) return;
    const elapsed = (Date.now() - active.startedAt) / 1000;
    morph(this.indicator, html`
      <span class="recording-indicator-dot" aria-hidden="true"></span>
      <span class="recording-indicator-time">${formatPosition(elapsed)}</span>
    `);
    this.indicator.setAttribute('aria-label', t('recording.inProgress'));
  }
}
