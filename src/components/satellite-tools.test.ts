// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BroadcastChannel, Transponder } from '../services/broadcast-normalize';
import type { SatelliteConfig } from '../services/satellite-scan';

const { scan, toastMock, loadChannels, video } = vi.hoisted(() => ({
  video: { broadcastId: null as string | null },
  loadChannels: vi.fn(),
  scan: {
    configurations: vi.fn(),
    transponders: vi.fn(),
    deleteTransponders: vi.fn(),
    deleteChannels: vi.fn(async (_ids: string[]) => true),
    deleteAllChannels: vi.fn(async () => ({ ok: true, restored: true })),
    signal: vi.fn(async () => null),
    tune: vi.fn(async () => true),
    cancelTune: vi.fn(async () => undefined),
    saveLnb: vi.fn(async () => true),
    saveAndCheck: vi.fn(async (): Promise<string[] | null> => []),
  },
  toastMock: vi.fn(),
}));

vi.mock('../services/satellite-scan', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/satellite-scan')>();
  return { ...actual, SatelliteScan: scan };
});
vi.mock('../services/broadcast-service', () => ({
  BroadcastService: {
    activeRoute: null,
    request: vi.fn(async () => null),
    loadChannels: (...args: unknown[]) => loadChannels(...args),
    useSample: vi.fn(),
    removeSample: vi.fn(() => true),
  },
}));
vi.mock('../services/broadcast-cache', () => ({
  BroadcastCache: {
    load: async () => undefined,
    channels: () => null,
    saveChannels: vi.fn(() => true),
  },
}));
const share = vi.hoisted(() => ({
  subscribe: () => () => undefined, stop: vi.fn(), start: vi.fn(async () => undefined), publish: vi.fn(),
  publishSettings: vi.fn(), state: 'off', active: false, viewerUrl: null,
  onApply: null as ((message: unknown) => boolean) | null,
}));
vi.mock('../services/finder-share', () => ({ FinderShare: share }));
vi.mock('./broadcast-video', () => ({
  BroadcastVideo: class {
    prepare(): Promise<string | null> { return Promise.resolve(video.broadcastId); }
    start(): void {}
    stop(): void {}
    showPreview(): void {}
  },
}));
vi.mock('./toast', () => ({ showToast: toastMock }));

const { SatelliteScanSession } = await import('../services/satellite-scan-session');
const { StorageService } = await import('../services/storage-service');
const { addedDetail, channelsByTransponder, logScrollStep, revealDelta, SatelliteTools, SHARE_GUTTER_PX } = await import('./satellite-tools');

describe('revealDelta', () => {
  const view = { top: 128, bottom: 1080 };

  // Measured on a TV: the share block ended exactly at the screen's bottom edge.
  it('leaves a gutter below a block that ends at the bottom edge', () => {
    const delta = revealDelta(view, { top: 791, bottom: 1080 }, SHARE_GUTTER_PX);
    expect(1080 - delta).toBeLessThanOrEqual(view.bottom - 32);
  });

  it('never scrolls the block top out of view', () => {
    expect(revealDelta(view, { top: 140, bottom: 1300 }, 40)).toBe(12);
  });

  it('leaves a block that already shows with its gutter alone', () => {
    expect(revealDelta(view, { top: 500, bottom: 1000 }, 40)).toBe(0);
  });
});

describe('logScrollStep', () => {
  const page = { top: 128, bottom: 1080 };

  // The scan's list ran below the screen: Down scrolled the hidden list and
  // the page only followed once the list reached its end.
  it('brings a list that runs below the screen into view before scrolling it', () => {
    const step = logScrollStep('down', page, { top: 760, bottom: 1300 }, { top: 660 }, 0, 2000);
    expect(step).toEqual({ page: 260, list: 0 });
  });

  it('keeps the button on screen while it brings the list in', () => {
    const step = logScrollStep('down', page, { top: 300, bottom: 1900 }, { top: 200 }, 0, 2000);
    expect(step.page).toBe(72);
  });

  it('scrolls the list once it shows, and stops at its end', () => {
    expect(logScrollStep('down', page, { top: 300, bottom: 900 }, { top: 200 }, 0, 500).list).toBeGreaterThan(0);
    expect(logScrollStep('down', page, { top: 300, bottom: 900 }, { top: 200 }, 500, 500)).toEqual({ page: 0, list: 0 });
  });

  it('scrolls the list back on Up, then lets focus move', () => {
    expect(logScrollStep('up', page, { top: 300, bottom: 900 }, { top: 200 }, 50, 500)).toEqual({ page: 0, list: -50 });
    expect(logScrollStep('up', page, { top: 300, bottom: 900 }, { top: 200 }, 0, 500)).toEqual({ page: 0, list: 0 });
  });
});

function channel(id: string, satellite: string, transponderId: number, frequency = 0): BroadcastChannel {
  return {
    id, serviceKey: `tv:${id}`, number: 0, numberLabel: '', name: id, kind: 'tv', source: 'satellite', satellite,
    frequency, transponderId, hd: false, scrambled: false, locked: false, logo: '',
  };
}

describe('channelsByTransponder', () => {
  const list: Transponder[] = [
    { id: 1, frequency: 11000, polarization: 'H', symbolRate: 27500, system: 'DVB-S2' },
    { id: 2, frequency: 11100, polarization: 'V', symbolRate: 27500, system: 'DVB-S' },
    { id: 3, frequency: 11100, polarization: 'H', symbolRate: 27500, system: 'DVB-S' },
  ];

  // Every transponder deleted, yet the satellite kept its 29 channels.
  it('finds the channels a deleted transponder left behind', () => {
    const { on, orphans } = channelsByTransponder(
      [channel('ch1', 'Sat A', 1), channel('ch2', 'Sat A', 364), channel('ch3', 'Sat B', 364)], 'Sat A', list);
    expect(on.get(1)?.map(item => item.id)).toEqual(['ch1']);
    expect(orphans.map(item => item.id)).toEqual(['ch2']);
    expect(channelsByTransponder([channel('ch2', 'Sat A', 364)], 'Sat A', []).orphans).toHaveLength(1);
  });

  it('places a channel without a transponder id by frequency only when that is unambiguous', () => {
    const { on, orphans } = channelsByTransponder(
      [channel('ch1', 'Sat A', 0, 11001), channel('ch2', 'Sat A', 0, 11100)], 'Sat A', list);
    expect(on.get(1)?.map(item => item.id)).toEqual(['ch1']);
    expect(orphans.map(item => item.id)).toEqual(['ch2']);
  });
});

function config(id: number, name: string): SatelliteConfig {
  return {
    id, satelliteId: id * 10, satelliteName: name,
    lnb: { type: 'KU_BAND', min: 9750, max: 10600 }, diseqc: 'OFF_DISEQC', tone: 'OFF_22KHZTONE',
    lnbPower: true, selected: true, networkSearch: true, blindSearch: false, skipScrambled: false,
    supportsNetworkSearch: true, supportsBlindSearch: true, supportsSkipScrambled: true, scanInfo: {}, scanOption: {},
  };
}

const TPS: Transponder[] = [
  { id: 1, frequency: 11000, polarization: 'H', symbolRate: 27500, system: 'DVB-S2' },
  { id: 2, frequency: 11100, polarization: 'V', symbolRate: 27500, system: 'DVB-S' },
  { id: 3, frequency: 11200, polarization: 'H', symbolRate: 30000, system: 'DVB-S2' },
];

// Focus scopes register once, so every test reopens the same tools.
const toolOptions = { onRevealTabBar: vi.fn(), onBack: vi.fn(), onChannelsChanged: vi.fn(), onOrderChanged: vi.fn() };
let sharedTools: { container: HTMLElement; tools: InstanceType<typeof SatelliteTools> } | null = null;

function openTools(): { container: HTMLElement; tools: InstanceType<typeof SatelliteTools> } {
  if (!sharedTools) {
    Element.prototype.scrollIntoView = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    sharedTools = { container, tools: new SatelliteTools(container, toolOptions) };
  }
  return sharedTools;
}

describe('SatelliteTools', () => {
  let container: HTMLElement;
  let tools: InstanceType<typeof SatelliteTools>;
  let stored: Transponder[];

  const q = <T extends HTMLElement = HTMLElement>(selector: string): T | null => container.querySelector<T>(selector);
  const key = (k: string) => q(`[data-key="${k}"]`);
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));

  beforeEach(async () => {
    stored = TPS.slice();
    loadChannels.mockResolvedValue({ ok: false, reason: 'unsupported' });
    scan.configurations.mockResolvedValue([config(1, 'Alpha'), config(2, 'Bravo')]);
    scan.transponders.mockImplementation(async (item: SatelliteConfig) => (item.id === 1 ? stored.slice() : []));
    scan.deleteTransponders.mockImplementation(async (_item: SatelliteConfig, targets: Transponder[]) => {
      const gone = new Set(targets.map(target => target.id));
      stored = stored.filter(target => !gone.has(target.id));
      return true;
    });
  });

  beforeAll(() => {
    ({ container, tools } = openTools());
  });

  afterEach(() => {
    tools.close();
    vi.clearAllMocks();
  });

  it('lists three sections, each with its own icon', async () => {
    await tools.open('finder');
    const icons = Array.from(container.querySelectorAll('.settings-sidebar .settings-nav-icon')).map(icon => icon.innerHTML);
    expect(container.querySelectorAll('[data-tool]').length).toBe(3);
    expect(new Set(icons).size).toBe(3);
  });

  it('scans a transponder from the signal finder, with New transponder as its own button', async () => {
    await tools.open('finder');
    await settle();
    expect(key('sat-tools-tp-scan')).not.toBeNull();
    expect(q('.sat-tools-share')).not.toBeNull();
    expect(q('.dropdown-option[data-dropdown-value="new"]')).toBeNull();
    expect(container.querySelectorAll('.dropdown-option').length).toBe(TPS.length);
    expect(key('sat-tools-frequency')).toBeNull();
    expect(key('sat-tools-new-tp')!.getAttribute('aria-pressed')).toBe('false');
    key('sat-tools-new-tp')!.click();
    expect(key('sat-tools-frequency')).not.toBeNull();
    expect(key('sat-tools-new-tp')!.getAttribute('aria-pressed')).toBe('true');
    expect(q('#sat-tools-tp .dropdown-current')!.textContent).toBe('11000 H 27500 DVB-S2');
  });

  // The finder kept opening on the TV's old transponder however many times
  // another one was tuned.
  it('has the TV store the transponder last tuned, once the finder closes', async () => {
    video.broadcastId = 'b1';
    try {
      await tools.open('finder');
      await settle();
      q<HTMLElement>('.dropdown-option[data-dropdown-value="2"]')!.click();
      await new Promise(resolve => setTimeout(resolve, 600));
      expect(scan.tune).toHaveBeenLastCalledWith('b1', expect.objectContaining({ id: 1 }),
        { frequency: 11100, polarization: 'V', symbolRate: 27500, system: 'DVB-S' }, expect.anything());
      expect(scan.saveLnb).not.toHaveBeenCalled();
      tools.close();
      expect(scan.saveLnb).toHaveBeenCalledTimes(1);
      expect(scan.saveLnb.mock.calls[0][0]).toMatchObject({
        id: 1,
        scanInfo: { selectedTp: {
          transponderId: 2, frequency: 11100, polarisation: 'VERTICAL_POLARISATION', symbolRate: 27500,
          transmissionSystem: 'TRANSMISSIONSYSTEM_DVBS', homeTp: false,
        } },
      });
    } finally {
      video.broadcastId = null;
    }
  });

  it('saves the setup and the shown transponder to the TV, then says whether it kept them', async () => {
    await tools.open('finder');
    await settle();
    q<HTMLElement>('.dropdown-option[data-dropdown-value="3"]')!.click();
    key('sat-tools-save')!.click();
    await settle();
    expect(scan.saveAndCheck).toHaveBeenCalledTimes(1);
    expect(scan.saveAndCheck.mock.calls[0][0]).toMatchObject({
      id: 1, scanInfo: { selectedTp: { transponderId: 3, frequency: 11200, symbolRate: 30000 } },
    });
    expect(key('sat-tools-save')!.nextElementSibling!.textContent).toBe('Saved and checked on the TV');

    scan.saveAndCheck.mockResolvedValueOnce(['diseqc', 'lnb']);
    key('sat-tools-save')!.click();
    await settle();
    expect(key('sat-tools-save')!.nextElementSibling!.textContent).toBe('The TV didn’t keep: DiSEqC port, LNB frequency');

    scan.saveAndCheck.mockResolvedValueOnce(null);
    key('sat-tools-save')!.click();
    await settle();
    expect(key('sat-tools-save')!.nextElementSibling!.textContent).toBe('Couldn’t save to the TV');
    // Already saved: closing writes nothing more.
    tools.close();
    expect(scan.saveLnb).not.toHaveBeenCalled();
  });

  describe('settings from the phone', () => {
    const apply = (patch: Record<string, unknown> = {}) => ({
      v: 1, req: 'abcdef01', satellite: 2, lnb: 2, diseqc: 'B_DISEQC', tone: 'A_22KHZTONE', lnbPower: false,
      form: { frequency: 12000, polarization: 'V', symbolRate: 22000, system: 'DVB-S' }, ...patch,
    });

    afterEach(() => {
      share.state = 'off';
      video.broadcastId = null;
    });

    it('tunes them as if picked on the TV, saving the satellite\u2019s new LNB setup', async () => {
      video.broadcastId = 'b1';
      await tools.open('finder');
      await settle();
      expect(share.onApply!(apply())).toBe(true);
      expect(q('#sat-tools-satellite [aria-pressed="true"], #sat-tools-satellite .active')?.textContent?.trim()).toBe('Bravo');
      expect(q('#sat-tools-tp .dropdown-current')!.textContent).toBe('12000 V 22000 DVB-S');
      await new Promise(resolve => setTimeout(resolve, 600));
      expect(scan.saveLnb).toHaveBeenCalledWith(expect.objectContaining({
        id: 2, lnb: { type: 'KU_BAND', min: 9750, max: 9750 }, diseqc: 'B_DISEQC', tone: 'A_22KHZTONE', lnbPower: false,
      }));
      expect(scan.tune).toHaveBeenLastCalledWith('b1', expect.objectContaining({ id: 2 }),
        { frequency: 12000, polarization: 'V', symbolRate: 22000, system: 'DVB-S' }, expect.anything());
    });

    it('retunes without saving when the LNB setup is the same', async () => {
      video.broadcastId = 'b1';
      await tools.open('finder');
      await settle();
      expect(share.onApply!(apply({ satellite: 1, lnb: 0, diseqc: 'OFF_DISEQC', tone: 'OFF_22KHZTONE', lnbPower: true }))).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(scan.saveLnb).not.toHaveBeenCalled();
      expect(scan.tune).toHaveBeenLastCalledWith('b1', expect.objectContaining({ id: 1 }),
        { frequency: 12000, polarization: 'V', symbolRate: 22000, system: 'DVB-S' }, expect.anything());
    });

    it('refuses a satellite or option the TV doesn\u2019t have, and says why', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      await tools.open('finder');
      await settle();
      expect(share.onApply!(apply({ satellite: 9 }))).toBe(false);
      expect(share.onApply!(apply({ diseqc: 'E_DISEQC' }))).toBe(false);
      expect(share.onApply!(apply({ lnb: 7 }))).toBe(false);
      const lines = warn.mock.calls.map(call => call.join(' ')).filter(line => line.includes('event=satellite.share.rejected'));
      expect(lines.map(line => /reason=(\w+)/.exec(line)?.[1])).toEqual(['satellite', 'invalid', 'invalid']);
      expect(q('#sat-tools-satellite [aria-pressed="true"], #sat-tools-satellite .active')?.textContent?.trim()).toBe('Alpha');
      warn.mockRestore();
    });

    it('refuses settings while another tool is open', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      await tools.open('scan');
      await settle();
      expect(share.onApply!(apply())).toBe(false);
    });

    it('shares every satellite with its transponders once the share is live', async () => {
      await tools.open('finder');
      await settle();
      share.state = 'live';
      share.subscribe = () => () => undefined;
      key('sat-tools-new-tp')!.click();
      await new Promise(resolve => setTimeout(resolve, 400));
      const settings = share.publishSettings.mock.calls.at(-1)?.[0];
      expect(settings.satellite).toBe(1);
      expect(settings.satellites.map((item: { name: string }) => item.name)).toEqual(['Alpha', 'Bravo']);
      expect(settings.satellites[0].tps[1]).toEqual([2, 11100, 'V', 27500, 'DVB-S']);
      expect(settings.satellites[0].tp).toBe(0);
      expect(settings.lnbs[0]).toEqual({ label: '9750/10600', universal: true });
    });
  });

  it('opens a satellite’s transponders and deletes the selected ones', async () => {
    await tools.open('scan');
    await settle();
    const open = key('sat-tools-tps:1')!;
    expect(open.textContent).toContain('3');
    open.click();
    await settle();
    expect(container.querySelectorAll('.sat-tools-tpm-row').length).toBe(3);
    expect(key('tpm-delete')!.getAttribute('aria-disabled')).toBe('true');
    key('tpm:2')!.click();
    expect(key('tpm-delete')!.hasAttribute('aria-disabled')).toBe(false);
    key('tpm-delete')!.click();
    document.querySelector<HTMLElement>('.confirmation-prompt [data-confirm-action="confirm"]')!.click();
    await settle();
    await settle();
    expect(scan.deleteTransponders).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), [TPS[1]]);
    expect(Array.from(container.querySelectorAll('.sat-tools-tpm-row')).map(row => row.getAttribute('data-tp')))
      .toEqual(['1', '3']);
    tools.handleAction('back');
    expect(q('.sat-tools-tpm-row')).toBeNull();
    expect(key('sat-tools-tps:1')!.textContent).toContain('2');
  });

  it('deletes every transponder of a satellite', async () => {
    await tools.open('scan');
    await settle();
    key('sat-tools-tps:1')!.click();
    await settle();
    key('tpm-delete-all')!.click();
    document.querySelector<HTMLElement>('.confirmation-prompt [data-confirm-action="confirm"]')!.click();
    await settle();
    await settle();
    expect(scan.deleteTransponders).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), TPS);
    expect(q('.sat-tools-tpm-row')).toBeNull();
    expect(container.textContent).toContain('No transponders for this satellite.');
  });

  it('deletes a transponder’s channels with it, and the channels left without one', async () => {
    let saved = [channel('ch1', 'Alpha', 2), channel('ch2', 'Alpha', 2), channel('ch3', 'Alpha', 364)];
    loadChannels.mockImplementation(async () => ({ ok: true, route: 'root', channels: saved.slice(), currentId: null }));
    scan.deleteChannels.mockImplementation(async (ids: string[]) => {
      saved = saved.filter(item => !ids.includes(item.id));
      return true;
    });
    await tools.open('scan');
    await settle();
    key('sat-tools-tps:1')!.click();
    await settle();
    expect(key('tpm:2')!.textContent).toContain('2 channels');
    expect(key('tpm-orphans')).not.toBeNull();
    key('tpm:2')!.click();
    key('tpm-delete')!.click();
    expect(document.querySelector('.confirmation-prompt:not(.hidden)')!.textContent).toContain('Saved channels are deleted too: 2.');
    document.querySelector<HTMLElement>('.confirmation-prompt [data-confirm-action="confirm"]')!.click();
    await settle();
    await settle();
    expect(scan.deleteChannels).toHaveBeenCalledWith(['ch1', 'ch2']);
    key('tpm-orphans')!.click();
    document.querySelector<HTMLElement>('.confirmation-prompt [data-confirm-action="confirm"]')!.click();
    await settle();
    await settle();
    expect(scan.deleteChannels).toHaveBeenLastCalledWith(['ch3']);
    expect(key('tpm-orphans')).toBeNull();
  });

  it('lists the channels a scan finds newest first, with their frequency', async () => {
    const found = [channel('ch1', 'Alpha', 1, 11034), channel('ch2', 'Alpha', 2, 12034)];
    SatelliteScanSession.state = {
      ...SatelliteScanSession.state, phase: 'running', startedAt: Date.now(), added: found, fresh: [],
    };
    try {
      await tools.open('scan');
      const rows = Array.from(container.querySelectorAll('.sat-tools-log-row'));
      expect(rows.map(row => row.getAttribute('data-key'))).toEqual(['added:ch2', 'added:ch1']);
      expect(rows[0].querySelector('.sat-tools-added-index')!.textContent).toBe('2');
      expect(rows[0].querySelector('.sat-tools-added-kind')!.textContent).toBe('TV · Alpha · 12034 MHz');
    } finally {
      SatelliteScanSession.state = { ...SatelliteScanSession.state, phase: 'idle', added: null };
    }
  });

  it('deletes all channels after a confirmation, then reads the satellites again', async () => {
    await tools.open('scan');
    await settle();
    const before = scan.configurations.mock.calls.length;
    key('sat-tools-wipe')!.click();
    expect(scan.deleteAllChannels).not.toHaveBeenCalled();
    document.querySelector<HTMLElement>('.confirmation-prompt [data-confirm-action="confirm"]')!.click();
    expect(key('sat-tools-wipe')!.getAttribute('aria-busy')).toBe('true');
    expect(key('scan-start')!.getAttribute('aria-disabled')).toBe('true');
    await settle();
    await settle();
    expect(scan.deleteAllChannels).toHaveBeenCalledTimes(1);
    expect(scan.configurations.mock.calls.length).toBeGreaterThan(before);
    expect(toastMock).toHaveBeenCalledWith('All channels deleted');
    expect(key('sat-tools-wipe')!.hasAttribute('aria-busy')).toBe(false);
  });
});

describe('addedDetail', () => {
  it('leaves out a frequency the TV did not give', () => {
    expect(addedDetail(channel('ch1', 'Alpha', 0, 0))).toBe('TV · Alpha');
  });
});

function service(key: string, name: string, kind: 'tv' | 'radio' = 'tv'): BroadcastChannel {
  return {
    id: `id_${key}`, serviceKey: `${kind}:${key}`, number: 0, numberLabel: '', name, kind, source: 'satellite',
    satellite: 'Alpha', frequency: 0, transponderId: 0, hd: false, scrambled: false, locked: false, logo: '',
  };
}

describe('SatelliteTools channel manager', () => {
  let container: HTMLElement;
  let tools: InstanceType<typeof SatelliteTools>;
  let lineup: BroadcastChannel[];
  const { onOrderChanged, onChannelsChanged } = toolOptions;

  const q = <T extends HTMLElement = HTMLElement>(selector: string): T | null => container.querySelector<T>(selector);
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const names = (side: 'left' | 'right') => Array.from(container.querySelectorAll(`[data-cm-side="${side}"] .channel-name`))
    .map(el => el.textContent);
  const numbers = (side: 'left' | 'right') => Array.from(container.querySelectorAll(`[data-cm-side="${side}"] .sat-number`))
    .map(el => el.textContent);
  const row = (side: 'left' | 'right', key: string) => q(`[data-cm-side="${side}"][data-cm-service="${key}"]`)!;
  const confirm = () => document.querySelector<HTMLElement>('.confirmation-prompt:not(.hidden) [data-confirm-action="confirm"]')!.click();

  async function typeNumber(side: 'left' | 'right', key: string, text: string): Promise<void> {
    row(side, key).click();
    const input = q<HTMLInputElement>('[data-cm-entry]')!;
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    tools.handleAction('select');
    await settle();
  }

  beforeAll(() => {
    ({ container, tools } = openTools());
  });

  beforeEach(async () => {
    StorageService.setSatelliteOrder([]);
    lineup = [service('a', 'Alpha'), service('b', 'Bravo'), service('c', 'Charlie'), service('d', 'Delta'),
      service('r1', 'Radio One', 'radio'), service('r2', 'Radio Two', 'radio')];
    loadChannels.mockImplementation(async () => ({ ok: true, route: 'root', channels: lineup.slice(), currentId: null }));
    scan.configurations.mockResolvedValue(null);
    scan.deleteChannels.mockImplementation(async (ids: string[]) => {
      lineup = lineup.filter(item => !ids.includes(item.id));
      return true;
    });
    await tools.open('manager');
    await settle();
  });

  afterEach(() => {
    tools.close();
    vi.clearAllMocks();
  });

  it('starts with the new order the same as the TV’s, without the tuner tools', () => {
    expect(names('left')).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);
    expect(names('right')).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);
    expect(numbers('right')).toEqual(['1', '2', '3', '4']);
    expect(q('.sat-tools-live')).toBeNull();
    expect(container.textContent).not.toContain('Satellite tools need');
  });

  it('moves a channel to the typed number, renumbers the rest, and saves at once', async () => {
    await typeNumber('left', 'tv:c', '1');
    expect(names('right')).toEqual(['Charlie', 'Alpha', 'Bravo', 'Delta']);
    expect(numbers('right')).toEqual(['1', '2', '3', '4']);
    expect(names('left')).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);
    expect(StorageService.getSatelliteOrder().slice(0, 4)).toEqual(['tv:c', 'tv:a', 'tv:b', 'tv:d']);
    expect(onOrderChanged).toHaveBeenCalledTimes(1);
    expect(row('right', 'tv:c').classList.contains('sat-cm-moved')).toBe(true);
  });

  it('keeps the new order when the manager opens again', async () => {
    await typeNumber('right', 'tv:a', '4');
    tools.close();
    await tools.open('manager');
    await settle();
    expect(names('right')).toEqual(['Bravo', 'Charlie', 'Delta', 'Alpha']);
  });

  it('opens again on the TV’s own order, without a filter', async () => {
    q('[data-key="sat-cm-sort:za"]')!.click();
    tools.close();
    await tools.open('manager');
    await settle();
    expect(names('left')).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);
    expect(q('[data-key="sat-cm-sort:default"]')!.classList.contains('active')).toBe(true);
  });

  it('puts a number past the end last', async () => {
    await typeNumber('right', 'tv:a', '99');
    expect(names('right')).toEqual(['Bravo', 'Charlie', 'Delta', 'Alpha']);
  });

  it('leaves the order alone when Back cancels the number', async () => {
    row('left', 'tv:d').click();
    expect(q('[data-cm-entry]')).not.toBeNull();
    tools.handleAction('back');
    expect(q('[data-cm-entry]')).toBeNull();
    expect(names('right')).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);
    expect(onOrderChanged).not.toHaveBeenCalled();
  });

  it('filters and sorts the original order only, and Clear brings it back', async () => {
    const filter = q<HTMLInputElement>('[data-cm-filter]')!;
    filter.value = 'ARL';
    filter.dispatchEvent(new Event('input', { bubbles: true }));
    expect(names('left')).toEqual(['Charlie']);
    expect(names('right')).toHaveLength(4);
    q('[data-cm-action="clear"]')!.click();
    expect(names('left')).toHaveLength(4);
    expect(q<HTMLInputElement>('[data-cm-filter]')!.value).toBe('');
    q('[data-key="sat-cm-sort:za"]')!.click();
    expect(names('left')).toEqual(['Delta', 'Charlie', 'Bravo', 'Alpha']);
    expect(names('right')).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);
  });

  it('numbers radio apart from TV', async () => {
    q('[data-key="sat-cm-kind:radio"]')!.click();
    expect(names('right')).toEqual(['Radio One', 'Radio Two']);
    await typeNumber('right', 'radio:r2', '1');
    expect(names('right')).toEqual(['Radio Two', 'Radio One']);
    q('[data-key="sat-cm-kind:tv"]')!.click();
    expect(names('right')).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);
  });

  it('deletes the selected channel from the TV after Red and a confirmation', async () => {
    await typeNumber('left', 'tv:b', '1');
    row('left', 'tv:b').click();
    tools.handleAction('back');
    tools.handleAction('red');
    expect(document.querySelector('.confirmation-prompt:not(.hidden)')!.textContent).toContain('Delete “Bravo”?');
    confirm();
    await settle();
    await settle();
    expect(scan.deleteChannels).toHaveBeenCalledWith(['id_b']);
    expect(names('left')).toEqual(['Alpha', 'Charlie', 'Delta']);
    expect(names('right')).toEqual(['Alpha', 'Charlie', 'Delta']);
    expect(StorageService.getSatelliteOrder()).not.toContain('tv:b');
    expect(onChannelsChanged).toHaveBeenCalled();
  });

  it('keeps a channel the TV refused to delete, and says so', async () => {
    scan.deleteChannels.mockResolvedValue(false);
    row('left', 'tv:a').click();
    tools.handleAction('back');
    tools.handleAction('red');
    confirm();
    await settle();
    await settle();
    expect(names('left')).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);
    expect(toastMock).toHaveBeenCalledWith('Couldn’t delete the channel');
    expect(onChannelsChanged).not.toHaveBeenCalled();
  });
});
