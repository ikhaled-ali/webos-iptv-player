import { CONFIG } from '../config';
import type { ResumeEntry, VodQueueItem } from '../types';

// End credits run minutes on a film, so the last 5% (at least FINISH_PAD)
// counts as watched to the end.
export function vodFinished(position: number, duration: number): boolean {
  if (!(duration > 0)) return false;
  const pad = Math.max(CONFIG.XTREAM.RESUME_FINISH_PAD, duration * CONFIG.XTREAM.RESUME_FINISH_FRACTION);
  return position >= duration - pad;
}

export function resumeSeriesId(entry: Pick<ResumeEntry, 'kind' | 'watchlistOwner'>): string | null {
  return entry.kind === 'episode' ? entry.watchlistOwner?.itemId ?? null : null;
}

/** One Continue Watching entry per series: its most recent episode. `entries`
 *  must be newest first, as `StorageService.getResumeList` returns them. */
export function latestPerSeries(entries: ResumeEntry[]): ResumeEntry[] {
  const seen = new Set<string>();
  return entries.filter(entry => {
    const series = resumeSeriesId(entry);
    if (series === null) return true;
    if (seen.has(series)) return false;
    seen.add(series);
    return true;
  });
}

/** A queue as it is stored: details stay in memory only. */
export function storedQueue(queue: VodQueueItem[] | undefined): VodQueueItem[] | undefined {
  return queue?.map(item => {
    const copy = { ...item };
    delete copy.details;
    return copy;
  });
}

/** The Continue Watching entry for the episode after a finished one. */
export function upNextResume(next: VodQueueItem, remaining: VodQueueItem[], ext: string): ResumeEntry {
  return {
    accountId: next.accountId,
    kind: next.kind,
    itemId: next.itemId,
    name: next.title,
    poster: next.poster,
    ext,
    position: 0,
    duration: 0,
    updatedAt: Date.now(),
    episodeQueue: storedQueue(remaining),
    watchlistOwner: next.watchlistOwner,
    categoryId: next.categoryId,
    subtitles: next.subtitles,
    searchMeta: next.searchMeta,
    upNext: true,
  };
}
