import type { AudioOption, ManifestAudio, ManifestClosedCaption, ManifestSubtitle, SubtitleOption } from '../types';
import { CONFIG } from '../config';
import { StorageService } from '../services/storage-service';
import { getCachedStreamMime, setCachedStreamMime } from '../services/idb-cache';
import { parseMpd, type MpdManifest } from '../parsers/mpd-manifest';
import {
  parseDrmConfig,
  isShakaDrmConfig,
  type PlayReadyConfig,
  type ShakaDrmConfig,
} from '../services/drm-config';
import { PlayReadyDrm } from '../services/playready-drm';
import { loadShaka, type ShakaNamespaceLike } from '../services/shaka-loader';
import { loadPlayerLibraries } from '../services/player-libs-loader';
import { parseAudioRenditions } from '../utils/audio-tracks';
import { FetchTextError, fetchLimitedText } from '../utils/fetch-helper';
import { getLenientLoaders } from '../utils/hls-stable-loader';
import { createLogger } from '../utils/logger';
import { isWebOS } from '../utils/platform';
import { playbackErrorDetail } from '../utils/playback-error';
import { matchingQuality, type QualityOption, type QualityState } from '../utils/playback-quality';
import { nativeHlsQualities, type NativeHlsQuality } from '../utils/native-hls-quality';
import { PlaybackBuffer } from '../utils/playback-buffer';
import { parseClosedCaptions, parseSubtitleRenditions } from '../utils/subtitle-tracks';
import { parseVariants, type StreamVariant } from '../utils/stream-info';
import { mediaOptionSourceType } from '../utils/webos-media-option';
import { createHlsEngine } from './mse/hls-engine';
import type { MseEngine, PipelineStreamInfo } from './mse/engine';
import { createShakaEngine, type ShakaPlayerLike } from './mse/shaka-engine';
import {
  containerMime,
  diagnosticStreamUrl,
  sniffStreamContentType,
  isMpdText,
  mpdOpeningVerdict,
  streamMime,
  streamRouteKey,
  streamUrlMime,
} from '../utils/url';

const log = createLogger('Player');


// Preview loads HLS/MPEG-TS eagerly; the TV loads them for manual switching.
// Shaka has its own lazy bundle.
const win = window as unknown as Record<string, unknown>;

type HlsType = typeof import('hls.js').default;
type MpegtsType = typeof import('mpegts.js').default;
export type PlaybackMode = 'native' | 'hls' | 'mpegts' | 'shaka';

interface ShakaError {
  category?: number;
  code?: number;
  data?: unknown[];
  severity?: number;
}

interface ShakaRequest {
  headers: Record<string, string>;
}

interface ShakaPlayerRuntime extends ShakaPlayerLike {
  addEventListener(type: string, listener: (event: Event) => void): void;
  attach(video: HTMLVideoElement): Promise<void>;
  configure(config: Record<string, unknown>): boolean;
  getNetworkingEngine(): {
    registerRequestFilter(filter: (type: number, request: ShakaRequest) => void): void;
  } | null;
  load(url: string): Promise<void>;
  getDrmInfo?(): { keySystem: string } | null;
}

function shakaErrorDetail(error: unknown): string {
  if (!error || typeof error !== 'object') return 'code=unknown';
  const detail = error as ShakaError;
  return `category=${typeof detail.category === 'number' ? detail.category : 'unknown'}`
    + ` code=${typeof detail.code === 'number' ? detail.code : 'unknown'}`;
}

function shakaPlaybackDetail(error: unknown): string {
  const detail = error as ShakaError | null;
  const nested = detail?.data?.[0] as ShakaError | undefined;
  return playbackErrorDetail('Shaka', {
    code: detail?.code,
    category: detail?.category,
    httpStatus: nested?.data?.[1] ?? detail?.data?.[1],
    message: error instanceof Error ? error : undefined,
  });
}

interface ShakaNamespace extends ShakaNamespaceLike {
  Player: {
    new(): ShakaPlayerRuntime;
    isBrowserSupported?: () => boolean;
  };
  net?: {
    NetworkingEngine?: {
      RequestType?: {
        LICENSE?: number;
      };
    };
  };
  util: {
    Error: {
      Severity: {
        CRITICAL: number;
      };
      Code?: {
        BAD_HTTP_STATUS?: number;
        LICENSE_REQUEST_FAILED?: number;
        LICENSE_RESPONSE_REJECTED?: number;
      };
    };
  };
}

function isPermanentShakaLicenseError(error: unknown, shaka: ShakaNamespace): boolean {
  const detail = error as ShakaError | null;
  const codes = shaka.util.Error.Code;
  if (!detail || !codes) return false;
  const responseRejected = codes.LICENSE_RESPONSE_REJECTED;
  const requestFailed = codes.LICENSE_REQUEST_FAILED;
  const badHttpStatus = codes.BAD_HTTP_STATUS;
  if (typeof responseRejected === 'number' && detail.code === responseRejected) return true;
  if (typeof requestFailed !== 'number' || detail.code !== requestFailed ||
      typeof badHttpStatus !== 'number') return false;
  const networkError = detail.data?.[0] as ShakaError | undefined;
  if (!networkError || networkError.code !== badHttpStatus) return false;
  const status = networkError.data?.[1];
  return status === 401 || status === 403;
}

export interface PipelineManifest {
  audio: ManifestAudio[];
  subtitles: ManifestSubtitle[];
  closedCaptions: ManifestClosedCaption[];
  variants: StreamVariant[];
  masterUrl: string;
}

export interface PlayerPipelineOptions {
  playbackLabel: (loadToken: number) => string;
  mediaState: (video: HTMLVideoElement) => string;
  isCatchup: () => boolean;
  onError: (reason?: 'unsupported', detail?: string) => void;
  onRecovering?: (detail: string) => void;
  onAudioTracksUpdated: () => void;
  onSubtitleTracksUpdated: () => void;
  onManifest: (manifest: PipelineManifest) => void;
  onEngineChanged?: (name: string) => void;
  onQualityChanged?: () => void;
  onBufferHolding?: (holding: boolean) => void;
}

export class PlayerPipeline {
  private videoEl: HTMLVideoElement | null = null;
  private hls: InstanceType<HlsType> | null = null;
  private mpegtsPlayer: { destroy(): void } | null = null;
  private engine: MseEngine | null = null;
  private engineTeardown: { promise: Promise<void>; label: string } | null = null;
  private msePending = false;
  private loadToken = 0;
  private hlsRecoveries = 0;
  private manifestSeq = 0;
  private manifestController: AbortController | null = null;
  private classificationController: AbortController | null = null;
  private videoLoadLabels = new WeakMap<HTMLVideoElement, string>();
  private playReadyDrm = new PlayReadyDrm();
  private activeDrm = '';
  private selectedMode: PlaybackMode | null = null;
  private activeMode: PlaybackMode = isWebOS() ? 'native' : 'hls';
  private detectedMime = '';
  private hlsUrl = '';
  private qualityChoice: QualityOption | null = null;
  private nativeQualities: NativeHlsQuality[] = [];
  private nativeMasterUrl = '';
  private nativeQualityLoading = false;
  private readonly buffer: PlaybackBuffer;
  private prebufferingEnabled = true;

  constructor(private callbacks: PlayerPipelineOptions) {
    this.buffer = new PlaybackBuffer({
      startupSeconds: CONFIG.PLAYER.START_BUFFER_SECONDS,
      recoverySeconds: CONFIG.PLAYER.REBUFFER_SECONDS,
      maxWaitMs: CONFIG.PLAYER.BUFFER_WAIT_MS,
      pollMs: CONFIG.PLAYER.BUFFER_POLL_MS,
      nativeGraceMs: CONFIG.PLAYER.NATIVE_BUFFER_GRACE_MS,
      onHolding: holding => this.callbacks.onBufferHolding?.(holding),
      onError: error => this.reportPlayRejection(error, this.loadToken),
    });
  }

  isPrebuffering(): boolean { return this.buffer.holding; }
  cancelPrebuffering(): void { this.buffer.cancelWait(); }
  resumePrebuffering(): void { this.buffer.release(); }
  confirmPlaying(): void { this.buffer.confirmPlaying(); }
  recoverBuffer(): boolean { return this.buffer.recover(); }

  private startBufferedPlayback(video: HTMLVideoElement, token: number, play = () => video.play()): void {
    if (token !== this.loadToken || video !== this.videoEl) return;
    if (this.prebufferingEnabled) {
      this.buffer.start(video, play, this.activeMode === 'native');
      return;
    }
    try {
      const playing = play();
      if (playing) void playing.catch(error => this.reportPlayRejection(error, token));
    } catch (error) { this.reportPlayRejection(error, token); }
  }

  resetMode(): void {
    this.selectedMode = null;
    this.detectedMime = '';
    this.hlsUrl = '';
    this.qualityChoice = null;
    this.nativeQualities = [];
    this.nativeMasterUrl = '';
    this.nativeQualityLoading = false;
    this.activeMode = isWebOS() ? 'native' : 'hls';
  }

  get engineName(): string {
    const mode = this.activeMode;
    return mode === 'native' ? (isWebOS() ? 'webOS' : 'HTML5')
      : mode === 'hls' ? 'hls.js' : mode === 'mpegts' ? 'mpegts.js' : 'Shaka';
  }

  isManualAlternative(): boolean {
    return this.selectedMode !== null && this.selectedMode !== 'native';
  }

  cycleMode(url: string, extras: Record<string, string> | null, alternativeHlsUrl = ''): void {
    const mime = streamUrlMime(url) || streamMime(this.detectedMime);
    const drm = parseDrmConfig(extras);
    const modes: PlaybackMode[] = drm?.type === 'playready' || drm?.type === 'unsupported'
      ? ['native']
      : isShakaDrmConfig(drm) ? ['shaka']
      : mime === 'application/dash+xml' ? ['native', 'shaka']
      : mime === 'application/vnd.apple.mpegurl' ? ['native', 'hls']
      : mime === 'video/mp2t' || mime === 'video/x-flv'
        ? (alternativeHlsUrl ? ['native', 'mpegts', 'hls'] : ['native', 'mpegts'])
      : mime && !mime.includes('octet-stream') ? ['native']
      : ['native', 'hls', 'mpegts'];
    const index = modes.indexOf(this.selectedMode ?? this.activeMode);
    this.selectedMode = modes[(index + 1) % modes.length];
    this.activeMode = this.selectedMode;
    this.hlsUrl = this.selectedMode === 'hls' ? alternativeHlsUrl : '';
    this.qualityChoice = null;
  }

  getQualityState(): QualityState {
    let options: QualityOption[] = this.hls ? (this.hls.levels ?? []).map((level, index) => ({
      index, width: level.width || 0, height: level.height || 0,
      bitrate: level.averageBitrate || level.bitrate || 0, frameRate: level.frameRate || 0,
    })) : this.engine?.qualityOptions?.() ?? [];
    if (this.activeMode === 'native') {
      options = this.nativeQualities.map(({ index, width, height, bitrate, frameRate, available }) => ({
        index, width, height, bitrate, frameRate, available,
      }));
    }
    if (!options.length && !this.msePending && (this.videoEl?.videoHeight ?? 0) > 0) {
      options = [{
        index: 0, width: this.videoEl!.videoWidth, height: this.videoEl!.videoHeight,
        bitrate: 0, frameRate: 0, available: false,
      }];
    }
    return {
      options,
      player: this.engineName,
      selected: matchingQuality(options, this.qualityChoice),
      loading: this.nativeQualityLoading || this.msePending || ((this.selectedMode === 'hls' || this.hls !== null)
        && this.hls !== null && !options.length),
    };
  }

  isNativeQualityControl(): boolean {
    return this.activeMode === 'native' && this.nativeQualities.some(option => option.available !== false);
  }

  selectQuality(index: number): boolean {
    if (!Number.isInteger(index) || index < -1) return false;
    const option = this.getQualityState().options.find(item => item.index === index);
    if (index !== -1 && (!option || option.available === false)) return false;
    try {
      if (this.hls) this.hls.nextLevel = index;
      else if (this.engine) {
        if (!this.engine.selectQuality?.(index)) return false;
      } else if (!this.isNativeQualityControl()) return false;
    } catch (error) {
      this.callbacks.onError(undefined, playbackErrorDetail(this.engineName, { message: error }));
      return false;
    }
    this.qualityChoice = option ?? null;
    this.callbacks.onQualityChanged?.();
    return true;
  }

  private setActiveMode(mode: PlaybackMode): void {
    this.activeMode = mode;
    this.callbacks.onEngineChanged?.(this.engineName);
  }

  private reportPlayRejection(error: unknown, token: number): void {
    if (token !== this.loadToken || !this.videoEl) return;
    const name = error && typeof error === 'object' ? (error as { name?: string }).name : '';
    if (name === 'AbortError') return;
    this.callbacks.onError(name === 'NotSupportedError' ? 'unsupported' : undefined,
      playbackErrorDetail(this.engineName, { type: name, message: error }));
  }

  setVideoElement(videoEl: HTMLVideoElement): void {
    if (this.videoEl !== videoEl) {
      this.buffer.stop();
      this.engineTeardown = null;
    }
    this.videoEl = videoEl;
  }

  currentLoadToken(): number {
    return this.loadToken;
  }

  videoLabel(el: HTMLVideoElement): string {
    return this.videoLoadLabels.get(el) ?? this.callbacks.playbackLabel(this.loadToken);
  }

  // "An MSE library owns the tracks" — hls.js in preview or Shaka on either path.
  isMseActive(): boolean {
    return this.engine !== null || this.mpegtsPlayer !== null || this.msePending;
  }

  mseAudioOptions(): AudioOption[] {
    return this.engine?.audioOptions() ?? [];
  }

  setMseAudioTrack(index: number): boolean {
    return this.engine?.setAudioTrack(index) ?? false;
  }

  mseSubtitleOptions(): SubtitleOption[] {
    return this.engine?.subtitleOptions() ?? [];
  }

  setMseSubtitleTrack(index: number): boolean {
    return this.engine?.setSubtitleTrack(index) ?? false;
  }

  streamInfo(): PipelineStreamInfo | null {
    return this.engine?.streamInfo() ?? null;
  }

  drmLabel(): string {
    return this.activeDrm;
  }

  load(url: string, extras: Record<string, string> | null, opts?: { direct?: boolean }): void {
    const videoEl = this.videoEl;
    if (!videoEl) return;
    const token = ++this.loadToken;
    const label = this.callbacks.playbackLabel(token);
    this.cancelManifest();
    this.destroyLoaders();
    this.prebufferingEnabled = StorageService.getPrebuffering();
    videoEl.autoplay = false;
    videoEl.preload = 'auto';
    this.videoLoadLabels.set(videoEl, label);
    this.playReadyDrm.release();
    this.activeDrm = '';

    const teardown = this.engineTeardown;
    const queuedAt = Date.now();
    const isCurrent = () => {
      if (token === this.loadToken && videoEl === this.videoEl) return true;
      if (teardown) {
        log.info('Queued playback cancelled', 'event=playback.mse.teardown.cancelled',
          label, `owner=(${teardown.label})`, `elapsedMs=${Date.now() - queuedAt}`,
          `reason=${token !== this.loadToken ? 'superseded' : 'video_replaced'}`);
      }
      return false;
    };
    const start = () => {
      if (!isCurrent()) return;
      if (teardown) {
        log.info('Playback resuming after MSE teardown', 'event=playback.mse.teardown.resumed',
          label, `owner=(${teardown.label})`, `elapsedMs=${Date.now() - queuedAt}`);
      }
      this.msePending = false;
      this.loadSource(url, extras, token, opts);
    };
    if (teardown) {
      this.msePending = true;
      log.info('Playback waiting for MSE teardown', 'event=playback.mse.teardown.wait',
        label, `owner=(${teardown.label})`);
      void teardown.promise.then(start, error => {
        if (!isCurrent()) return;
        this.msePending = false;
        log.warn('Playback blocked by failed MSE teardown',
          'event=playback.mse.teardown.blocked', label, `owner=(${teardown.label})`,
          `elapsedMs=${Date.now() - queuedAt}`, shakaErrorDetail(error));
        this.callbacks.onError(undefined, playbackErrorDetail(this.engineName, { message: error }));
      });
    } else {
      start();
    }
  }

  private loadSource(
    url: string,
    extras: Record<string, string> | null,
    token: number,
    opts?: { direct?: boolean },
  ): void {
    const videoEl = this.videoEl;
    if (!videoEl) return;
    if (this.selectedMode === 'hls' && this.hlsUrl) url = this.hlsUrl;
    const safeUrl = diagnosticStreamUrl(url);
    const urlMime = streamUrlMime(url);
    const isTsUrl = urlMime === 'video/mp2t';
    const isFlvUrl = urlMime === 'video/x-flv';
    const isHlsUrl = urlMime === 'application/vnd.apple.mpegurl';
    const isDashUrl = urlMime === 'application/dash+xml';

    if (this.selectedMode && this.selectedMode !== 'native') {
      const mode = this.selectedMode;
      this.setActiveMode(mode);
      if (mode === 'shaka') {
        const drm = parseDrmConfig(extras);
        this.loadWithShaka(url, token, isShakaDrmConfig(drm) ? drm : null);
        return;
      }
      this.msePending = true;
      void loadPlayerLibraries().then(() => {
        if (token !== this.loadToken || !this.videoEl) return;
        this.msePending = false;
        if (mode === 'hls') this.loadWithHls(url, extras, token);
        else this.loadWithMpegts(url, isFlvUrl, token);
      }).catch(error => {
        if (token !== this.loadToken || !this.videoEl) return;
        this.msePending = false;
        this.callbacks.onError('unsupported', playbackErrorDetail(this.engineName, { message: error }));
      });
      return;
    }

    // webOS: the TV's hardware HLS/TS decoders beat MSE libraries, so play
    // natively. Explicit extensions and previously verified routes avoid a
    // probe; only a cold ambiguous route pays the bounded classification cost.
    if (isWebOS() || this.selectedMode === 'native') {
      if (this.qualityChoice && this.nativeMasterUrl === url && this.isNativeQualityControl()) {
        void this.loadManifest(url, this.manifestSeq, token).then(() => {
          if (token !== this.loadToken || !this.videoEl) return;
          const index = matchingQuality(this.nativeQualities, this.qualityChoice);
          const variant = this.nativeQualities.find(option => option.index === index && option.available !== false);
          if (!variant) this.qualityChoice = null;
          this.playNativeMime(variant?.url ?? url, 'application/vnd.apple.mpegurl');
          this.callbacks.onQualityChanged?.();
        });
        return;
      }
      if (opts?.direct) {
        const mime = containerMime(url);
        log.info('Selected webOS native playback', 'event=playback.path.native',
          this.callbacks.playbackLabel(token),
          'reason=direct', 'url=', safeUrl,
          '| webOS native VOD | MIME', mime || '(sniffed)');
        this.playNative(url, mime);
        return;
      }
      if (isTsUrl || isFlvUrl || isHlsUrl || isDashUrl) {
        const mime = isFlvUrl ? 'video/x-flv'
          : isTsUrl ? 'video/mp2t'
          : isDashUrl ? 'application/dash+xml'
          : 'application/vnd.apple.mpegurl';
        log.info('Selected webOS native playback', 'event=playback.path.native',
          this.callbacks.playbackLabel(token),
          'reason=url', 'url=', safeUrl,
          '| webOS native | catchup:', this.callbacks.isCatchup(), '| MIME', mime);
        if (isDashUrl) {
          this.loadNativeDash(url, extras, token);
          return;
        }
        if (isHlsUrl) {
          void this.loadManifest(url, this.manifestSeq, token);
        }
        this.playNativeMime(url, mime);
        return;
      }
      const routeKey = streamRouteKey(url);
      void getCachedStreamMime(routeKey).then(cachedMime => {
        if (token !== this.loadToken || !this.videoEl) return;
        if (cachedMime) {
          log.info('Selected webOS native playback', 'event=playback.path.native',
            this.callbacks.playbackLabel(token),
            'reason=cache', 'url=', safeUrl,
            '| webOS native | cached MIME', cachedMime,
            '| catchup:', this.callbacks.isCatchup());
          if (cachedMime === 'application/vnd.apple.mpegurl') {
            void this.loadManifest(url, this.manifestSeq, token);
          } else if (cachedMime === 'application/dash+xml') {
            this.loadNativeDash(url, extras, token);
            return;
          }
          this.playNativeMime(url, cachedMime);
          return;
        }
        void this.detectContentType(url, token).then(contentType => {
          if (token !== this.loadToken || !this.videoEl) return;
          const mime = streamMime(contentType);
          if (routeKey && contentType &&
              contentType.split(';')[0].trim() !== 'application/octet-stream') {
            void setCachedStreamMime(routeKey, mime);
          }
          log.info('Selected webOS native playback', 'event=playback.path.native',
            this.callbacks.playbackLabel(token),
            'reason=probe', 'url=', safeUrl,
            '| webOS native | content-type:', contentType || '(none)',
            '| catchup:', this.callbacks.isCatchup(), '| MIME', mime || '(auto)');
          if (mime === 'application/vnd.apple.mpegurl') {
            void this.loadManifest(url, this.manifestSeq, token);
          } else if (mime === 'application/dash+xml') {
            this.loadNativeDash(url, extras, token);
            return;
          }
          this.playNativeMime(url, mime);
        });
      });
      return;
    }

    // Desktop preview: native HLS is unreliable across Chrome/Firefox/Linux, so
    // always route through hls.js/mpegts.js. URL extensions lie — some providers
    // serve HLS with no .m3u8 suffix — so classify by the server's Content-Type,
    // falling back to the URL and defaulting to HLS.
    if (opts?.direct) {
      log.info('Selected direct playback', 'event=playback.path.direct',
        this.callbacks.playbackLabel(token),
        'reason=direct', 'url=', safeUrl, '| desktop direct VOD');
      videoEl.src = url;
      this.startBufferedPlayback(videoEl, token);
      return;
    }
    void this.detectContentType(url, token).then(ct => {
      if (token !== this.loadToken || !this.videoEl) return;
      const isFlv = isFlvUrl || ct.includes('flv');
      const isTs = isTsUrl || ct.includes('mp2t');
      const isDash = !isTs && !isFlv &&
        (isDashUrl || ct.includes('dash+xml') || ct.includes('dash.mpd'));
      const isDirect = !isTs && !isFlv && !isDash && /^(?:video|audio)\//.test(ct);
      const isHls = !isTs && !isFlv && !isDash && !isDirect;
      log.info('loadStream', this.callbacks.playbackLabel(token), 'url=', safeUrl,
        '| content-type:', ct || '(none)', '| catchup:', this.callbacks.isCatchup(),
        '| isHls:', isHls, '| isTs:', isTs, '| isFlv:', isFlv, '| isDash:', isDash);
      if (isTs || isFlv) {
        log.info('Selected mpegts.js playback', 'event=playback.path.mpegts',
          this.callbacks.playbackLabel(token),
          'reason=probe');
        this.loadWithMpegts(url, isFlv, token);
      } else if (isDash) {
        log.info('Selected Shaka playback', 'event=playback.path.dash',
          this.callbacks.playbackLabel(token),
          'reason=probe');
        const configured = parseDrmConfig(extras);
        if (configured?.type === 'unsupported') {
          log.warn('Unsupported DASH DRM', 'event=playback.dash.drm.unsupported',
            this.callbacks.playbackLabel(token), `type=${configured.value}`);
          this.callbacks.onError('unsupported', playbackErrorDetail('DRM', { details: configured.value }));
          return;
        }
        this.loadWithShaka(
          url,
          token,
          isShakaDrmConfig(configured) ? configured : null,
        );
      } else if (isDirect) {
        log.info('Selected direct playback', 'event=playback.path.direct',
          this.callbacks.playbackLabel(token),
          'reason=probe');
        this.videoEl.src = url;
        this.startBufferedPlayback(this.videoEl, token);
      } else {
        log.info('Selected hls.js playback', 'event=playback.path.hls',
          this.callbacks.playbackLabel(token),
          'reason=probe');
        this.loadWithHls(url, extras, token);
      }
    });
  }

  destroy(): void {
    // Invalidate an in-flight content-type probe before tearing down loaders.
    // Its fetch may not be abortable on every target, so the load token is the
    // final guard against restarting playback after stop/suspend.
    this.loadToken++;
    this.cancelManifest();
    this.destroyLoaders();
    this.playReadyDrm.release();
    this.activeDrm = '';
  }

  private destroyLoaders(): void {
    this.buffer.stop();
    this.msePending = false;
    // The engine owns its library instance, hls.js included.
    if (this.engine) {
      const engine = this.engine;
      const label = this.videoEl ? this.videoLabel(this.videoEl)
        : this.callbacks.playbackLabel(this.loadToken);
      const source = this.hls ? 'hls' : 'shaka';
      const startedAt = Date.now();
      log.info('Destroying MSE engine', 'event=playback.mse.destroy.started',
        label, `source=${source}`);
      this.engine = null;
      const teardown = engine.destroy();
      const completed = () => {
        log.info('MSE engine destroyed', 'event=playback.mse.destroy.completed',
          label, `source=${source}`, `elapsedMs=${Date.now() - startedAt}`);
      };
      if (teardown) {
        const pending = { promise: teardown, label };
        this.engineTeardown = pending;
        void teardown.then(() => {
          if (this.engineTeardown === pending) this.engineTeardown = null;
          completed();
        }, error => {
          // A failed teardown keeps this element blocked until it is replaced.
          log.warn('MSE engine teardown failed', 'event=playback.mse.destroy.failed',
            label, `source=${source}`, `elapsedMs=${Date.now() - startedAt}`,
            shakaErrorDetail(error));
        });
      } else {
        completed();
      }
    }
    this.hls = null;
    if (this.mpegtsPlayer) {
      this.mpegtsPlayer.destroy();
      this.mpegtsPlayer = null;
    }
  }

  // Classify a stream by the server's Content-Type — URL extensions are
  // unreliable for proxied/extension-less streams, so the response header is the
  // real signal. Headers are enough, so cancel the body. Returns '' on a
  // CORS/network failure, leaving the caller on its URL heuristic (default HLS).
  private async detectContentType(url: string, loadToken: number): Promise<string> {
    const controller = new AbortController();
    this.classificationController?.abort();
    this.classificationController = controller;
    const timer = setTimeout(() => controller.abort(), CONFIG.PLAYER.MANIFEST_TIMEOUT);
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      const res = await fetch(url, { signal: controller.signal });
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (loadToken === this.loadToken) this.detectedMime = ct.split(';')[0].trim();
      const baseType = ct.split(';')[0].trim();
      const sniffBody = baseType === 'application/octet-stream'
        || baseType === 'application/xml'
        || baseType === 'text/xml';
      if (!sniffBody) {
        res.body?.cancel().catch(() => {});
        return ct;
      }
      reader = res.body?.getReader() ?? null;
      if (!reader) return ct;
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (length < 4096) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value?.length) continue;
        const kept = new Uint8Array(Math.min(value.length, 4096 - length));
        kept.set(value.subarray(0, kept.length));
        chunks.push(kept);
        length += kept.length;
      }
      const prefix = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        prefix.set(chunk, offset);
        offset += chunk.length;
      }
      const detected = sniffStreamContentType(ct, prefix);
      if (loadToken === this.loadToken) this.detectedMime = detected.split(';')[0].trim();
      return detected;
    } catch (error) {
      if (loadToken !== this.loadToken || !this.videoEl) return '';
      log.warn('Content-type classification failed', 'event=playback.classify.failed',
        this.callbacks.playbackLabel(loadToken),
        error instanceof Error ? error.name : 'Error');
      return '';
    } finally {
      if (reader) void reader.cancel().catch(() => {});
      controller.abort();
      if (this.classificationController === controller) this.classificationController = null;
      clearTimeout(timer);
    }
  }

  // DASH keeps application/dash+xml for classification and uses mediaOption on
  // the source element to select the native MPEG-DASH transport.
  private playNativeMime(url: string, mime: string): void {
    this.detectedMime = mime;
    if (mime === 'application/dash+xml') {
      this.playNativeDash(url);
      return;
    }
    this.playNative(url, mime);
  }

  private playNativeDash(url: string, clientId = ''): void {
    const bare = CONFIG.PLAYER.DASH_SOURCE === 'bare';
    const type = bare && !clientId
      ? ''
      : mediaOptionSourceType('video/mp4', {
        mediaTransportType: 'MPEG-DASH',
        ...(clientId ? {
          option: { drm: { type: 'playready' as const, clientId } },
        } : {}),
      });
    log.info('Native DASH source', 'event=playback.path.native.dash',
      this.callbacks.playbackLabel(this.loadToken),
      `hint=${bare && !clientId ? 'none' : 'mediaOption'}`,
      `drm=${clientId ? 'playready' : 'none'}`);
    this.playNative(url, type);
  }

  private loadNativeDash(
    url: string,
    extras: Record<string, string> | null,
    loadToken: number,
  ): void {
    this.detectedMime = 'application/dash+xml';
    const seq = this.manifestSeq;
    const configured = parseDrmConfig(extras);
    void this.loadManifest(url, seq, loadToken, 'dash', parsed => {
      if (isShakaDrmConfig(configured)
          || (!configured && (parsed?.drm?.type === 'widevine' || parsed?.drm?.type === 'clearkey'))) {
        this.msePending = true;
      }
    }).then(parsed => {
      if (loadToken !== this.loadToken || !this.videoEl) return;
      const detected = parsed?.drm;
      if (configured?.type === 'unsupported' || (!configured && detected?.type === 'unsupported')) {
        const value = configured?.type === 'unsupported' ? configured.value : detected?.scheme;
        log.warn('Unsupported native DASH DRM', 'event=playback.dash.drm.unsupported',
          this.callbacks.playbackLabel(loadToken), `type=${value || 'unknown'}`);
        this.callbacks.onError('unsupported', playbackErrorDetail('DRM', { details: value }));
        return;
      }
      if (isShakaDrmConfig(configured)
          || (!configured && (detected?.type === 'widevine' || detected?.type === 'clearkey'))) {
        const defaults = { licenseUrl: '', headers: {}, unsupportedOptions: [] };
        const config: ShakaDrmConfig = isShakaDrmConfig(configured)
          ? configured
          : detected?.type === 'clearkey'
            ? { ...defaults, type: 'clearkey', clearKeys: {} }
            : { ...defaults, type: 'widevine' };
        this.loadWithShaka(url, loadToken, config);
        return;
      }
      if (configured?.type !== 'playready' && detected?.type !== 'playready') {
        this.playNativeDash(url);
        return;
      }
      const config: PlayReadyConfig = configured?.type === 'playready'
        ? configured
        : {
            type: 'playready',
            licenseUrl: '',
            customData: '',
            unsupportedOptions: [],
          };
      if (config.unsupportedOptions.length) {
        log.warn('Ignoring unsupported native PlayReady options',
          'event=playback.dash.drm.options.unsupported',
          this.callbacks.playbackLabel(loadToken),
          `options=${config.unsupportedOptions.join(',')}`);
      }
      void this.playReadyDrm.prepare(config, response => {
        if (loadToken !== this.loadToken) return;
        log.warn('PlayReady rights error', 'event=playback.dash.drm.rights',
          this.callbacks.playbackLabel(loadToken),
          `state=${String(response.errorState ?? '')}`);
        this.callbacks.onError('unsupported', playbackErrorDetail('PlayReady', { details: String(response.errorState ?? '') }));
      }).then(clientId => {
        if (!clientId || loadToken !== this.loadToken || !this.videoEl) return;
        log.info('PlayReady DRM ready', 'event=playback.dash.drm.ready',
          this.callbacks.playbackLabel(loadToken));
        this.activeDrm = 'PlayReady';
        this.playNativeDash(url, clientId);
      }).catch(error => {
        if (loadToken !== this.loadToken) return;
        log.warn('PlayReady setup failed', 'event=playback.dash.drm.failed',
          this.callbacks.playbackLabel(loadToken), error);
        this.callbacks.onError('unsupported', playbackErrorDetail('PlayReady', { message: error }));
      });
    });
  }

  private playNative(url: string, mime: string): void {
    const videoEl = this.videoEl;
    if (!videoEl) return;
    this.setActiveMode('native');
    // A <source> with an explicit MIME tells the player the format even when the
    // URL has no file extension.
    videoEl.removeAttribute('src');
    while (videoEl.firstChild) videoEl.removeChild(videoEl.firstChild);
    const source = document.createElement('source');
    source.src = url;
    if (mime) source.type = mime;
    videoEl.appendChild(source);
    videoEl.load();
    const token = this.loadToken;
    this.startBufferedPlayback(videoEl, token);
  }

  private loadWithHls(
    url: string,
    extras: Record<string, string> | null,
    loadToken: number,
  ): void {
    if (!this.videoEl) return;
    const Hls = win.__Hls as HlsType | undefined;
    try {
      if (!Hls?.isSupported()) {
        if (this.selectedMode === 'hls') { this.callbacks.onError('unsupported'); return; }
        log.warn('hls.js unsupported; using direct playback',
            'event=playback.path.direct', this.callbacks.playbackLabel(loadToken),
            'reason=hls-unsupported');
        this.videoEl.src = url;
        this.startBufferedPlayback(this.videoEl, loadToken);
        return;
      }
      const hlsConfig: Record<string, unknown> = {
        maxBufferLength: CONFIG.PLAYER.BUFFER_LENGTH,
        maxMaxBufferLength: CONFIG.PLAYER.BUFFER_LENGTH,
        maxBufferSize: CONFIG.PLAYER.BUFFER_BYTES,
        backBufferLength: CONFIG.PLAYER.BACK_BUFFER_SECONDS,
        ...(this.prebufferingEnabled ? {
          lowLatencyMode: false,
          liveSyncDurationCount: 4,
          maxLiveSyncPlaybackRate: 1,
          abrEwmaDefaultEstimate: CONFIG.PLAYER.START_BANDWIDTH,
        } : {}),
        enableWorker: typeof Worker === 'function',
      };

      // Stable-URI loaders so a rotating-URL live window doesn't trip hls.js.
      const loaders = getLenientLoaders(Hls);
      hlsConfig.pLoader = loaders.pLoader;
      hlsConfig.fLoader = loaders.fLoader;
      if (extras?.['http-user-agent']) {
        hlsConfig.xhrSetup = (xhr: XMLHttpRequest) => {
          xhr.setRequestHeader('User-Agent', extras['http-user-agent']);
        };
      }
      this.hlsRecoveries = 0;
      this.setActiveMode('hls');
      const hls = new Hls(hlsConfig);
      this.hls = hls;
      this.engine = createHlsEngine(hls);
      hls.loadSource(url);
      hls.attachMedia(this.videoEl);
      // The audio/subtitle track lists aren't ready at MANIFEST_PARSED — hls.js
      // fills them and fires their *_TRACKS_UPDATED events separately, so apply
      // the saved picks there.
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => {
        if (loadToken === this.loadToken) this.callbacks.onAudioTracksUpdated();
      });
      hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => {
        if (loadToken === this.loadToken) this.callbacks.onSubtitleTracksUpdated();
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (loadToken !== this.loadToken) return;
        const index = this.getQualityState().selected;
        if (index < 0) this.qualityChoice = null;
        hls.loadLevel = index;
        this.callbacks.onQualityChanged?.();
        log.info('hls.js manifest parsed; starting playback',
          'event=playback.manifest.parsed', this.callbacks.playbackLabel(loadToken),
          'path=hls');
        if (this.videoEl) this.startBufferedPlayback(this.videoEl, loadToken);
      });
      hls.on(Hls.Events.LEVELS_UPDATED, () => {
        if (loadToken !== this.loadToken) return;
        const index = this.getQualityState().selected;
        if (index < 0) this.qualityChoice = null;
        hls.nextLevel = index;
        this.callbacks.onQualityChanged?.();
      });
      // A good fragment played: the stream recovered, so refill the retry budget.
      hls.on(Hls.Events.FRAG_BUFFERED, () => { this.hlsRecoveries = 0; });
      // Bounded recovery: retry transient network/media errors (and rotating-URL
      // re-fetches) a few times, but give up on a genuinely dead stream so it
      // surfaces an error instead of retrying forever.
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (loadToken !== this.loadToken) return;
        log.warn('hls.js error', 'event=playback.hls.error',
          this.callbacks.playbackLabel(loadToken),
          { type: data.type, details: data.details, fatal: data.fatal });
        if (!data.fatal) return;
        const detail = playbackErrorDetail('hls.js', {
          type: data.type, details: data.details,
          httpStatus: data.response?.code, message: data.error,
        });
        if (this.hlsRecoveries >= CONFIG.PLAYER.HLS_MAX_RECOVERIES) {
          this.callbacks.onError(undefined, detail);
          return;
        }
        this.hlsRecoveries++;
        const n = `${this.hlsRecoveries}/${CONFIG.PLAYER.HLS_MAX_RECOVERIES}`;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          this.callbacks.onRecovering?.(`${detail} | ${n}`);
          log.info('Restarting hls.js after a fatal network error',
            'event=playback.hls.recover.network',
            this.callbacks.playbackLabel(loadToken), n);
          this.hls?.startLoad();
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          this.callbacks.onRecovering?.(`${detail} | ${n}`);
          log.info('Recovering hls.js after a fatal media error',
            'event=playback.hls.recover.media',
            this.callbacks.playbackLabel(loadToken), n);
          this.hls?.recoverMediaError();
        } else {
          this.callbacks.onError(undefined, detail);
        }
      });
    } catch (error) {
      if (this.selectedMode === 'hls') {
        this.callbacks.onError('unsupported', playbackErrorDetail('hls.js', { message: error }));
        return;
      }
      log.warn('hls.js initialization failed; using direct playback',
        'event=playback.hls.init.failed', this.callbacks.playbackLabel(loadToken), error);
      this.videoEl.src = url;
      this.startBufferedPlayback(this.videoEl, loadToken);
    }
  }

  private loadWithShaka(
    url: string,
    loadToken: number,
    drm: ShakaDrmConfig | null = null,
  ): void {
    if (!this.videoEl) return;
    this.setActiveMode('shaka');
    this.msePending = true;
    const label = this.callbacks.playbackLabel(loadToken);
    const startedAt = Date.now();
    log.info('Initializing Shaka', 'event=playback.dash.init.started',
      label, `drm=${drm?.type || 'none'}`);
    void loadShaka().then(loaded => {
      if (loadToken !== this.loadToken || !this.videoEl) return;
      const shaka = loaded as ShakaNamespace;
      const videoEl = this.videoEl;
      const player = new shaka.Player();
      const engine = createShakaEngine(player);
      this.engine = engine;
      this.msePending = false;
      const config: Record<string, unknown> = {
        streaming: {
          bufferingGoal: CONFIG.PLAYER.BUFFER_LENGTH,
          bufferBehind: CONFIG.PLAYER.BACK_BUFFER_SECONDS,
          ...(this.prebufferingEnabled ? {
            rebufferingGoal: CONFIG.PLAYER.REBUFFER_SECONDS,
            lowLatencyMode: false,
            stopFetchingOnPause: false,
          } : {}),
        },
        ...(this.prebufferingEnabled ? { abr: { defaultBandwidthEstimate: CONFIG.PLAYER.START_BANDWIDTH } } : {}),
      };
      if (drm) {
        const keySystem = drm.type === 'clearkey' ? 'org.w3.clearkey' : 'com.widevine.alpha';
        config.drm = {
          preferredKeySystems: [keySystem],
          servers: drm.licenseUrl
            ? { [keySystem]: drm.licenseUrl }
            : {},
          ...(drm.type === 'clearkey' && Object.keys(drm.clearKeys).length
            ? { clearKeys: drm.clearKeys } : {}),
        };
        const licenseType =
          shaka.net?.NetworkingEngine?.RequestType?.LICENSE;
        const networking = player.getNetworkingEngine();
        if (Object.keys(drm.headers).length && (licenseType === undefined || !networking)) {
          throw new Error('Shaka license request filters are unavailable');
        }
        if (licenseType !== undefined && networking && Object.keys(drm.headers).length) {
          networking.registerRequestFilter((type, request) => {
            if (type !== licenseType) return;
            for (const name in drm.headers) {
              request.headers[name] = drm.headers[name];
            }
          });
        }
        if (drm.unsupportedOptions.length) {
          log.warn('Ignoring unsupported Shaka DRM options',
            'event=playback.dash.drm.options.unsupported',
            this.callbacks.playbackLabel(loadToken),
            `options=${drm.unsupportedOptions.join(',')}`);
        }
      }
      if (!player.configure(config)) {
        log.warn('Shaka rejected configuration', 'event=playback.dash.drm.failed',
          this.callbacks.playbackLabel(loadToken));
        throw new Error('Shaka configuration rejected');
      }
      const notifyAudioTracks = (event: Event) => {
        if (loadToken === this.loadToken && this.engine === engine) {
          const info = engine.streamInfo();
          log.info('Shaka variant changed', 'event=playback.dash.variant.changed',
            label, `reason=${event.type}`,
            `width=${videoEl.videoWidth} height=${videoEl.videoHeight}`,
            `videoCodec=${info?.videoCodec || 'unknown'}`,
            `audioCodec=${info?.audioCodec || 'unknown'}`,
            `videoRange=${info?.videoRange || 'unknown'}`,
            `frameRate=${info?.frameRate || 0}`,
            `audioChannels=${info?.audioChannels || 'unknown'}`,
            `audioAtmos=${info?.audioAtmos === true}`,
            this.callbacks.mediaState(videoEl));
          this.callbacks.onAudioTracksUpdated();
          this.callbacks.onQualityChanged?.();
        }
      };
      player.addEventListener('adaptation', notifyAudioTracks);
      player.addEventListener('variantchanged', notifyAudioTracks);
      const notifyTextTracks = () => {
        if (loadToken === this.loadToken && this.engine === engine) {
          this.callbacks.onSubtitleTracksUpdated();
        }
      };
      player.addEventListener('textchanged', notifyTextTracks);
      player.addEventListener('texttrackvisibility', notifyTextTracks);

      let reportedCriticalError = false;
      const reportCriticalError = (error: unknown) => {
        if (reportedCriticalError || loadToken !== this.loadToken) return;
        reportedCriticalError = true;
        log.warn('Shaka critical error', 'event=playback.dash.error',
          this.callbacks.playbackLabel(loadToken), shakaErrorDetail(error));
        if (isPermanentShakaLicenseError(error, shaka)) {
          this.callbacks.onError('unsupported', shakaPlaybackDetail(error));
        } else {
          this.callbacks.onError(undefined, shakaPlaybackDetail(error));
        }
      };
      player.addEventListener('error', event => {
        if (loadToken !== this.loadToken || this.engine !== engine) return;
        const error = (event as CustomEvent<ShakaError>).detail;
        log.warn('Shaka error', 'event=playback.dash.error',
          this.callbacks.playbackLabel(loadToken), shakaErrorDetail(error));
        if (error?.severity === shaka.util.Error.Severity.CRITICAL) {
          reportCriticalError(error);
        } else {
          this.callbacks.onRecovering?.(shakaPlaybackDetail(error));
        }
      });

      void player.attach(videoEl).then(() => {
        if (loadToken !== this.loadToken || this.engine !== engine) return;
        log.info('Shaka attached; loading stream', 'event=playback.dash.load.started',
          label, `elapsedMs=${Date.now() - startedAt}`);
        return player.load(url);
      }).then(() => {
        if (loadToken !== this.loadToken || this.engine !== engine) return;
        const keySystem = player.getDrmInfo?.()?.keySystem;
        this.activeDrm = drm?.type === 'clearkey' || (!drm && keySystem === 'org.w3.clearkey')
          ? 'ClearKey'
          : drm?.type === 'widevine' || keySystem === 'com.widevine.alpha' ? 'Widevine' : '';
        log.info('Shaka stream loaded', 'event=playback.dash.load.completed',
          label, `elapsedMs=${Date.now() - startedAt}`,
          `keySystem=${keySystem || 'none'}`, `mediaKeys=${Boolean(videoEl.mediaKeys)}`,
          this.callbacks.mediaState(videoEl));
        if (this.activeDrm) {
          log.info('Shaka DRM ready', 'event=playback.dash.drm.ready',
            `drm=${this.activeDrm}`,
            this.callbacks.playbackLabel(loadToken));
        }
        this.callbacks.onAudioTracksUpdated();
        this.callbacks.onSubtitleTracksUpdated();
        const quality = matchingQuality(engine.qualityOptions?.() ?? [], this.qualityChoice);
        if (quality < 0) this.qualityChoice = null;
        engine.selectQuality?.(quality);
        this.callbacks.onQualityChanged?.();
        this.startBufferedPlayback(videoEl, loadToken);
      }).catch(error => {
        if (loadToken !== this.loadToken || this.engine !== engine) return;
        this.destroyLoaders();
        reportCriticalError(error);
      });
    }).catch(error => {
      if (loadToken !== this.loadToken) return;
      this.msePending = false;
      this.destroyLoaders();
      log.warn('Shaka initialization failed',
        'event=playback.dash.init.failed', this.callbacks.playbackLabel(loadToken), shakaErrorDetail(error));
      this.callbacks.onError(undefined, shakaPlaybackDetail(error));
    });
  }

  private loadWithMpegts(url: string, isFlv: boolean, loadToken: number): void {
    if (!this.videoEl) return;
    const mpegts = win.__mpegts as MpegtsType | undefined;
    try {
      if (!mpegts?.isSupported()) {
        if (this.selectedMode === 'mpegts') { this.callbacks.onError('unsupported'); return; }
      log.warn('mpegts.js unsupported; using direct playback',
        'event=playback.path.direct', this.callbacks.playbackLabel(loadToken),
        'reason=mpegts-unsupported');
      this.videoEl.src = url;
        this.startBufferedPlayback(this.videoEl, loadToken);
        return;
      }
      this.setActiveMode('mpegts');
      const player = mpegts.createPlayer({
        type: isFlv ? 'flv' : 'mpegts',
        isLive: !this.callbacks.isCatchup(),
        url,
      }, {
        enableWorker: typeof Worker === 'function',
        enableStashBuffer: this.prebufferingEnabled,
        ...(this.prebufferingEnabled ? {
          stashInitialSize: 256 * 1024,
          liveBufferLatencyChasing: false,
          liveSync: false,
          lazyLoad: true,
          lazyLoadMaxDuration: CONFIG.PLAYER.BUFFER_LENGTH,
          lazyLoadRecoverDuration: CONFIG.PLAYER.REBUFFER_SECONDS + 4,
        } : {}),
        autoCleanupSourceBuffer: true,
        autoCleanupMaxBackwardDuration: CONFIG.PLAYER.BACK_BUFFER_SECONDS * 2,
        autoCleanupMinBackwardDuration: CONFIG.PLAYER.BACK_BUFFER_SECONDS,
      });
      this.mpegtsPlayer = player;
      player.on(mpegts.Events.ERROR, (type: string, details: string, info?: { code?: number; msg?: string }) => {
        if (loadToken !== this.loadToken) return;
        log.error('mpegts.js playback error', 'event=playback.mpegts.error',
          this.callbacks.playbackLabel(loadToken));
        this.callbacks.onError(undefined, playbackErrorDetail('mpegts.js', {
          type, details, code: info?.code, message: info?.msg,
          httpStatus: details === mpegts.ErrorDetails.NETWORK_STATUS_CODE_INVALID ? info?.code : undefined,
        }));
      });
      player.attachMediaElement(this.videoEl);
      player.load();
      this.startBufferedPlayback(this.videoEl, loadToken, () => player.play() ?? Promise.resolve());
    } catch (error) {
      if (this.selectedMode === 'mpegts') {
        this.callbacks.onError('unsupported', playbackErrorDetail('mpegts.js', { message: error }));
        return;
      }
      log.warn('mpegts.js initialization failed; using direct playback',
        'event=playback.mpegts.init.failed', this.callbacks.playbackLabel(loadToken), error);
      this.videoEl.src = url;
      this.startBufferedPlayback(this.videoEl, loadToken);
    }
  }

  // Fetch the HLS master once and parse its audio + subtitle rendition names so
  // the pickers, toasts and per-channel memory show real labels instead of
  // "Audio 2" / "Subtitle 2". Native audio/text tracks carry no usable
  // name/language on webOS, so this is the only source. The Player re-applies
  // saved picks when the parsed manifest is delivered.
  private async loadManifest(
    url: string, seq: number, loadToken: number, format: 'hls' | 'dash' = 'hls',
    beforeNotify?: (manifest: MpdManifest | null) => void,
  ): Promise<MpdManifest | null> {
    const dash = format === 'dash';
    const controller = new AbortController();
    const started = Date.now();
    this.nativeQualityLoading = true;
    this.manifestController?.abort();
    this.manifestController = controller;
    try {
      let responseUrl = url;
      const text = await fetchLimitedText(
        url,
        dash ? CONFIG.PLAYER.MPD_MAX_BYTES : CONFIG.PLAYER.MANIFEST_MAX_BYTES,
        CONFIG.PLAYER.MANIFEST_TIMEOUT,
        controller.signal,
        dash ? mpdOpeningVerdict : '#EXTM3U',
        resolved => { responseUrl = resolved; },
      );
      if (seq !== this.manifestSeq) return null;
      if (dash && !isMpdText(text)) {
        throw new FetchTextError('invalid_content', 'Response is not an MPD');
      }
      log.debug('Manifest fetched', 'event=playback.manifest.fetched',
        this.callbacks.playbackLabel(loadToken),
        `format=${format} bytes=${String(text.length)} elapsed=${String(Date.now() - started)}ms`);
      const parsed = dash ? parseMpd(text, responseUrl) : null;
      beforeNotify?.(parsed);
      const audio = parsed ? parsed.audio : parseAudioRenditions(text);
      const subtitles = parsed ? parsed.subtitles : parseSubtitleRenditions(text);
      const closedCaptions = parsed ? parsed.closedCaptions : parseClosedCaptions(text);
      const variants = parsed ? parsed.variants : parseVariants(text);
      this.nativeMasterUrl = url;
      this.nativeQualities = parsed ? variants.map((variant, index) => ({
        index, width: variant.width, height: variant.height, bitrate: 0,
        frameRate: variant.frameRate, available: false, url: '',
      })) : nativeHlsQualities(text, responseUrl);
      if (audio.length >= 2) {
        log.info('manifest audio:', audio.map(r => r.name || r.lang || '?').join(', '));
      }
      if (subtitles.length) {
        log.info('manifest subtitles:', subtitles.map(r => r.name || r.lang || '?').join(', '));
      }
      if (closedCaptions.length) {
        log.info('manifest closed captions:',
          closedCaptions.map(c => c.instreamId || c.name || '?').join(', '));
      }
      if (variants.length) log.info('manifest variants:', variants.length);
      this.callbacks.onManifest({
        audio: audio.length >= 2 ? audio : [],
        subtitles,
        closedCaptions,
        variants,
        masterUrl: subtitles.length ? responseUrl : '',
      });
      return parsed;
    } catch (e) {
      if (controller.signal.aborted) return null;
      log.warn('Manifest fetch failed', 'event=playback.manifest.failed',
        this.callbacks.playbackLabel(loadToken),
        `elapsed=${String(Date.now() - started)}ms`, e);
      return null;
    } finally {
      if (this.manifestController === controller) this.manifestController = null;
      if (seq === this.manifestSeq && loadToken === this.loadToken) {
        this.nativeQualityLoading = false;
        this.callbacks.onQualityChanged?.();
      }
    }
  }

  private cancelManifest(): void {
    this.nativeQualityLoading = false;
    this.classificationController?.abort();
    this.classificationController = null;
    this.manifestSeq++;
    this.manifestController?.abort();
    this.manifestController = null;
  }
}
