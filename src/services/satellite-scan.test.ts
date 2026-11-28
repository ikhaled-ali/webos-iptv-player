import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Transponder } from './broadcast-normalize';

const request = vi.fn();
const loadChannels = vi.fn();
const rootExec = vi.fn();
vi.mock('./broadcast-service', () => ({
  BroadcastService: {
    request: (...args: unknown[]) => request(...args),
    loadChannels: (...args: unknown[]) => loadChannels(...args),
  },
}));
vi.mock('./root-exec', async (importOriginal) => ({
  ...await importOriginal<typeof import('./root-exec')>(),
  rootExec: (...args: unknown[]) => rootExec(...args),
}));

const { matchTransponder, SatelliteScan, wipeChannelMapCommand } = await import('./satellite-scan');
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

  const SELECTED = {
    transponderId: 336, frequency: 10719, polarisation: 'VERTICAL_POLARISATION',
    symbolRate: 22000, transmissionSystem: 'TRANSMISSIONSYSTEM_DVBS2', homeTp: false,
  };

  it('saves and reads back the setup and transponder, finding nothing unkept', async () => {
    request.mockResolvedValueOnce({ configurationList: [RAW] });
    const [config] = await SatelliteScan.configurations() ?? [];
    config.diseqc = 'D_DISEQC';
    config.scanInfo = { ...config.scanInfo, selectedTp: SELECTED };
    request.mockResolvedValueOnce({ returnValue: true });
    request.mockResolvedValueOnce({ configurationList: [{
      ...RAW, scanInfo: { ...RAW.scanInfo, diseqc: 'D_DISEQC', selectedTp: SELECTED },
    }] });
    expect(await SatelliteScan.saveAndCheck(config)).toEqual([]);
    const [, method, params] = request.mock.calls[1] as [string, string, { scanInfo: Record<string, unknown> }];
    expect(method).toBe('setDvbSatelliteScanInfo');
    expect(params.scanInfo).toMatchObject({ diseqc: 'D_DISEQC', selectedTp: SELECTED });
  });

  it('names the settings the TV did not keep', async () => {
    request.mockResolvedValueOnce({ configurationList: [RAW] });
    const [config] = await SatelliteScan.configurations() ?? [];
    config.diseqc = 'D_DISEQC';
    config.scanInfo = { ...config.scanInfo, selectedTp: SELECTED };
    request.mockResolvedValueOnce({ returnValue: true });
    request.mockResolvedValueOnce({ configurationList: [RAW] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await SatelliteScan.saveAndCheck(config)).toEqual(['diseqc', 'transponder']);
    expect(warn.mock.calls.some(call => call.includes('event=satellite.scan.check_unkept')
      && call.includes('settings=diseqc,transponder'))).toBe(true);
    warn.mockRestore();
  });

  it('reports a refused save, and one it cannot read back', async () => {
    request.mockResolvedValueOnce({ configurationList: [RAW] });
    const [config] = await SatelliteScan.configurations() ?? [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    request.mockResolvedValueOnce(null);
    expect(await SatelliteScan.saveAndCheck(config)).toBeNull();
    request.mockResolvedValueOnce({ returnValue: true });
    request.mockResolvedValueOnce(null);
    expect(await SatelliteScan.saveAndCheck(config)).toBeNull();
    expect(warn.mock.calls.some(call => call.includes('event=satellite.scan.check_failed'))).toBe(true);
    warn.mockRestore();
  });
});

describe('SatelliteScan.deleteTransponders', () => {
  const SAT = { id: 1, satelliteId: 6, lnb: { type: 'KU_BAND', min: 9750, max: 10600 }, scanInfo: {} } as unknown as SatelliteConfig;
  let listed: Transponder[];

  // The TV's list, which a delete it takes shrinks when `honored`.
  function tv(honored: boolean): void {
    request.mockImplementation(async (_service: string, method: string, params: Record<string, unknown>) => {
      if (method === 'getDvbSatelliteTransponderList') {
        return { transponderList: listed.map(item => ({ transponderId: item.id, frequency: item.frequency })) };
      }
      if (method !== 'deleteDvbSatelliteTransponder') return null;
      const ids = params.transponderIdList as number[];
      if (honored) listed = listed.filter(item => !ids.includes(item.id));
      return { returnValue: true };
    });
  }

  beforeEach(() => {
    request.mockReset();
    listed = LISTED.slice();
  });

  it('deletes several transponders in one call, as LG’s transponder editor does', async () => {
    tv(true);
    expect(await SatelliteScan.deleteTransponders(SAT, LISTED)).toBe(true);
    const deletes = request.mock.calls.filter(call => call[1] === 'deleteDvbSatelliteTransponder');
    expect(deletes).toHaveLength(1);
    expect(deletes[0][2]).toEqual({ idCount: 2, transponderIdList: [101, 102] });
    expect(listed).toEqual([]);
  });

  it('reports a delete the TV answered but did not make', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    tv(false);
    expect(await SatelliteScan.deleteTransponders(SAT, [LISTED[0]])).toBe(false);
    expect(warn.mock.calls.some(call => call.includes('event=satellite.scan.tp_delete_failed'))).toBe(true);
    warn.mockRestore();
  });
});

describe('SatelliteScan.deleteAllChannels', () => {
  const raw = (id: number, satelliteId: number, name: string, diseqc: string) => ({
    configurationId: id,
    satelliteInfo: { satelliteId, satelliteName: name },
    scanInfo: { lnbFrequency: { type: 'KU_BAND', min: 9750, max: 10600 }, diseqc, twentytwoKhzTone: 'OFF_22KHZTONE', lnbPower: true },
    scanOption: { isSelected: true, networkSearch: true, blindSearch: true, skipScrambleProgram: true,
      supportNetworkSearch: true, supportBlindSearch: true, supportSkipScrambleProgram: true },
  });
  let list: ReturnType<typeof raw>[];

  // The TV: a wipe leaves one default satellite; created ones take the next id.
  beforeEach(() => {
    request.mockReset();
    rootExec.mockReset();
    loadChannels.mockReset();
    list = [raw(0, 25, 'Sat A', 'A_DISEQC'), raw(1, 6, 'Sat B', 'B_DISEQC')];
    rootExec.mockImplementation(async () => {
      list = [raw(0, 40, 'Default', 'OFF_DISEQC')];
      return { ok: true, stdout: 'CHMAP_WIPED\n', stderr: '', unavailable: false, error: '' };
    });
    request.mockImplementation(async (_service: string, method: string, params: Record<string, unknown>) => {
      if (method === 'getDvbSatelliteConfigurationList') return { configurationList: list };
      if (method === 'createDvbSatelliteConfiguration') {
        const made = raw(list.length, 40, 'Default', 'OFF_DISEQC');
        list.push(made);
        return { configuration: made };
      }
      if (method === 'setDvbSatelliteSelectedSatellite') {
        const at = list.findIndex(item => item.configurationId === params.configurationId);
        list[at] = { ...list[at], satelliteInfo: { satelliteId: params.satelliteId as number, satelliteName: 'x' } };
      }
      if (method === 'setDvbSatelliteScanInfo') {
        const at = list.findIndex(item => item.configurationId === params.configurationId);
        list[at] = { ...list[at], scanInfo: params.scanInfo as typeof list[number]['scanInfo'] };
      }
      return { returnValue: true };
    });
    loadChannels.mockResolvedValue({ ok: false, reason: 'no-channels' });
  });

  it('wipes the channel map and puts each satellite back with its LNB setup', async () => {
    expect(await SatelliteScan.deleteAllChannels()).toEqual({ ok: true, restored: true });
    expect(list.map(item => [item.satelliteInfo.satelliteId, item.scanInfo.diseqc])).toEqual([[25, 'A_DISEQC'], [6, 'B_DISEQC']]);
  });

  it('reports a wipe that left channels behind', async () => {
    loadChannels.mockResolvedValue({ ok: true, route: 'root', channels: [{ id: 'ch1' }], currentId: null });
    expect((await SatelliteScan.deleteAllChannels()).ok).toBe(false);
  });

  // The root call failed after the map was already reset: the satellites
  // were left as the TV's default one.
  it('puts the satellites back even when the wipe answers with an error', async () => {
    rootExec.mockImplementation(async () => {
      list = [raw(0, 40, 'Default', 'OFF_DISEQC')];
      return { ok: false, stdout: '', stderr: '', unavailable: false, error: 'timeout' };
    });
    expect(await SatelliteScan.deleteAllChannels()).toEqual({ ok: true, restored: true });
    expect(list.map(item => item.satelliteInfo.satelliteId)).toEqual([25, 6]);
  });

  it('touches nothing without root', async () => {
    rootExec.mockResolvedValue({ ok: false, stdout: '', stderr: '', unavailable: true, error: 'no-luna' });
    expect(await SatelliteScan.deleteAllChannels()).toEqual({ ok: false, restored: true });
    expect(request.mock.calls.some(call => call[1] === 'setDvbSatelliteSelectedSatellite')).toBe(false);
  });

  it('kills the provider before setting its map aside, and checks the map came back', () => {
    const command = wipeChannelMapCommand();
    const kill = command.indexOf('kill -9');
    const move = command.indexOf('mv ');
    expect(kill).toBeGreaterThan(0);
    expect(move).toBeGreaterThan(kill);
    expect(command).toContain("'/mnt/lg/cmn_data/ldb_chmap_backup'");
    expect(command).toContain('systemctl restart iepg.service');
    expect(command.trim().split('\n').pop()).toBe('echo CHMAP_WIPED');
  });
});
