import { describe, expect, it } from 'vitest';
import { EN_MESSAGES } from '../i18n/en';
import {
  FALLBACK_LABELS,
  FINDER_BROKERS,
  parseReading,
  parseStatus,
  parseViewerHash,
  readingTopic,
  shareFilter,
  signalLevel,
  statusTopic,
  viewerUrl,
  type ViewerLabelKey,
} from './finder-share-protocol';

const ID = '0123456789abcdef0123456789abcdef';

describe('finder share protocol', () => {
  it('round-trips the broker and id through the viewer link fragment', () => {
    const url = viewerUrl('http://host/a/', 1, ID);
    expect(url).toBe(`http://host/a/#b=1&t=${ID}`);
    expect(parseViewerHash(new URL(url).hash)).toEqual({ broker: 1, id: ID });
  });

  it('rejects links without a valid id or broker', () => {
    expect(parseViewerHash('')).toBeNull();
    expect(parseViewerHash(`#b=${String(FINDER_BROKERS.length)}&t=${ID}`)).toBeNull();
    expect(parseViewerHash('#b=0&t=short')).toBeNull();
    expect(parseViewerHash(`#b=x&t=${ID}`)).toBeNull();
  });

  it('keeps both topics under the filter the phone subscribes to', () => {
    const filter = shareFilter(ID).replace('+', '');
    expect(statusTopic(ID).startsWith(filter)).toBe(true);
    expect(readingTopic(ID).startsWith(filter)).toBe(true);
  });

  it('fills missing labels and bounds untrusted text in a status', () => {
    const status = parseStatus(JSON.stringify({ v: 1, on: true, labels: { title: 'x'.repeat(500), peak: 7 } }));
    expect(status?.labels.title).toHaveLength(120);
    expect(status?.labels.peak).toBe(FALLBACK_LABELS.peak);
    expect(parseStatus(JSON.stringify({ v: 2, on: true }))).toBeNull();
    expect(parseStatus('not json')).toBeNull();
  });

  it('clamps readings and refuses an unknown lock state', () => {
    const reading = parseReading(JSON.stringify({ v: 1, lock: 'locked', strength: 140, quality: -3.6, ber: -1, satellite: 'Alpha' }));
    expect(reading).toEqual({
      v: 1, lock: 'locked', strength: 100, quality: 0, ber: null, satellite: 'Alpha', transponder: '',
    });
    expect(parseReading(JSON.stringify({ v: 1, lock: 'open' }))).toBeNull();
    expect(parseReading('[1]')).toBeNull();
  });

  it('grades a level as the TV meters do', () => {
    expect([null, 0, 29, 30, 59, 60].map(signalLevel)).toEqual(['none', 'poor', 'poor', 'fair', 'fair', 'good']);
  });

  it('falls back to the same English the TV sends', () => {
    const keys: Record<ViewerLabelKey, string> = {
      title: EN_MESSAGES['satelliteTools.signalFinder'],
      strength: EN_MESSAGES['satellite.signalStrength'],
      quality: EN_MESSAGES['satellite.signalQuality'],
      ber: EN_MESSAGES['satelliteTools.ber'],
      transponder: EN_MESSAGES['satelliteTools.transponder'],
      locked: EN_MESSAGES['satelliteTools.locked'],
      noLock: EN_MESSAGES['satelliteTools.noLock'],
      searching: EN_MESSAGES['satelliteTools.searching'],
      waiting: EN_MESSAGES['finderShare.waiting'],
      stopped: EN_MESSAGES['finderShare.stopped'],
      stale: EN_MESSAGES['finderShare.stale'],
      sound: EN_MESSAGES['finderShare.sound'],
      peak: EN_MESSAGES['finderShare.peak'],
      resetPeak: EN_MESSAGES['common.reset'],
    };
    expect(FALLBACK_LABELS).toEqual(keys);
  });
});
