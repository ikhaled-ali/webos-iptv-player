import {
  FALLBACK_LABELS,
  type ReadingMessage,
  type StatusMessage,
  type ViewerLabels,
} from '../services/finder-share-protocol';

// The TV sends a reading about every second; a few missed ones mean it
// stopped, whatever the retained status still says.
export const STALE_MS = 4000;
// A "stopped" status counts once no reading follows it for this long: the
// broker may deliver an old connection's will while the TV streams on.
export const STOP_GRACE_MS = 2000;

export interface ViewerState {
  status: StatusMessage | null;
  statusAt: number;
  reading: ReadingMessage | null;
  readingAt: number;
  // The best quality since the last reset, the number a dish is aligned by.
  peak: number | null;
}

export type ViewerPhase = 'waiting' | 'live' | 'stale' | 'stopped';

export function initialState(): ViewerState {
  return { status: null, statusAt: 0, reading: null, readingAt: 0, peak: null };
}

export function withStatus(state: ViewerState, status: StatusMessage, now: number): ViewerState {
  return { ...state, status, statusAt: now };
}

export function withReading(state: ViewerState, reading: ReadingMessage, now: number): ViewerState {
  const quality = reading.lock === 'locked' ? reading.quality : null;
  const peak = quality === null ? state.peak : state.peak === null ? quality : Math.max(state.peak, quality);
  return { ...state, reading, readingAt: now, peak };
}

export function resetPeak(state: ViewerState): ViewerState {
  const reading = state.reading;
  return { ...state, peak: reading && reading.lock === 'locked' ? reading.quality : null };
}

export function viewerPhase(state: ViewerState, now: number): ViewerPhase {
  const stopped = !!state.status && !state.status.on;
  if (stopped && (!state.reading || (state.readingAt <= state.statusAt && now - state.statusAt >= STOP_GRACE_MS))) {
    return 'stopped';
  }
  if (!state.reading) return 'waiting';
  return now - state.readingAt > STALE_MS ? 'stale' : 'live';
}

export function viewerLabels(state: ViewerState): ViewerLabels {
  return state.status ? state.status.labels : FALLBACK_LABELS;
}

// Pitch rises with the signal, as on a hand-held satellite meter: quality
// once locked, strength (lower) before that. Null is silence.
export function toneFrequency(reading: ReadingMessage): number | null {
  if (reading.lock === 'locked' && reading.quality !== null) return 440 + reading.quality * 12;
  if (reading.lock === 'nolock' && reading.strength !== null && reading.strength > 0) return 200 + reading.strength * 3;
  return null;
}
