import { describe, expect, it } from 'vitest';
import { normalizeChannel } from './broadcast-normalize';

const base = { channelId: 'c1', channelName: 'Alpha', channelNumber: '1', satelliteName: 'Sat A' };

describe('normalizeChannel kind', () => {
  // A scan set to skip radio still listed advanced codec radio services as TV.
  it('treats every sound-only DVB service type as radio', () => {
    for (const serviceType of [2, 7, 10]) expect(normalizeChannel({ ...base, serviceType })?.kind).toBe('radio');
    expect(normalizeChannel({ ...base, serviceType: 'SERVICETYPE_DIGITAL_RADIO' })?.kind).toBe('radio');
  });

  it('keeps TV services as TV', () => {
    for (const serviceType of [1, 22, 25, 'SERVICETYPE_DIGITAL_TV']) {
      expect(normalizeChannel({ ...base, serviceType })?.kind).toBe('tv');
    }
    expect(normalizeChannel(base)?.kind).toBe('tv');
  });

  it('still reads the TV’s radio flag and channel type', () => {
    expect(normalizeChannel({ ...base, Radio: true })?.kind).toBe('radio');
    expect(normalizeChannel({ ...base, channelType: 'Satellite Digital Radio' })?.kind).toBe('radio');
  });
});
