/**
 * Live TV recording — webOS service integration. Registers the Luna methods
 * the app drives, owns the single active Recorder, and lazily serves saved
 * recordings to the app's player over a loopback HTTP server.
 */

import type { Headers } from './fetch';
import {
  defaultLocationRoots, freeBytes, listLocations,
  type LocationRoots, type RecordingLocation,
} from './locations';
import { Recorder, type RecorderFailure } from './recorder';
import { startRecordingServer, type RecordingServer, type ServedRecording } from './server';
import {
  cleanupPartFiles, commitRecording, deleteRecordingIn, discardPart, isValidRecordingId,
  listRecordingsIn, newRecordingId, readRecording, type RecordingMeta,
} from './store';

interface LunaService {
  register(method: string, handler: (msg: LunaMsg) => void): void;
  activityManager?: {
    create(name: string, cb: () => void): void;
    complete(name: string, cb: () => void): void;
  };
}

type LunaMsg = {
  sender?: string;
  payload?: { [name: string]: unknown };
  respond: (r: unknown) => void;
  isSubscription?: boolean;
  on?: (event: 'cancel', listener: () => void) => void;
};

type ErrorCode = 'unsupported' | 'location' | 'busy' | 'failed';

interface ActiveRecording {
  id: string;
  location: RecordingLocation;
  meta: RecordingMeta;
  recorder: Recorder | null;
  started: boolean;
  finalized: boolean;
  respondStart: (response: unknown) => void;
}

const START_TIMEOUT_MS = 20000;
const MIN_FREE_BYTES = 64 * 1024 * 1024;
const KEEP_ALIVE = 'recordingKeepAlive';
const SKIPPED_HEADERS = /^(host|content-length|connection|range|transfer-encoding|upgrade|te|trailer)$/i;

export function sanitizeHeaders(value: unknown): Headers {
  const out: Headers = {};
  if (!value || typeof value !== 'object') return out;
  const source = value as { [name: string]: unknown };
  const names = Object.keys(source);
  for (let i = 0; i < names.length && i < 16; i++) {
    const name = names[i];
    const headerValue = source[name];
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name) || SKIPPED_HEADERS.test(name)) continue;
    if (typeof headerValue !== 'string' || headerValue.length > 2048) continue;
    if (/[\r\n\0]/.test(headerValue)) continue;
    out[name] = headerValue;
  }
  return out;
}

export function isRecordableUrl(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 8192 && /^https?:\/\/[^\s]+$/i.test(value);
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

export function registerRecordingService(
  service: LunaService,
  appId?: string,
  roots?: LocationRoots,
): void {
  const locationRoots = roots || defaultLocationRoots(process.env.WEBOS_RECORDING_DIR);
  const subscribers: LunaMsg[] = [];
  let active: ActiveRecording | null = null;
  let mediaServer: RecordingServer | null = null;
  let serverWaiters: Array<(server: RecordingServer | null) => void> = [];
  let keepAlive = false;
  // id -> served file, refreshed by listRecordings so Range requests skip a rescan.
  let served: { [id: string]: ServedRecording } = {};

  function authorized(msg: LunaMsg): boolean {
    if (!appId || msg.sender === appId) return true;
    msg.respond({ returnValue: false, errorCode: 'failed', errorText: 'Local access only' });
    return false;
  }

  function guarded(method: string, handler: (msg: LunaMsg) => void): void {
    service.register(method, (msg) => {
      if (!authorized(msg)) return;
      try {
        handler(msg);
      } catch (e) {
        console.error('[recording] ' + method + ' failed: ' + (e instanceof Error ? e.message : String(e)));
        msg.respond({ returnValue: false, errorCode: 'failed', errorText: 'Internal error' });
      }
    });
  }

  function activeSnapshot(): { id: string; channelId: string; startedAt: number; bytes: number } | null {
    if (!active || !active.started) return null;
    return {
      id: active.id,
      channelId: active.meta.channelId,
      startedAt: active.meta.startedAt,
      bytes: active.recorder ? active.recorder.bytes : 0,
    };
  }

  function broadcast(event: 'started' | 'stopped' | 'failed', id: string, saved?: boolean): void {
    const response: { [name: string]: unknown } = {
      returnValue: true, event: event, id: id, active: activeSnapshot(),
    };
    if (saved !== undefined) response.saved = saved;
    for (let i = 0; i < subscribers.length;) {
      try {
        subscribers[i].respond(response);
        i++;
      } catch {
        console.warn('[recording] subscriber respond failed, dropping');
        subscribers.splice(i, 1);
      }
    }
  }

  function setKeepAlive(on: boolean): void {
    const manager = service.activityManager;
    if (!manager || on === keepAlive) return;
    keepAlive = on;
    try {
      if (on) manager.create(KEEP_ALIVE, () => { /* keep the service alive while recording */ });
      else manager.complete(KEEP_ALIVE, () => { /* released */ });
    } catch {
      console.warn('[recording] keepAlive ' + (on ? 'create' : 'complete') + ' failed');
    }
  }

  function findLocation(id: string): RecordingLocation | null {
    const locations = listLocations(locationRoots);
    for (let i = 0; i < locations.length; i++) {
      if (locations[i].id === id) return locations[i];
    }
    return null;
  }

  // Saves (or discards) the active recording's file once its recorder has
  // closed it, then clears the slot. Returns whether a recording was saved.
  function settle(entry: ActiveRecording, save: boolean): boolean {
    if (entry.finalized) return false;
    entry.finalized = true;
    if (active === entry) active = null;
    setKeepAlive(false);
    const recorder = entry.recorder;
    const ext = recorder ? recorder.ext : null;
    if (!ext || !recorder) return false;
    if (!save) {
      discardPart(entry.location.dir, entry.id, ext);
      return false;
    }
    entry.meta.ext = ext;
    entry.meta.durationSecs = recorder.durationSecs();
    entry.meta.bytes = recorder.bytes;
    try {
      const saved = commitRecording(entry.location.dir, entry.meta);
      console.log('[recording] finished id=' + entry.id + ' saved=' + saved +
        ' bytes=' + recorder.bytes + ' secs=' + Math.round(entry.meta.durationSecs));
      return saved;
    } catch (e) {
      console.error('[recording] save failed: ' + (e instanceof Error ? e.message : String(e)));
      discardPart(entry.location.dir, entry.id, ext);
      return false;
    }
  }

  function startFailed(entry: ActiveRecording, code: ErrorCode, errorText: string): void {
    settle(entry, false);
    entry.respondStart({ returnValue: false, errorCode: code, errorText: errorText });
  }

  function beginRecording(entry: ActiveRecording, url: string, headers: Headers): void {
    const timer = setTimeout(() => {
      if (entry.started || entry.finalized) return;
      console.log('[recording] no stream data before the start timeout');
      const recorder = entry.recorder;
      if (recorder) recorder.stop(() => startFailed(entry, 'failed', 'Timed out waiting for stream data'));
      else startFailed(entry, 'failed', 'Timed out waiting for stream data');
    }, START_TIMEOUT_MS);

    const recorder = new Recorder({ url: url, headers: headers, dir: entry.location.dir, id: entry.id }, {
      onFirstBytes: () => {
        clearTimeout(timer);
        if (entry.finalized) return;
        entry.started = true;
        setKeepAlive(true);
        console.log('[recording] started id=' + entry.id + ' location=' + entry.location.kind);
        entry.respondStart({ returnValue: true, id: entry.id, startedAt: entry.meta.startedAt });
        broadcast('started', entry.id);
      },
      onFailed: (code: RecorderFailure, errorText: string) => {
        clearTimeout(timer);
        if (entry.finalized) return;
        if (!entry.started) {
          startFailed(entry, code, errorText);
          return;
        }
        const saved = settle(entry, true);
        broadcast('failed', entry.id, saved);
      },
      onEnded: () => {
        clearTimeout(timer);
        if (entry.finalized) return;
        if (!entry.started) {
          startFailed(entry, 'failed', 'Stream ended before any data');
          return;
        }
        const saved = settle(entry, true);
        broadcast('stopped', entry.id, saved);
      },
    });
    entry.recorder = recorder;
    recorder.start();
  }

  guarded('recordingLocations', (msg) => {
    const locations = listLocations(locationRoots);
    const out: Array<{ id: string; kind: string; name: string; freeBytes: number | null }> = [];
    let remaining = locations.length;
    if (remaining === 0) {
      msg.respond({ returnValue: true, locations: out });
      return;
    }
    for (let i = 0; i < locations.length; i++) {
      out.push({ id: locations[i].id, kind: locations[i].kind, name: locations[i].name, freeBytes: null });
    }
    locations.forEach((location, index) => {
      freeBytes(location.dir, (bytes) => {
        out[index].freeBytes = bytes;
        if (--remaining === 0) msg.respond({ returnValue: true, locations: out });
      });
    });
  });

  guarded('startRecording', (msg) => {
    const payload = msg.payload || {};
    if (active) {
      msg.respond({ returnValue: false, errorCode: 'busy', errorText: 'A recording is already running' });
      return;
    }
    const url = payload.url;
    if (!isRecordableUrl(url)) {
      msg.respond({ returnValue: false, errorCode: 'failed', errorText: 'Invalid stream URL' });
      return;
    }
    const location = typeof payload.locationId === 'string' ? findLocation(payload.locationId) : null;
    if (!location) {
      msg.respond({ returnValue: false, errorCode: 'location', errorText: 'Storage location unavailable' });
      return;
    }
    const startedAt = Date.now();
    const id = newRecordingId(startedAt);
    let responded = false;
    const entry: ActiveRecording = {
      id: id,
      location: location,
      meta: {
        id: id,
        channelId: text(payload.channelId, 512),
        channelName: text(payload.channelName, 512),
        logo: text(payload.logo, 4096),
        programTitle: text(payload.programTitle, 512),
        startedAt: startedAt,
        durationSecs: 0,
        bytes: 0,
        ext: 'ts',
      },
      recorder: null,
      started: false,
      finalized: false,
      respondStart: (response) => {
        if (responded) return;
        responded = true;
        msg.respond(response);
      },
    };
    // Claim the slot before the async free-space check so a second start is busy.
    active = entry;
    const headers = sanitizeHeaders(payload.headers);
    freeBytes(location.dir, (bytes) => {
      if (entry.finalized) return;
      if (bytes !== null && bytes < MIN_FREE_BYTES) {
        startFailed(entry, 'location', 'Not enough free space');
        return;
      }
      beginRecording(entry, url, headers);
    });
  });

  guarded('stopRecording', (msg) => {
    const payload = msg.payload || {};
    const entry = active;
    if (!entry || !isValidRecordingId(payload.id) || payload.id !== entry.id) {
      msg.respond({ returnValue: false, errorCode: 'failed', errorText: 'No such active recording' });
      return;
    }
    const save = payload.save === true;
    const recorder = entry.recorder;
    const done = (): void => {
      const wasStarted = entry.started;
      const saved = settle(entry, save);
      if (!wasStarted) entry.respondStart({ returnValue: false, errorCode: 'failed', errorText: 'Canceled' });
      msg.respond({ returnValue: true, saved: saved });
      if (wasStarted) broadcast('stopped', entry.id, saved);
    };
    if (recorder) recorder.stop(done);
    else done();
  });

  guarded('recordingStatus', (msg) => {
    if (msg.isSubscription) {
      if (subscribers.indexOf(msg) < 0) subscribers.push(msg);
      if (typeof msg.on === 'function') {
        msg.on('cancel', () => {
          const index = subscribers.indexOf(msg);
          if (index >= 0) subscribers.splice(index, 1);
        });
      }
    }
    msg.respond({ returnValue: true, subscribed: !!msg.isSubscription, active: activeSnapshot() });
  });

  function resolveServed(id: string): ServedRecording | null {
    if (served[id]) return served[id];
    const locations = listLocations(locationRoots);
    for (let i = 0; i < locations.length; i++) {
      const recording = readRecording(locations[i].dir, id);
      if (recording) {
        served[id] = { file: recording.file, ext: recording.meta.ext };
        return served[id];
      }
    }
    return null;
  }

  function withServer(cb: (server: RecordingServer | null) => void): void {
    if (mediaServer) {
      cb(mediaServer);
      return;
    }
    serverWaiters.push(cb);
    if (serverWaiters.length > 1) return;
    startRecordingServer(resolveServed, (err, server) => {
      if (err || !server) console.error('[recording] media server failed: ' + (err ? err.message : 'unknown'));
      mediaServer = server || null;
      const waiters = serverWaiters;
      serverWaiters = [];
      for (let i = 0; i < waiters.length; i++) waiters[i](mediaServer);
    });
  }

  guarded('listRecordings', (msg) => {
    withServer((server) => {
      if (!server) {
        msg.respond({ returnValue: false, errorCode: 'failed', errorText: 'Playback server unavailable' });
        return;
      }
      try {
        const locations = listLocations(locationRoots);
        const nextServed: { [id: string]: ServedRecording } = {};
        const recordings: Array<{ [name: string]: unknown }> = [];
        for (let i = 0; i < locations.length; i++) {
          const location = locations[i];
          const stored = listRecordingsIn(location.dir);
          for (let j = 0; j < stored.length; j++) {
            const meta = stored[j].meta;
            if (active && active.id === meta.id) continue;
            nextServed[meta.id] = { file: stored[j].file, ext: meta.ext };
            recordings.push({
              id: meta.id,
              locationId: location.id,
              kind: location.kind,
              name: location.name,
              channelId: meta.channelId,
              channelName: meta.channelName,
              logo: meta.logo,
              programTitle: meta.programTitle,
              startedAt: meta.startedAt,
              durationSecs: meta.durationSecs,
              bytes: meta.bytes,
              url: 'http://127.0.0.1:' + server.port + '/recordings/' + meta.id + '?token=' + server.token,
            });
          }
        }
        served = nextServed;
        recordings.sort((a, b) => (b.startedAt as number) - (a.startedAt as number));
        msg.respond({ returnValue: true, recordings: recordings });
      } catch (e) {
        console.error('[recording] listRecordings failed: ' + (e instanceof Error ? e.message : String(e)));
        msg.respond({ returnValue: false, errorCode: 'failed', errorText: 'Internal error' });
      }
    });
  });

  guarded('deleteRecording', (msg) => {
    const id = (msg.payload || {}).id;
    if (!isValidRecordingId(id)) {
      msg.respond({ returnValue: false, errorCode: 'failed', errorText: 'Invalid recording id' });
      return;
    }
    if (active && active.id === id) {
      msg.respond({ returnValue: false, errorCode: 'busy', errorText: 'Recording is in progress' });
      return;
    }
    const locations = listLocations(locationRoots);
    for (let i = 0; i < locations.length; i++) deleteRecordingIn(locations[i].dir, id);
    delete served[id];
    msg.respond({ returnValue: true });
  });

  // A crash or kill mid-recording leaves a .part no recorder will finish.
  try {
    const locations = listLocations(locationRoots);
    let removed = 0;
    for (let i = 0; i < locations.length; i++) removed += cleanupPartFiles(locations[i].dir, null);
    if (removed > 0) console.log('[recording] removed ' + removed + ' stale partial file(s)');
  } catch {
    console.warn('[recording] stale partial cleanup failed');
  }
}
