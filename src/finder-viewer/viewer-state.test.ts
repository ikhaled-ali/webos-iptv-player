import { describe, expect, it } from 'vitest';
import { FALLBACK_LABELS, type ReadingMessage } from '../services/finder-share-protocol';
import {
  initialState,
  resetPeak,
  STALE_MS,
  STOP_GRACE_MS,
  toneFrequency,
  viewerLabels,
  viewerPhase,
  withReading,
  withStatus,
} from './viewer-state';

function reading(lock: ReadingMessage['lock'], quality: number | null, strength: number | null = 50): ReadingMessage {
  return { v: 1, lock, strength, quality, ber: null, satellite: 'Alpha', transponder: '11000 H 27500' };
}

describe('finder viewer state', () => {
  it('waits, goes live, turns stale, and stops', () => {
    let state = initialState();
    expect(viewerPhase(state, 0)).toBe('waiting');
    state = withStatus(state, { v: 1, on: true, labels: FALLBACK_LABELS }, 0);
    expect(viewerPhase(state, 0)).toBe('waiting');
    state = withReading(state, reading('locked', 40), 1000);
    expect(viewerPhase(state, 1000 + STALE_MS)).toBe('live');
    expect(viewerPhase(state, 1001 + STALE_MS)).toBe('stale');
    state = withStatus(state, { v: 1, on: false, labels: FALLBACK_LABELS }, 1500);
    expect(viewerPhase(state, 1500 + STOP_GRACE_MS)).toBe('stopped');
  });

  it('shows a retained stop at once when no reading came before it', () => {
    const state = withStatus(initialState(), { v: 1, on: false, labels: FALLBACK_LABELS }, 0);
    expect(viewerPhase(state, 0)).toBe('stopped');
  });

  // The broker publishes a dropped connection's will up to a keepalive and
  // a half later, while the reconnected TV keeps streaming.
  it('keeps streaming through a late will from an old connection', () => {
    let state = withStatus(initialState(), { v: 1, on: true, labels: FALLBACK_LABELS }, 0);
    state = withReading(state, reading('locked', 50), 1000);
    state = withStatus(state, { v: 1, on: false, labels: FALLBACK_LABELS }, 1500);
    expect(viewerPhase(state, 1600)).toBe('live');
    state = withReading(state, reading('locked', 52), 1800);
    expect(viewerPhase(state, 1800 + STOP_GRACE_MS)).toBe('live');
  });

  it('holds the best locked quality until reset', () => {
    let state = initialState();
    state = withReading(state, reading('nolock', 90), 0);
    expect(state.peak).toBeNull();
    state = withReading(state, reading('locked', 62), 0);
    state = withReading(state, reading('locked', 48), 0);
    expect(state.peak).toBe(62);
    state = resetPeak(state);
    expect(state.peak).toBe(48);
  });

  it('uses the TV labels once a status arrived', () => {
    const labels = { ...FALLBACK_LABELS, title: 'Signalsuche' };
    expect(viewerLabels(initialState()).title).toBe(FALLBACK_LABELS.title);
    expect(viewerLabels(withStatus(initialState(), { v: 1, on: true, labels }, 0)).title).toBe('Signalsuche');
  });

  it('raises the tone with the signal and stays silent while searching', () => {
    expect(toneFrequency(reading('locked', 80)) as number).toBeGreaterThan(toneFrequency(reading('locked', 20)) as number);
    expect(toneFrequency(reading('nolock', null, 60)) as number).toBeLessThan(toneFrequency(reading('locked', 0)) as number);
    expect(toneFrequency(reading('nolock', null, 0))).toBeNull();
    expect(toneFrequency(reading('searching', null))).toBeNull();
  });
});
