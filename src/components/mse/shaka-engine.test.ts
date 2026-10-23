import { describe, expect, it, vi } from 'vitest';
import { createShakaEngine, type ShakaPlayerLike } from './shaka-engine';

describe('Shaka stream information', () => {
  it('selects a quality without changing audio and re-enables adaptation for Auto', () => {
    const base = {
      active: false, audioId: 1, audioCodec: 'mp4a.40.2', channelsCount: 2,
      videoCodec: 'avc1', hdr: '', frameRate: 30, language: 'l1',
    };
    const tracks = [
      { ...base, id: 10, active: true, width: 854, height: 480, bandwidth: 1000000 },
      { ...base, id: 20, width: 1920, height: 1080, bandwidth: 5000000 },
      { ...base, id: 30, audioId: 2, language: 'l2', width: 1920, height: 1080, bandwidth: 5000000 },
    ];
    const player = {
      getAudioTracks: () => [], getTextTracks: () => [], getVariantTracks: () => tracks,
      selectAudioTrack: vi.fn(), selectTextTrack: vi.fn(), selectVariantTrack: vi.fn(),
      configure: vi.fn(() => true), destroy: vi.fn(),
    };
    const engine = createShakaEngine(player);
    expect(engine.qualityOptions?.().map(option => option.index)).toEqual([10, 20]);
    expect(engine.selectQuality?.(20)).toBe(true);
    expect(player.configure).toHaveBeenLastCalledWith({ abr: { enabled: false } });
    expect(player.selectVariantTrack).toHaveBeenCalledWith(tracks[1], true, 0);
    expect(engine.selectQuality?.(30)).toBe(false);
    expect(engine.selectQuality?.(-1)).toBe(true);
    expect(player.configure).toHaveBeenLastCalledWith({ abr: { enabled: true } });
    expect(player.selectAudioTrack).not.toHaveBeenCalled();
  });

  it.each([
    ['ec-3', true, true],
    [' EC-3 ', true, true],
    ['ec-3', false, false],
    ['ec-3', undefined, false],
    ['ac-4', true, false],
    ['mp4a.40.2', true, false],
  ] as const)('maps codec %s and spatialAudio %s to Atmos %s', (audioCodec, spatialAudio, expected) => {
    const track = {
      active: true, audioCodec, spatialAudio, channelsCount: 6,
      videoCodec: 'dvh1.05.06', hdr: 'PQ', frameRate: 59.94,
    };
    const player: ShakaPlayerLike = {
      getAudioTracks: () => [],
      getTextTracks: () => [],
      getVariantTracks: () => [track],
      selectAudioTrack: vi.fn(),
      selectTextTrack: vi.fn(),
      destroy: vi.fn(),
    };
    const engine = createShakaEngine(player);
    expect(engine.streamInfo()).toEqual({
      videoCodec: 'dvh1.05.06', audioCodec, videoRange: 'PQ',
      frameRate: 59.94, audioChannels: '6', audioAtmos: expected,
    });
    track.active = false;
    expect(engine.streamInfo()).toBeNull();
  });
});
