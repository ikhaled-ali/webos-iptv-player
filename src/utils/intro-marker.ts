export interface IntroMarker {
  start: number;
  end: number;
}

const INTRO_NAME = /(^|[^a-z])(intro|opening)([^a-z]|$)/i;
// Too short to be worth a button.
const MIN_LENGTH = 5;

interface MarkerCue {
  id?: string;
  text?: string;
  value?: { key?: string; data?: unknown };
  startTime: number;
  endTime: number;
}

function cueName(cue: MarkerCue): string {
  const value = cue.value && typeof cue.value.data === 'string' ? cue.value.data : '';
  return [cue.id ?? '', cue.text ?? '', value].join(' ');
}

/** The stream's own intro: a chapter or metadata cue named Intro/Opening. A
 *  disabled chapter track holds no cues, so it is switched to hidden first. */
export function findIntroMarker(list: TextTrackList | null | undefined): IntroMarker | null {
  if (!list) return null;
  for (let i = 0; i < list.length; i++) {
    const track = list[i];
    if (track.kind !== 'chapters' && track.kind !== 'metadata') continue;
    if (track.mode === 'disabled') track.mode = 'hidden';
    const cues = track.cues;
    if (!cues) continue;
    for (let j = 0; j < cues.length; j++) {
      const cue = cues[j] as unknown as MarkerCue;
      const end = cue.endTime;
      if (!Number.isFinite(end) || end - cue.startTime < MIN_LENGTH) continue;
      if (INTRO_NAME.test(cueName(cue))) return { start: Math.max(0, cue.startTime), end };
    }
  }
  return null;
}

/** Whether `position` is inside the intro, leaving its last second alone. */
export function inIntro(marker: IntroMarker | null, position: number): boolean {
  return marker !== null && position >= marker.start && position < marker.end - 1;
}
