// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel } from '../types';

const client = vi.hoisted(() => ({
  available: vi.fn(() => true),
  locations: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  subscribe: vi.fn(),
}));
const showToast = vi.hoisted(() => vi.fn());

vi.mock('../services/recording-client', () => ({ RecordingClient: client }));
vi.mock('../services/epg-service', () => ({
  EpgService: { findChannelId: () => null, getNowPlaying: () => null },
}));
vi.mock('./toast', () => ({ showToast }));

import { RecordingController } from './recording-controller';

const CHANNEL = { id: 'ch1', name: 'Alpha', logo: '', url: 'http://host/a', extras: null } as unknown as Channel;

function controller(): RecordingController {
  return new RecordingController(document.createElement('div'), {
    target: () => ({ channel: CHANNEL, url: CHANNEL.url }),
    onRecordingsChanged: vi.fn(),
    onStateChanged: vi.fn(),
  });
}

describe('RecordingController without the bundled service', () => {
  beforeEach(() => {
    client.subscribe.mockReset();
    client.locations.mockReset();
    showToast.mockReset();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('keeps Record on offer and explains this TV can\'t record when the service is absent', () => {
    client.subscribe.mockImplementation((_onStatus: unknown, onUnavailable: () => void) => {
      onUnavailable();
      return null;
    });
    const recording = controller();
    expect(recording.canRecord()).toBe(true);
    recording.toggle();
    expect(showToast).toHaveBeenCalledWith('Recording isn’t available on your TV');
    expect(client.locations).not.toHaveBeenCalled();
  });

  it('says recording is unavailable, not that storage is missing, when the service does not answer', async () => {
    client.subscribe.mockReturnValue(null);
    client.locations.mockResolvedValue(null);
    const recording = controller();
    recording.toggle();
    await vi.waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(showToast).toHaveBeenCalledWith('Recording isn’t available on your TV');
    expect(showToast).not.toHaveBeenCalledWith('No storage available for recording');
    expect(recording.canRecord()).toBe(true);
  });

  it('still reports missing storage when the service lists none', async () => {
    client.subscribe.mockReturnValue(null);
    client.locations.mockResolvedValue([]);
    controller().toggle();
    await vi.waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(showToast).toHaveBeenCalledWith('No storage available for recording');
  });
});
