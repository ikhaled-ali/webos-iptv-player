import { formatTime } from './time';

type ClockListener = (time: string) => void;

const MINUTE_MS = 60000;
// Lands just past the minute, so a late-firing timer never shows the old one.
const TICK_SLACK_MS = 50;

const listeners: ClockListener[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

// The time of day as every clock shows it: the Guide's format and timezone.
export function clockTime(now: Date = new Date()): string {
  return formatTime(now);
}

// One timer for every clock on screen, re-aimed at each minute boundary so
// it never drifts, even after the TV wakes from standby.
function schedule(): void {
  timer = setTimeout(tick, MINUTE_MS - (Date.now() % MINUTE_MS) + TICK_SLACK_MS);
}

function tick(): void {
  timer = null;
  const time = clockTime();
  listeners.slice().forEach(listener => listener(time));
  if (listeners.length > 0) schedule();
}

export function onClockTick(listener: ClockListener): () => void {
  listeners.push(listener);
  if (timer === null) schedule();
  return () => {
    const index = listeners.indexOf(listener);
    if (index >= 0) listeners.splice(index, 1);
    if (listeners.length === 0 && timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
}
