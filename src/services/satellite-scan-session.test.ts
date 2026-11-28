// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { BroadcastChannel } from './broadcast-normalize';

vi.mock('./broadcast-service', () => ({ BroadcastService: {} }));

const { scanCounts } = await import('./satellite-scan-session');
import type { ScanSessionState } from './satellite-scan-session';

function channel(id: string, kind: 'tv' | 'radio', satellite: string): BroadcastChannel {
  return {
    id, serviceKey: `${kind}:${id}`, number: 0, numberLabel: '', name: id, kind, source: 'satellite', satellite,
    frequency: 11000, transponderId: 1, hd: false, scrambled: false, locked: false, logo: '',
  };
}

function state(patch: Partial<ScanSessionState>): ScanSessionState {
  return {
    phase: 'running', progress: 10, feed: null, report: [], added: null, error: '', stoppedByUser: false,
    startedAt: 0, skipRadio: false, fresh: [], removed: 0, ...patch,
  };
}

const status = (configurationId: number, tv: number, radio: number) => ({
  state: 'COMPLETED', configurationId, tv, radio, transponder: null,
});

describe('scanCounts', () => {
  // The TV chip said 40 while the list below it showed 3 channels.
  it('counts the listed channels once there is a list, so totals and list agree', () => {
    const counts = scanCounts(state({
      feed: { current: null, completed: [status(1, 40, 6)] },
      added: [channel('ch1', 'tv', 'Sat A'), channel('ch2', 'tv', 'Sat A'), channel('ch3', 'radio', 'Sat B')],
      report: [{ satelliteName: 'Sat A', tv: 40, radio: 0, channels: 40 }, { satelliteName: 'Sat B', tv: 0, radio: 6, channels: 6 }],
    }));
    expect(counts).toEqual({
      tv: 2, radio: 1,
      satellites: [{ satelliteName: 'Sat A', channels: 2 }, { satelliteName: 'Sat B', channels: 1 }],
    });
  });

  it('leaves radio out of every count when the scan skips it', () => {
    const counts = scanCounts(state({
      skipRadio: true,
      added: [channel('ch1', 'tv', 'Sat A'), channel('ch2', 'radio', 'Sat A')],
      report: [{ satelliteName: 'Sat A', tv: 1, radio: 1, channels: 2 }],
    }));
    expect(counts).toEqual({ tv: 1, radio: 0, satellites: [{ satelliteName: 'Sat A', channels: 1 }] });
  });

  it('shows the TV’s running totals until the first list arrives', () => {
    const counts = scanCounts(state({ feed: { current: status(2, 3, 1), completed: [status(1, 5, 2), status(1, 8, 2)] } }));
    expect([counts.tv, counts.radio]).toEqual([11, 3]);
  });
});
