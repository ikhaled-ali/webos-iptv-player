import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Transponder } from './broadcast-normalize';

const request = vi.fn();
vi.mock('./broadcast-service', () => ({ BroadcastService: { request: (...args: unknown[]) => request(...args) } }));

const { matchTransponder, SatelliteScan } = await import('./satellite-scan');
import type { SatelliteConfig, TuneRequest } from './satellite-scan';

const LISTED: Transponder[] = [
  { id: 101, frequency: 11804, polarization: 'H', symbolRate: 30000, system: 'DVB-S2' },
  { id: 102, frequency: 11747, polarization: 'V', symbolRate: 27500, system: 'DVB-S' },
];
const TYPED: TuneRequest = { frequency: 11804, polarization: 'H', symbolRate: 27500, system: 'DVB-S' };
const CONFIG = { id: 1 } as SatelliteConfig;

describe('matchTransponder', () => {
  // A typed 11804 H 27500 DVB-S used to take over the listed 30000 DVB-S2
  // record at the same frequency, so the TV tuned the wrong symbol rate.
  it('treats a different symbol rate or system as another transponder', () => {
    expect(matchTransponder(LISTED, TYPED)).toBeNull();
    expect(matchTransponder(LISTED, { ...TYPED, symbolRate: 30000 })).toBeNull();
    expect(matchTransponder(LISTED, { ...TYPED, symbolRate: 30000, system: 'DVB-S2' })?.id).toBe(101);
  });

  it('still takes a listed record within a few MHz and a rounded symbol rate', () => {
    expect(matchTransponder(LISTED, { frequency: 11746, polarization: 'V', symbolRate: 27495, system: 'DVB-S' })?.id)
      .toBe(102);
    expect(matchTransponder(LISTED, { frequency: 11747, polarization: 'H', symbolRate: 27500, system: 'DVB-S' }))
      .toBeNull();
  });
});

describe('SatelliteScan.tune', () => {
  beforeEach(() => {
    request.mockReset();
    request.mockResolvedValue({ returnValue: true });
  });

  it('tunes a typed transponder with its own values, not a listed record', async () => {
    await SatelliteScan.tune('b1', CONFIG, TYPED, LISTED);
    const [, method, params] = request.mock.calls[0] as [string, string, { transponder: Record<string, unknown> }];
    expect(method).toBe('setDvbSatelliteManualTuning');
    expect(params.transponder).toMatchObject({
      frequency: 11804, symbolRate: 27500, transmissionSystem: 'TRANSMISSIONSYSTEM_DVBS',
    });
    expect(params.transponder.transponderId).not.toBe(101);
  });
});

describe('SatelliteScan LNB settings', () => {
  const RAW = {
    configurationId: 1,
    satelliteInfo: { satelliteId: 6, satelliteName: 'Alpha' },
    scanInfo: {
      lnbFrequency: { type: 'KU_BAND', min: 9750, max: 10600 }, diseqc: 'A_DISEQC',
      twentytwoKhzTone: 'OFF_22KHZTONE', lnbPower: true, motorType: 'OFF_MOTOR',
    },
    scanOption: {},
  };

  beforeEach(() => {
    request.mockReset();
  });

  it('reads the tone and LNB power the TV keeps per satellite', async () => {
    request.mockResolvedValue({ configurationList: [{ ...RAW, scanInfo: { ...RAW.scanInfo, lnbPower: false } }] });
    const [config] = await SatelliteScan.configurations() ?? [];
    expect([config.diseqc, config.tone, config.lnbPower]).toEqual(['A_DISEQC', 'OFF_22KHZTONE', false]);
  });

  it('saves the LNB settings and keeps the rest of the TV record', async () => {
    request.mockResolvedValueOnce({ configurationList: [RAW] });
    const [config] = await SatelliteScan.configurations() ?? [];
    request.mockResolvedValue({ returnValue: true });
    config.lnb = { type: 'KU_BAND', min: 10600, max: 10600 };
    config.diseqc = 'C_DISEQC';
    config.tone = 'A_22KHZTONE';
    config.lnbPower = false;
    expect(await SatelliteScan.saveLnb(config)).toBe(true);
    const [, method, params] = request.mock.calls[1] as [string, string, { scanInfo: Record<string, unknown> }];
    expect(method).toBe('setDvbSatelliteScanInfo');
    expect(params.scanInfo).toMatchObject({
      lnbFrequency: { min: 10600, max: 10600 }, diseqc: 'C_DISEQC',
      twentytwoKhzTone: 'A_22KHZTONE', lnbPower: false, motorType: 'OFF_MOTOR',
    });
  });

  it('leaves the tone off for a universal LNB, which switches bands by tone itself', async () => {
    request.mockResolvedValueOnce({ configurationList: [RAW] });
    const [config] = await SatelliteScan.configurations() ?? [];
    request.mockResolvedValue({ returnValue: true });
    config.tone = 'A_22KHZTONE';
    await SatelliteScan.saveLnb(config);
    const [, , params] = request.mock.calls[1] as [string, string, { scanInfo: Record<string, unknown> }];
    expect(params.scanInfo.twentytwoKhzTone).toBe('OFF_22KHZTONE');
  });
});
