import { describe, expect, it } from 'vitest';
import { matchingQuality, qualityLabel } from './playback-quality';

const low = { index: 0, width: 854, height: 480, bitrate: 1000000, frameRate: 30 };
const high = { index: 1, width: 1920, height: 1080, bitrate: 5000000, frameRate: 60 };

describe('playback quality', () => {
  it('labels the advertised resolution, frame rate, and bitrate', () => {
    expect(qualityLabel(low)).toBe('480p · 30 fps · 1.0 Mbps');
    expect(qualityLabel({ ...low, width: 0, height: 0, frameRate: 0, bitrate: 0 })).toBe('');
  });

  it('finds a chosen quality after levels are reordered and falls back to Auto when removed', () => {
    expect(matchingQuality([{ ...high, index: 0 }, { ...low, index: 1 }], low)).toBe(1);
    expect(matchingQuality([high], low)).toBe(-1);
    expect(matchingQuality([low, high], null)).toBe(-1);
  });
});
