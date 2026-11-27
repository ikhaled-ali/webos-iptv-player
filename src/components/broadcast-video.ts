import { createLogger } from '../utils/logger';
import { PlayerPresentation } from './player-presentation';

// The TV's tuner output as a <video>: webOS opens a broadcast pipeline for a
// `service/webos-broadcast` source on `tv://`, and the element's mediaId is
// that broadcast's id, which utp.broadcast tunes; a tune changes the picture
// without touching the element. Placed over the preview slot, or full
// screen, by the player's own presentation helper.

const log = createLogger('BroadcastVideo');

export type BroadcastVideoStatus = 'idle' | 'connecting' | 'playing' | 'error';

// Playback events fire for the first channel only; past this, a tune that
// raised no error counts as playing.
const CONNECTING_GRACE_MS = 4000;
// The pipeline answers within a second on a 2025 TV.
const BROADCAST_ID_TIMEOUT_MS = 5000;
const BROADCAST_ID_POLL_MS = 100;

export class BroadcastVideo {
  private video: HTMLVideoElement | null = null;
  private status: BroadcastVideoStatus = 'idle';
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly presentation: PlayerPresentation;

  constructor(
    private readonly host: HTMLElement,
    getSlot: () => HTMLElement | null,
    private readonly onStatus: (status: BroadcastVideoStatus) => void,
  ) {
    this.presentation = new PlayerPresentation(() => this.video, getSlot);
  }

  get current(): BroadcastVideoStatus { return this.status; }

  // Opens the broadcast if needed and resolves its id, null when it never opens.
  async prepare(): Promise<string | null> {
    if (!this.video) this.attach();
    const deadline = Date.now() + BROADCAST_ID_TIMEOUT_MS;
    for (;;) {
      const id = this.broadcastId();
      // The id exists before the broadcast renders, and a tune before then
      // is refused; metadata marks it ready.
      if ((id && this.video && this.video.readyState >= 1) || this.status === 'error' || !this.video) return id;
      if (Date.now() > deadline) {
        log.warn('Broadcast never opened', 'event=satellite.video.no_broadcast');
        return null;
      }
      await new Promise(resolve => setTimeout(resolve, BROADCAST_ID_POLL_MS));
    }
  }

  private broadcastId(): string | null {
    const id = (this.video as (HTMLVideoElement & { mediaId?: unknown }) | null)?.mediaId;
    return typeof id === 'string' && id ? id : null;
  }

  // Call after each tune: shows the tuner output, attaching it on first use.
  start(): void {
    if (!this.video) this.attach();
    this.setStatus('connecting');
    this.clearGrace();
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      if (this.status === 'connecting') this.setStatus('playing');
    }, CONNECTING_GRACE_MS);
  }

  // Releases the broadcast pipeline, so the IPTV player can take the media
  // element: webOS plays one at a time.
  stop(): void {
    this.clearGrace();
    const video = this.video;
    this.video = null;
    if (video) {
      try {
        video.pause();
        while (video.firstChild) video.removeChild(video.firstChild);
        video.removeAttribute('src');
        video.load();
      } catch {
        // Releasing is best-effort; the element is dropped either way.
      }
      if (video.parentNode) video.parentNode.removeChild(video);
    }
    this.setStatus('idle');
  }

  showPreview(): void { this.presentation.showPreview(); }
  showFullscreen(): void { this.presentation.showFullscreen(); }
  refreshLayout(): void { this.presentation.refresh(); }

  private attach(): void {
    const video = document.createElement('video');
    video.className = 'sat-video';
    video.autoplay = true;
    const source = document.createElement('source');
    source.type = 'service/webos-broadcast';
    source.src = 'tv://';
    video.appendChild(source);
    video.addEventListener('playing', () => this.setStatus('playing'));
    video.addEventListener('loadeddata', () => this.setStatus('playing'));
    // A <source> error does not bubble; capture catches it on the element.
    video.addEventListener('error', (event) => {
      log.warn('Broadcast video failed', 'event=satellite.video.failed',
        `target=${event.target === video ? 'video' : 'source'}`);
      this.clearGrace();
      this.setStatus('error');
    }, true);
    this.host.insertBefore(video, this.host.firstChild);
    this.video = video;
    this.presentation.refresh();
    try {
      video.load();
      const played = video.play();
      if (played && typeof played.catch === 'function') played.catch(() => undefined);
    } catch {
      // The error listener reports what matters.
    }
  }

  private clearGrace(): void {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
  }

  private setStatus(status: BroadcastVideoStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.onStatus(status);
  }
}
