import { CONFIG } from '../config';
import { withInstantScroll } from '../utils/dom';
import { Focus, Tier, type FocusScope } from './focus-scope';
import { InputMode } from './input-mode';
import { physicalScrollLeft, setPhysicalScrollLeft } from '../utils/scroll-axis';

interface Edge {
  track: HTMLElement;
  owner: FocusScope;
  direction: number;
}

const N = CONFIG.NAVIGATION;

export function edgeScrollTrackAt(root: HTMLElement, x: number, y: number): HTMLElement | null {
  const hit = document.elementFromPoint(x, y);
  if (!hit) return null;
  const direct = hit.closest<HTMLElement>('[data-edge-scroll]');
  if (direct && root.contains(direct)) return direct;
  if (!root.contains(hit)) return null;
  const bounds = root.getBoundingClientRect();
  if (x < Math.max(0, bounds.left) || x >= Math.min(window.innerWidth, bounds.right)
      || y < Math.max(0, bounds.top) || y >= Math.min(window.innerHeight, bounds.bottom)) return null;
  for (const track of Array.from(root.querySelectorAll<HTMLElement>('[data-edge-scroll]'))) {
    if (!hit.contains(track)) continue;
    const box = track.getBoundingClientRect();
    const left = Math.max(0, box.left + track.clientLeft);
    const right = Math.min(window.innerWidth, box.left + track.clientLeft + track.clientWidth);
    const top = Math.max(0, box.top + track.clientTop);
    const bottom = Math.min(window.innerHeight, box.top + track.clientTop + track.clientHeight);
    if (right <= left || y < top || y >= bottom || (x >= left && x < right)) continue;
    // Only extend a visible row through its own empty margin, never over a control or another layer.
    if (track.contains(document.elementFromPoint(Math.max(left, Math.min(right - 1, x)), y))) return track;
  }
  return null;
}

export function edgeScrollSpeed(scrollingMs: number): number {
  const t = Math.max(0, Math.min(1, scrollingMs / N.EDGE_SCROLL_RAMP_MS));
  const min = N.EDGE_SCROLL_MIN_SPEED_PX_PER_SECOND;
  return min + (N.EDGE_SCROLL_MAX_SPEED_PX_PER_SECOND - min) * t * t;
}

export function installEdgeScroll(
  onScroll: (track: HTMLElement) => void,
  onStop: () => void = () => {},
): () => void {
  let edge: Edge | null = null;
  let frame: number | null = null;
  let enteredAt = 0;
  let lastFrame = 0;
  let screenX: number | null = null;
  let screenY: number | null = null;
  let parked: Edge | null = null;
  let parkTimer: number | null = null;
  let parkedAt = 0;
  let parkedRan = 0;
  let handed = false;

  const unpark = (): void => {
    if (parkTimer !== null) clearTimeout(parkTimer);
    parkTimer = null;
    parked = null;
  };

  const stop = (): void => {
    const wasActive = edge !== null;
    unpark();
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    edge = null;
    if (wasActive) onStop();
  };

  const edgeAtPointer = (atEnd = false): Edge | null => {
    if (InputMode.current !== 'pointer' || document.hidden) return null;
    const point = Focus.pointerPosition();
    const keys = Focus.owner();
    // The tab bar holds the keys only until the pointer works the content below it.
    const owner = keys && keys.tier === Tier.bar ? Focus.ownerWithout(keys) : keys;
    const root = owner?.root();
    if (!point || !owner || !root) return null;
    const track = edgeScrollTrackAt(root, point.x, point.y);
    if (!track) return null;
    const max = track.scrollWidth - track.clientWidth;
    if (max <= 1) return null;
    const box = track.getBoundingClientRect();
    const left = Math.max(0, box.left + track.clientLeft);
    const right = Math.min(window.innerWidth, box.left + track.clientLeft + track.clientWidth);
    const top = Math.max(0, box.top + track.clientTop);
    const bottom = Math.min(window.innerHeight, box.top + track.clientTop + track.clientHeight);
    if (point.y < top || point.y >= bottom) return null;
    const zone = Math.min(N.EDGE_SCROLL_ZONE_PX, (right - left) / 3);
    const direction = point.x < left + zone ? -1 : point.x >= right - zone ? 1 : 0;
    if (!direction || (!atEnd && (direction < 0
      ? physicalScrollLeft(track) <= 0 : physicalScrollLeft(track) >= max - 1))) return null;
    return { track, owner, direction };
  };

  const sameEdge = (a: Edge | null, b: Edge | null): boolean =>
    !!a && !!b && a.track === b.track && a.owner === b.owner && a.direction === b.direction;

  const tick = (now: number): void => {
    frame = null;
    if (!edge || !sameEdge(edge, edgeAtPointer(true))) {
      stop();
      return;
    }
    if (now - enteredAt >= N.EDGE_SCROLL_DWELL_MS) {
      // Direct manipulation must not queue CSS smooth scrolls on every frame.
      // A rAF timestamp may precede the clock read that started the run.
      const elapsed = Math.max(0, Math.min(now - lastFrame, 50));
      const track = edge.track;
      const before = physicalScrollLeft(track);
      const max = track.scrollWidth - track.clientWidth;
      if (edge.direction < 0 ? before <= 0 : before >= max - 1) {
        const end = edge;
        const ran = performance.now() - enteredAt;
        stop();
        // Only content loading after the end can grow a track.
        if (end.direction > 0) park(end, ran);
        return;
      }
      const offset = Math.max(0, Math.min(
        max,
        before + edge.direction * edgeScrollSpeed(now - enteredAt - N.EDGE_SCROLL_DWELL_MS) * elapsed / 1000,
      ));
      withInstantScroll([track], () => { setPhysicalScrollLeft(track, offset); });
      if (physicalScrollLeft(track) !== before) {
        if (!handed && Focus.owner() !== edge.owner) {
          handed = true;
          track.dispatchEvent(new CustomEvent('nav:edge-scroll', { bubbles: true }));
        }
        onScroll(track);
      }
    }
    lastFrame = now;
    frame = requestAnimationFrame(tick);
  };

  const begin = (next: Edge, since: number): void => {
    edge = next;
    handed = false;
    enteredAt = since;
    lastFrame = performance.now();
    frame = requestAnimationFrame(tick);
  };

  // Watch a track resting at its end under the pointer, in case it grows.
  // The run's clock stops meanwhile: `ran` is how long it had been on the edge.
  const park = (end: Edge, ran: number): void => {
    parked = end;
    parkedRan = ran;
    parkedAt = performance.now();
    const poll = (): void => {
      parkTimer = null;
      if (!parked) return;
      const next = edgeAtPointer();
      if (sameEdge(parked, next)) {
        resume(next as Edge);
        return;
      }
      if (performance.now() - parkedAt >= N.EDGE_SCROLL_PARK_MS) {
        unpark();
        return;
      }
      parkTimer = window.setTimeout(poll, N.EDGE_SCROLL_PARK_POLL_MS);
    };
    parkTimer = window.setTimeout(poll, N.EDGE_SCROLL_PARK_POLL_MS);
  };

  const resume = (next: Edge): void => {
    const ran = parkedRan;
    unpark();
    begin(next, performance.now() - ran);
  };

  const onMove = (event: MouseEvent): void => {
    const moved = screenX !== null && (event.screenX !== screenX || event.screenY !== screenY);
    screenX = event.screenX;
    screenY = event.screenY;
    // Content moving beneath a resting cursor fires synthetic mousemoves.
    if (!moved) return;
    if (event.buttons) {
      stop();
      return;
    }
    const next = edgeAtPointer();
    if (sameEdge(edge, next)) return;
    const end = next ? null : edgeAtPointer(true);
    // The run reaching its end parks from its own frame, keeping its speed.
    if (sameEdge(edge, end)) return;
    if (parked && sameEdge(parked, next ?? end)) {
      if (next) resume(next);
      return;
    }
    stop();
    // A pointer arriving at an end starts over with a dwell if the track grows.
    if (end && end.direction > 0) park(end, 0);
    if (!next) return;
    begin(next, performance.now());
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.keyCode !== CONFIG.KEYS.CURSOR_SHOW) stop();
  };
  const onCursor = (event: Event): void => {
    if ((event as CustomEvent<{ visibility?: boolean } | null>).detail?.visibility === false) stop();
  };
  const unsubscribe = InputMode.onChange(mode => {
    if (mode === 'keys') stop();
  });

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('mousedown', stop, true);
  document.addEventListener('click', stop, true);
  document.addEventListener('wheel', stop, true);
  document.addEventListener('cursorStateChange', onCursor);
  document.addEventListener('visibilitychange', stop);
  document.documentElement.addEventListener('mouseleave', stop);
  window.addEventListener('blur', stop);

  return () => {
    stop();
    unsubscribe();
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', stop, true);
    document.removeEventListener('click', stop, true);
    document.removeEventListener('wheel', stop, true);
    document.removeEventListener('cursorStateChange', onCursor);
    document.removeEventListener('visibilitychange', stop);
    document.documentElement.removeEventListener('mouseleave', stop);
    window.removeEventListener('blur', stop);
  };
}
