import { describe, expect, it } from 'vitest';
import { EN_MESSAGES } from '../i18n/en';
import {
  FALLBACK_LABELS,
  applyTopic,
  FINDER_BROKERS,
  parseApply,
  parseReading,
  parseSettings,
  parseStatus,
  parseViewerHash,
  readingTopic,
  settingsTopic,
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
    expect(settingsTopic(ID).startsWith(filter)).toBe(true);
    expect(applyTopic(ID).startsWith(filter)).toBe(true);
  });

  const satellite = (id: number) => ({
    id, name: `Sat ${String(id)}`, lnb: 0, lnbLabel: '9750/10600', diseqc: 'A', tone: 'T0', lnbPower: true,
    form: { frequency: 11000, polarization: 'H', symbolRate: 27500, system: 'DVB-S2' }, tp: 1,
    tps: [[1, 11000, 'H', 27500, 'DVB-S2'], [2, 11100, 'V', 0, ''], [3, 99999, 'H', 27500, 'DVB-S2'], 'x'],
  });

  it('takes the settings the TV shares, dropping malformed transponders', () => {
    const settings = parseSettings(JSON.stringify({
      v: 1, satellite: 1, satellites: [satellite(1), { id: 2 }],
      lnbs: [{ label: '9750/10600', universal: true }], diseqcs: [{ value: 'A', label: 'A' }, { label: 'x' }],
      tones: [{ value: 'T0', label: '' }], ack: { req: 'abcdef01', ok: true },
    }));
    expect(settings?.satellites.map(item => item.id)).toEqual([1]);
    expect(settings?.satellites[0].tps).toEqual([[1, 11000, 'H', 27500, 'DVB-S2'], [2, 11100, 'V', 0, '']]);
    expect(settings?.diseqcs).toEqual([{ value: 'A', label: 'A' }]);
    expect(settings?.ack).toEqual({ req: 'abcdef01', ok: true });
  });

  it('refuses settings without the satellite they name', () => {
    expect(parseSettings(JSON.stringify({ v: 1, satellite: 9, satellites: [satellite(1)] }))).toBeNull();
    expect(parseSettings('')).toBeNull();
    const unlisted = parseSettings(JSON.stringify({ v: 1, satellite: 1, satellites: [{ ...satellite(1), tp: 7, lnb: 4 }] }));
    expect([unlisted?.satellites[0].tp, unlisted?.satellites[0].lnb]).toEqual([0, -1]);
  });

  it('takes only a well-formed apply, with numbers in the finder ranges', () => {
    const apply = {
      v: 1, req: 'abcdef01', satellite: 1, lnb: 0, diseqc: 'A', tone: 'T0', lnbPower: false,
      form: { frequency: 11000, polarization: 'V', symbolRate: 27500, system: 'DVB-S' },
    };
    expect(parseApply(JSON.stringify(apply))).toEqual(apply);
    expect(parseApply(JSON.stringify({ ...apply, form: { ...apply.form, frequency: 20000 } }))).toBeNull();
    expect(parseApply(JSON.stringify({ ...apply, form: { ...apply.form, symbolRate: 27500.5 } }))).toBeNull();
    expect(parseApply(JSON.stringify({ ...apply, req: 'NOT-HEX!' }))).toBeNull();
    expect(parseApply(JSON.stringify({ ...apply, lnbPower: 'yes' }))).toBeNull();
    expect(parseApply(JSON.stringify({ ...apply, diseqc: '' }))).toBeNull();
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
      satellite: EN_MESSAGES['satelliteTools.satellite'],
      lnb: EN_MESSAGES['satelliteTools.lnb'],
      diseqc: EN_MESSAGES['satelliteTools.diseqc'],
      tone: EN_MESSAGES['satelliteTools.tone'],
      lnbPower: EN_MESSAGES['satelliteTools.lnbPower'],
      newTransponder: EN_MESSAGES['satelliteTools.newTransponder'],
      frequency: EN_MESSAGES['satelliteTools.frequency'],
      symbolRate: EN_MESSAGES['satelliteTools.symbolRate'],
      polarization: EN_MESSAGES['satelliteTools.polarization'],
      horizontal: EN_MESSAGES['satelliteTools.horizontal'],
      vertical: EN_MESSAGES['satelliteTools.vertical'],
      system: EN_MESSAGES['satelliteTools.system'],
      off: EN_MESSAGES['common.off'],
      send: EN_MESSAGES['finderShare.send'],
      cancel: EN_MESSAGES['common.cancel'],
      sending: EN_MESSAGES['finderShare.sending'],
      applied: EN_MESSAGES['finderShare.applied'],
      notApplied: EN_MESSAGES['finderShare.notApplied'],
      noAnswer: EN_MESSAGES['finderShare.noAnswer'],
    };
    expect(FALLBACK_LABELS).toEqual(keys);
  });
});
