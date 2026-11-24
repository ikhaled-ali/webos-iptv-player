// Opt-in stage timing for load, startup, and search investigations. Off unless
// localStorage `iptv_perf_trace` is '1' when the app boots; then spans collect
// in memory and `window.__IPTV_PERF__` reads them (e.g. through `tv.sh eval`).
// A worker records only while a traced request asks it to, and returns its
// spans in wall-clock time so the page can place them on its own timeline.

export interface PerfSpan {
  stage: string;
  start: number;
  end: number;
  detail?: Record<string, number | string>;
}

export interface PerfStageSummary {
  count: number;
  /** Sum of the stage's span durations, overlaps included. */
  busyMs: number;
  /** Time attributed to the stage alone: where spans overlap, the innermost (latest-started) wins. */
  exclusiveMs: number;
  firstStart: number;
  lastEnd: number;
}

export interface PerfSummary {
  fromMs: number;
  toMs: number;
  wallMs: number;
  /** Wall time covered by at least one span. */
  coveredMs: number;
  /** Wall time no span covers: waits on timers, the event loop, or uninstrumented work. */
  uncoveredMs: number;
  stages: Record<string, PerfStageSummary>;
  marks: Record<string, number>;
}

export const PERF_TRACE_KEY = 'iptv_perf_trace';
const MAX_SPANS = 50000;

let enabled = readFlag();
let spans: PerfSpan[] = [];

function readFlag(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(PERF_TRACE_KEY) === '1';
  } catch {
    return false;
  }
}

export function perfEnabled(): boolean {
  return enabled;
}

/** For a worker: start recording because a traced request arrived. */
export function enablePerfTrace(): void {
  enabled = true;
}

/** A span start, or 0 while tracing is off (the matching `perfEnd` then does nothing). */
export function perfStart(): number {
  return enabled ? performance.now() : 0;
}

export function perfEnd(
  stage: string,
  start: number,
  detail?: Record<string, number | string>,
): void {
  if (!enabled || !start) return;
  perfSpan(stage, start, performance.now(), detail);
}

export function perfSpan(
  stage: string,
  start: number,
  end: number,
  detail?: Record<string, number | string>,
): void {
  if (!enabled || spans.length >= MAX_SPANS) return;
  // Cross-thread spans are placed by millisecond wall clocks and can come out
  // a fraction early; never let one end before it starts.
  if (end < start) end = start;
  spans.push(detail ? { stage, start, end, detail } : { stage, start, end });
}

export function perfMark(stage: string, detail?: Record<string, number | string>): void {
  if (!enabled) return;
  const now = performance.now();
  perfSpan(stage, now, now, detail);
}

/** Marks `stage` at the next animation frame, i.e. once the current work is painted. */
export function perfMarkNextFrame(stage: string): void {
  if (!enabled || typeof requestAnimationFrame !== 'function') return;
  requestAnimationFrame(() => perfMark(stage));
}

/** Ends the span at the next animation frame, i.e. once the work since `start` is painted. */
export function perfEndNextFrame(stage: string, start: number): void {
  if (!enabled || !start || typeof requestAnimationFrame !== 'function') return;
  requestAnimationFrame(() => perfSpan(stage, start, performance.now()));
}

function epochOffset(): number {
  return Date.now() - performance.now();
}

/** Worker side: hands over the recorded spans in wall-clock milliseconds. */
export function drainPerfSpans(): PerfSpan[] {
  if (!spans.length) return [];
  const offset = epochOffset();
  const drained = spans.map(span => ({ ...span, start: span.start + offset, end: span.end + offset }));
  spans = [];
  return drained;
}

/** Page side: adds a worker's wall-clock spans to this timeline. */
export function importPerfSpans(value: unknown): void {
  if (!enabled || !Array.isArray(value)) return;
  const offset = epochOffset();
  for (const span of value as PerfSpan[]) {
    if (!span || typeof span.stage !== 'string'
      || typeof span.start !== 'number' || typeof span.end !== 'number') continue;
    perfSpan(span.stage, span.start - offset, span.end - offset, span.detail);
  }
}

export function perfSpans(): PerfSpan[] {
  return spans.slice();
}

export function clearPerfSpans(): void {
  spans = [];
}

/**
 * Summarizes the spans that overlap [from, to] (defaults: the whole trace).
 * Overlapping stages are counted in full in `busyMs`, and once in
 * `exclusiveMs`, so the exclusive times add up to `coveredMs`.
 */
export function perfSummary(from = -Infinity, to = Infinity): PerfSummary {
  const selected: PerfSpan[] = [];
  const marks: Record<string, number> = {};
  for (const span of spans) {
    if (span.end < from || span.start > to) continue;
    if (span.end === span.start) {
      if (!(span.stage in marks)) marks[span.stage] = round(span.start);
      continue;
    }
    selected.push({
      stage: span.stage,
      start: Math.max(span.start, from),
      end: Math.min(span.end, to),
    });
  }
  const stages: Record<string, PerfStageSummary> = {};
  let fromMs = Infinity;
  let toMs = -Infinity;
  for (const span of selected) {
    const entry = stages[span.stage] ?? (stages[span.stage] = {
      count: 0, busyMs: 0, exclusiveMs: 0, firstStart: Infinity, lastEnd: -Infinity,
    });
    entry.count++;
    entry.busyMs += span.end - span.start;
    entry.firstStart = Math.min(entry.firstStart, span.start);
    entry.lastEnd = Math.max(entry.lastEnd, span.end);
    fromMs = Math.min(fromMs, span.start);
    toMs = Math.max(toMs, span.end);
  }
  const coveredMs = attributeExclusive(selected, stages);
  for (const stage in stages) {
    const entry = stages[stage];
    entry.busyMs = round(entry.busyMs);
    entry.exclusiveMs = round(entry.exclusiveMs);
    entry.firstStart = round(entry.firstStart);
    entry.lastEnd = round(entry.lastEnd);
  }
  const wallMs = selected.length ? toMs - fromMs : 0;
  return {
    fromMs: selected.length ? round(fromMs) : 0,
    toMs: selected.length ? round(toMs) : 0,
    wallMs: round(wallMs),
    coveredMs: round(coveredMs),
    uncoveredMs: round(wallMs - coveredMs),
    stages,
    marks,
  };
}

// A sweep over span boundaries: each elementary interval goes to the active
// span that started last (the innermost one when spans nest).
function attributeExclusive(
  selected: PerfSpan[],
  stages: Record<string, PerfStageSummary>,
): number {
  const events: Array<{ at: number; open: boolean; span: number }> = [];
  for (let i = 0; i < selected.length; i++) {
    events.push({ at: selected[i].start, open: true, span: i });
    events.push({ at: selected[i].end, open: false, span: i });
  }
  events.sort((a, b) => a.at - b.at || (a.open === b.open ? 0 : a.open ? 1 : -1));
  const active: number[] = [];
  let covered = 0;
  let previous = events.length ? events[0].at : 0;
  for (const event of events) {
    if (active.length && event.at > previous) {
      let innermost = active[0];
      for (const candidate of active) {
        if (selected[candidate].start >= selected[innermost].start) innermost = candidate;
      }
      stages[selected[innermost].stage].exclusiveMs += event.at - previous;
      covered += event.at - previous;
    }
    previous = event.at;
    if (event.open) active.push(event.span);
    else active.splice(active.indexOf(event.span), 1);
  }
  return covered;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

interface PerfTraceApi {
  spans(): PerfSpan[];
  summary(from?: number, to?: number): PerfSummary;
  /** Summary between the first occurrences of two marks. */
  between(fromMark: string, toMark: string): PerfSummary | null;
  clear(): void;
}

/** Page side: exposes the trace as `window.__IPTV_PERF__` while tracing is on. */
export function installPerfTraceApi(): void {
  if (!enabled || typeof window === 'undefined') return;
  const api: PerfTraceApi = {
    spans: perfSpans,
    summary: perfSummary,
    between(fromMark, toMark) {
      const marks = perfSummary().marks;
      if (!(fromMark in marks) || !(toMark in marks)) return null;
      return perfSummary(marks[fromMark], marks[toMark]);
    },
    clear: clearPerfSpans,
  };
  (window as unknown as { __IPTV_PERF__?: PerfTraceApi }).__IPTV_PERF__ = api;
  markNavigationTiming();
}

// The document's own milestones, on the same clock as performance.now().
function markNavigationTiming(): void {
  const timing = typeof performance.timing === 'object' ? performance.timing : null;
  if (!timing || !timing.navigationStart) return;
  const milestones: Array<[string, number]> = [
    ['nav.responseEnd', timing.responseEnd],
    ['nav.domInteractive', timing.domInteractive],
    ['nav.domContentLoaded', timing.domContentLoadedEventStart],
  ];
  for (const [stage, at] of milestones) {
    if (at > 0) perfSpan(stage, at - timing.navigationStart, at - timing.navigationStart);
  }
}
