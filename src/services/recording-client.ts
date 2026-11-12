import { createLogger } from '../utils/logger';
import { isLunaAvailable, lunaRequest, type LunaRequestHandle } from './luna';

const log = createLogger('Recording');

const SERVICE_URI = `luna://${__SERVICE_ID__}`;

export type RecordingLocationKind = 'internal' | 'usb';

export interface RecordingLocation {
  id: string;
  kind: RecordingLocationKind;
  name: string;
  freeBytes: number | null;
}

export interface RecordingEntry {
  id: string;
  locationId: string;
  kind: RecordingLocationKind;
  name: string;
  channelId: string;
  channelName: string;
  logo: string;
  programTitle: string;
  startedAt: number;
  durationSecs: number;
  bytes: number;
  url: string;
}

export interface ActiveRecording {
  id: string;
  channelId: string;
  startedAt: number;
  bytes: number;
}

export interface StartRecordingRequest {
  locationId: string;
  url: string;
  headers?: Record<string, string>;
  channelId: string;
  channelName: string;
  logo: string;
  programTitle: string;
}

export type StartFailure = 'unsupported' | 'location' | 'busy' | 'failed' | 'unavailable';

export type StartResult =
  | { ok: true; id: string; startedAt: number }
  | { ok: false; reason: StartFailure };

export interface RecordingStatusEvent {
  event?: 'started' | 'stopped' | 'failed';
  id?: string;
  saved?: boolean;
  active: ActiveRecording | null;
}

// The service answers with string error codes, unlike the bus's numeric ones.
interface ServiceResponse {
  returnValue?: boolean;
  errorCode?: unknown;
  errorText?: string;
  [key: string]: unknown;
}

const START_FAILURES: StartFailure[] = ['unsupported', 'location', 'busy', 'failed'];

function call(method: string, parameters: Record<string, unknown> = {}): Promise<ServiceResponse> {
  return new Promise((resolve) => {
    if (!isLunaAvailable()) {
      resolve({ returnValue: false, errorCode: 'unavailable' });
      return;
    }
    lunaRequest<ServiceResponse & { errorCode?: number }>(SERVICE_URI, {
      method,
      parameters,
      onSuccess: (response) => resolve(response),
      onFailure: (response) => resolve({ ...response, returnValue: false }),
    });
  });
}

function validLocation(value: unknown): value is RecordingLocation {
  const v = value as RecordingLocation;
  return !!v && typeof v.id === 'string' && (v.kind === 'internal' || v.kind === 'usb')
    && typeof v.name === 'string';
}

function validEntry(value: unknown): value is RecordingEntry {
  const v = value as RecordingEntry;
  return !!v && typeof v.id === 'string' && typeof v.url === 'string'
    && typeof v.startedAt === 'number';
}

function activeFrom(value: unknown): ActiveRecording | null {
  const v = value as ActiveRecording | null;
  return v && typeof v.id === 'string' && typeof v.startedAt === 'number' ? v : null;
}

export const RecordingClient = {
  available(): boolean {
    return isLunaAvailable();
  },

  // Null when the service did not answer (absent, as in the Simulator), as
  // opposed to an answer that lists no writable storage.
  async locations(): Promise<RecordingLocation[] | null> {
    const response = await call('recordingLocations');
    if (response.returnValue === false) {
      log.warn('Recording locations unavailable', 'event=recording.locations.failed',
        `reason=${String(response.errorCode ?? 'unknown')}`);
      return null;
    }
    return Array.isArray(response.locations) ? response.locations.filter(validLocation) : [];
  },

  async start(request: StartRecordingRequest): Promise<StartResult> {
    const response = await call('startRecording', { ...request });
    if (response.returnValue !== false && typeof response.id === 'string') {
      return {
        ok: true,
        id: response.id,
        startedAt: typeof response.startedAt === 'number' ? response.startedAt : Date.now(),
      };
    }
    const code = response.errorCode;
    const reason: StartFailure = code === 'unavailable' ? 'unavailable'
      : START_FAILURES.indexOf(code as StartFailure) !== -1 ? code as StartFailure : 'failed';
    log.warn('Recording did not start', 'event=recording.start.failed', `reason=${reason}`);
    return { ok: false, reason };
  },

  async stop(id: string, save: boolean): Promise<boolean> {
    const response = await call('stopRecording', { id, save });
    if (response.returnValue === false) {
      log.warn('Recording stop failed', 'event=recording.stop.failed',
        `reason=${String(response.errorCode ?? 'unknown')}`);
      return false;
    }
    return response.saved === true;
  },

  async list(): Promise<RecordingEntry[]> {
    const response = await call('listRecordings');
    return Array.isArray(response.recordings) ? response.recordings.filter(validEntry) : [];
  },

  async remove(id: string): Promise<boolean> {
    const response = await call('deleteRecording', { id });
    return response.returnValue !== false;
  },

  // Holds the service open while the app runs; every change arrives here.
  subscribe(
    onStatus: (status: RecordingStatusEvent) => void,
    onUnavailable: () => void = () => {},
  ): LunaRequestHandle | null {
    if (!isLunaAvailable()) {
      onUnavailable();
      return null;
    }
    return lunaRequest<ServiceResponse & { errorCode?: number }>(SERVICE_URI, {
      method: 'recordingStatus',
      parameters: { subscribe: true },
      onSuccess: (response) => {
        const event = response.event;
        onStatus({
          event: event === 'started' || event === 'stopped' || event === 'failed' ? event : undefined,
          id: typeof response.id === 'string' ? response.id : undefined,
          saved: typeof response.saved === 'boolean' ? response.saved : undefined,
          active: activeFrom(response.active),
        });
      },
      onFailure: (response) => {
        log.warn('Recording status subscription failed', 'event=recording.status.failed',
          `reason=${String(response.errorText ?? 'unknown')}`);
        onUnavailable();
      },
    });
  },
};
