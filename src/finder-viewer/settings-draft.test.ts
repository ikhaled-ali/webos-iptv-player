import { describe, expect, it } from 'vitest';
import type { SettingsMessage, SharedSatellite } from '../services/finder-share-protocol';
import {
  applyMessage,
  draftFrom,
  editForm,
  isDirty,
  pickSatellite,
  pickTransponder,
  rebase,
  toneLocked,
} from './settings-draft';

function satellite(id: number, patch: Partial<SharedSatellite> = {}): SharedSatellite {
  return {
    id, name: `Sat ${String(id)}`, lnb: 0, lnbLabel: '9750/10600', diseqc: 'OFF', tone: 'T0', lnbPower: true,
    form: { frequency: 11000, polarization: 'H', symbolRate: 27500, system: 'DVB-S2' }, tp: 1,
    tps: [[1, 11000, 'H', 27500, 'DVB-S2'], [2, 11100, 'V', 0, '']],
    ...patch,
  };
}

function settings(patch: Partial<SettingsMessage> = {}): SettingsMessage {
  return {
    v: 1, satellite: 1,
    satellites: [satellite(1), satellite(2, { lnb: 2, diseqc: 'B', tps: [], tp: 0 })],
    lnbs: [{ label: '9750/10600', universal: true }, { label: '9750/10750', universal: true }, { label: '10600', universal: false }],
    diseqcs: [{ value: 'OFF', label: '' }, { value: 'B', label: 'B' }],
    tones: [{ value: 'T0', label: '' }, { value: 'T1', label: '22kHz' }],
    ...patch,
  };
}

describe('finder settings draft', () => {
  it('starts from what the TV shows, and is not dirty', () => {
    const tv = settings();
    const draft = draftFrom(tv);
    expect(draft).toMatchObject({ satellite: 1, tp: 1, frequency: '11000', symbolRate: '27500' });
    expect(isDirty(draft, tv)).toBe(false);
  });

  it('follows the TV until the phone has edits, then keeps them', () => {
    const tv = settings();
    const moved = settings({ satellites: [satellite(1, { form: { ...tv.satellites[0].form, frequency: 11100 } }), tv.satellites[1]] });
    expect(rebase(draftFrom(tv), tv, moved).frequency).toBe('11100');
    const edited = { ...draftFrom(tv), lnbPower: false };
    expect(rebase(edited, tv, moved)).toBe(edited);
  });

  it('takes the TV’s settings again once they match what was sent', () => {
    const tv = settings();
    const edited = { ...draftFrom(tv), diseqc: 'B' };
    const applied = settings({ satellites: [satellite(1, { diseqc: 'B' }), tv.satellites[1]] });
    expect(isDirty(edited, applied)).toBe(false);
    const later = settings({ satellites: [satellite(1, { diseqc: 'B', lnbPower: false }), tv.satellites[1]] });
    expect(rebase(edited, applied, later).lnbPower).toBe(false);
  });

  it('brings a picked satellite’s own LNB setup', () => {
    const tv = settings();
    expect(pickSatellite(draftFrom(tv), tv, 2)).toMatchObject({ satellite: 2, lnb: 2, diseqc: 'B', tp: 0 });
  });

  it('fills the form from a listed transponder, keeping fields the list leaves out', () => {
    const tv = settings();
    expect(pickTransponder(draftFrom(tv), tv, 2)).toMatchObject({
      tp: 2, frequency: '11100', polarization: 'V', symbolRate: '27500', system: 'DVB-S2',
    });
    expect(pickTransponder(draftFrom(tv), tv, 0)).toMatchObject({ tp: 0, frequency: '11000' });
  });

  it('makes a listed transponder a new one once its fields change', () => {
    const draft = draftFrom(settings());
    expect(editForm(draft, { polarization: 'V' }).tp).toBe(0);
    expect(editForm(draft, { polarization: 'H' }).tp).toBe(1);
  });

  it('locks the tone for a universal LNB', () => {
    const tv = settings();
    expect(toneLocked(draftFrom(tv), tv)).toBe(true);
    expect(toneLocked({ ...draftFrom(tv), lnb: 2 }, tv)).toBe(false);
  });

  it('sends nothing while a number is out of range or half typed', () => {
    const draft = draftFrom(settings());
    expect(applyMessage({ ...draft, symbolRate: '27' }, 'abcdef01')).toBeNull();
    expect(applyMessage({ ...draft, frequency: '' }, 'abcdef01')).toBeNull();
    expect(applyMessage(draft, 'abcdef01')).toEqual({
      v: 1, req: 'abcdef01', satellite: 1, lnb: 0, diseqc: 'OFF', tone: 'T0', lnbPower: true,
      form: { frequency: 11000, polarization: 'H', symbolRate: 27500, system: 'DVB-S2' },
    });
  });
});
