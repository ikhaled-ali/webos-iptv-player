import type { PlaylistLoadProgress } from '../services/playlist-service';

export type LoadPart = 'channels' | 'movies' | 'series';
export type LoadStatus = 'loading' | 'done' | 'failed';

export interface LoadRow {
  part: LoadPart;
  fraction: number;
  status: LoadStatus;
}

function clamp01(value: number): number {
  if (!(value > 0)) return 0;
  return value < 1 ? value : 1;
}

export function fractionOf(done: number, total: number): number {
  return total > 0 ? clamp01(done / total) : 0;
}

// Each source counts equally. Within one, the Live catalog size (Xtream) or
// the response length (M3U) is the total; without either the source moves
// the bar only once it completes.
export function channelLoadFraction(progress: PlaylistLoadProgress): number {
  const sources = Math.max(1, progress.sourceCount);
  const index = Math.min(Math.max(0, progress.sourceNumber - 1), sources - 1);
  const within = progress.expectedChannels
    ? fractionOf(progress.sourceChannelsKept ?? 0, progress.expectedChannels)
    : progress.totalBytes
      ? fractionOf(progress.inputBytes, progress.totalBytes)
      : 0;
  return clamp01((index + within) / sources);
}

// A row still loading never reads 100%: a reached total can still be parsing.
export function percentOf(row: LoadRow): number {
  if (row.status === 'done') return 100;
  const percent = Math.floor(clamp01(row.fraction) * 100);
  return row.status === 'loading' ? Math.min(99, percent) : percent;
}

/** Rows for one load; a newer `start` makes every older session's update a no-op. */
export class LoadProgressTracker {
  private rowsByPart = new Map<LoadPart, LoadRow>();
  private session = 0;
  private listeners: Array<() => void> = [];

  start(parts: LoadPart[]): number {
    this.session++;
    this.rowsByPart = new Map(parts.map(part => [part, { part, fraction: 0, status: 'loading' as LoadStatus }]));
    this.notify();
    return this.session;
  }

  /** End the session without settling it, such as when the load failed outright. */
  cancel(session: number): void {
    if (session !== this.session) return;
    this.session++;
    this.rowsByPart = new Map();
    this.notify();
  }

  isCurrent(session: number): boolean {
    return session === this.session && this.rowsByPart.size > 0;
  }

  // Never moves backward, so a new source or a retried category can't shrink the bar.
  update(session: number, part: LoadPart, fraction: number): void {
    const row = this.row(session, part);
    if (!row || row.status !== 'loading') return;
    const next = Math.max(row.fraction, clamp01(fraction));
    if (next === row.fraction) return;
    row.fraction = next;
    this.notify();
  }

  settle(session: number, part: LoadPart, ok: boolean): void {
    const row = this.row(session, part);
    if (!row || row.status !== 'loading') return;
    row.status = ok ? 'done' : 'failed';
    if (ok) row.fraction = 1;
    this.notify();
  }

  /** Drop a row whose load turned out not to run, such as a catalog already cached elsewhere. */
  drop(session: number, part: LoadPart): void {
    if (!this.row(session, part)) return;
    this.rowsByPart.delete(part);
    this.notify();
  }

  rows(): LoadRow[] {
    return Array.from(this.rowsByPart.values(), row => ({ ...row }));
  }

  get settled(): boolean {
    for (const row of Array.from(this.rowsByPart.values())) {
      if (row.status === 'loading') return false;
    }
    return true;
  }

  onChange(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  private row(session: number, part: LoadPart): LoadRow | undefined {
    return session === this.session ? this.rowsByPart.get(part) : undefined;
  }

  private notify(): void {
    for (const listener of this.listeners.slice()) listener();
  }
}
