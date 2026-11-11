import { describe, expect, it } from 'vitest';
import { findIntroMarker, inIntro } from './intro-marker';

interface FakeCue { id?: string; text?: string; value?: { key?: string; data?: unknown }; startTime: number; endTime: number }

function track(kind: string, cues: FakeCue[], mode = 'hidden') {
  return { kind, mode, cues: mode === 'disabled' ? null : cues };
}

function list(...tracks: ReturnType<typeof track>[]): TextTrackList {
  const out: Record<number, unknown> & { length: number } = { length: tracks.length };
  tracks.forEach((t, i) => { out[i] = t; });
  return out as unknown as TextTrackList;
}

describe('findIntroMarker', () => {
  it('finds a chapter named Intro', () => {
    const tracks = list(track('chapters', [
      { text: 'Chapter 1', startTime: 0, endTime: 10 },
      { text: 'Intro', startTime: 10, endTime: 70 },
    ]));
    expect(findIntroMarker(tracks)).toEqual({ start: 10, end: 70 });
  });

  it('finds a metadata cue by id or value, as hls.js date ranges carry', () => {
    expect(findIntroMarker(list(track('metadata', [{ id: 'opening', startTime: 5, endTime: 40 }]))))
      .toEqual({ start: 5, end: 40 });
    expect(findIntroMarker(list(track('metadata', [{ value: { key: 'CLASS', data: 'intro' }, startTime: 0, endTime: 30 }]))))
      .toEqual({ start: 0, end: 30 });
  });

  it('ignores subtitles, short cues, and names that only contain the word', () => {
    expect(findIntroMarker(list(
      track('subtitles', [{ text: 'Intro', startTime: 0, endTime: 60 }]),
      track('chapters', [{ text: 'Intro', startTime: 0, endTime: 2 }]),
      track('chapters', [{ text: 'Introduction 1', startTime: 0, endTime: 60 }]),
    ))).toBeNull();
    expect(findIntroMarker(null)).toBeNull();
  });

  it('turns a disabled chapter track on so its cues load', () => {
    const chapters = track('chapters', [], 'disabled');
    findIntroMarker(list(chapters));
    expect(chapters.mode).toBe('hidden');
  });
});

describe('inIntro', () => {
  it('holds from the start until a second before the end', () => {
    const marker = { start: 10, end: 70 };
    expect(inIntro(marker, 9)).toBe(false);
    expect(inIntro(marker, 10)).toBe(true);
    expect(inIntro(marker, 68.9)).toBe(true);
    expect(inIntro(marker, 69)).toBe(false);
    expect(inIntro(null, 20)).toBe(false);
  });
});
