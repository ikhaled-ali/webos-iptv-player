export interface BufferMedia {
  currentTime: number;
  duration: number;
  readyState: number;
  paused: boolean;
  seeking?: boolean;
  buffered: TimeRanges;
  pause(): void;
}

export interface PlaybackBufferOptions {
  startupSeconds: number;
  recoverySeconds: number;
  maxWaitMs: number;
  pollMs: number;
  nativeGraceMs: number;
  onHolding: (holding: boolean) => void;
  onError: (error: unknown) => void;
}

export function bufferedAhead(media: BufferMedia, startup = false): number {
  try {
    const ranges = media.buffered;
    let position = media.currentTime;
    if (startup && position === 0 && ranges.length && ranges.start(0) > 0) position = ranges.start(0);
    for (let index = 0; index < ranges.length; index++) {
      if (position < ranges.start(index) - 0.15 || position > ranges.end(index)) continue;
      let end = ranges.end(index);
      while (index + 1 < ranges.length && ranges.start(index + 1) - end <= 0.15) end = ranges.end(++index);
      return Math.max(0, end - position);
    }
  } catch { return 0; }
  return 0;
}

export class PlaybackBuffer {
  private media: BufferMedia | null = null;
  private play: (() => Promise<void> | void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;
  private lastGrowthAt = 0;
  private lastAhead = 0;
  private native = false;
  private startup = true;
  private hasPlayed = false;
  private recoveryUsed = false;
  private generation = 0;

  constructor(private options: PlaybackBufferOptions) {}

  get holding(): boolean { return this.timer !== null; }

  start(media: BufferMedia, play: () => Promise<void> | void, native: boolean): void {
    this.stop();
    this.media = media;
    this.play = play;
    this.native = native;
    this.arm(true);
  }

  confirmPlaying(): void {
    this.hasPlayed = true;
    this.recoveryUsed = false;
  }

  recover(): boolean {
    const media = this.media;
    if (!media || this.holding || !this.hasPlayed || this.recoveryUsed
        || !media.buffered || media.paused || media.seeking || media.readyState >= 3) return false;
    this.recoveryUsed = true;
    this.arm(false);
    return true;
  }

  private arm(startup: boolean): void {
    this.startup = startup;
    this.startedAt = this.lastGrowthAt = Date.now();
    this.lastAhead = 0;
    this.timer = setInterval(() => this.tick(), this.options.pollMs);
    this.options.onHolding(true);
    if (!this.media?.paused) this.media?.pause();
    if (!this.media?.buffered || typeof this.media.buffered.start !== 'function') {
      this.release();
      return;
    }
    this.tick();
  }

  private tick(): void {
    const media = this.media;
    if (!media || !this.holding) return;
    const ahead = bufferedAhead(media, this.startup);
    const now = Date.now();
    if (ahead > this.lastAhead + 0.1) {
      this.lastGrowthAt = now;
      this.lastAhead = ahead;
    } else if (ahead < this.lastAhead - 0.1) this.lastAhead = ahead;
    const remaining = Number.isFinite(media.duration) && media.duration > 0
      ? Math.max(0.1, media.duration - media.currentTime) : Infinity;
    const goal = Math.min(this.startup ? this.options.startupSeconds : this.options.recoverySeconds, remaining);
    const nativeBlocked = this.native && media.readyState >= 2
      && now - this.startedAt >= this.options.nativeGraceMs
      && now - this.lastGrowthAt >= this.options.nativeGraceMs;
    if ((!media.seeking && ahead >= goal) || nativeBlocked || now - this.startedAt >= this.options.maxWaitMs) this.release();
  }

  release(): void {
    if (!this.holding) return;
    this.cancelWait();
    const generation = this.generation;
    try {
      const playing = this.play?.();
      if (playing) void playing.catch(error => {
        if (generation === this.generation) this.options.onError(error);
      });
    } catch (error) { this.options.onError(error); }
  }

  cancelWait(): void {
    this.generation++;
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
    this.options.onHolding(false);
  }

  stop(): void {
    this.cancelWait();
    this.media = null;
    this.play = null;
    this.hasPlayed = false;
    this.recoveryUsed = false;
  }
}
