import { CONFIG } from '../config';

// The LAN service binds to an OS-assigned port at startup and reports it
// through the Luna `start` response (see app.ts → startBundledService). Until
// setServicePort() receives that value, serviceBase() returns null and both LAN
// clients behave as if the service were unreachable. This also covers dev and
// e2e environments where Luna is unavailable and no service runs.
let runtimePort: number | null = null;
let runtimeToken = '';

export function setServicePort(port: number | null, localToken?: unknown): void {
  if (port === null || typeof localToken !== 'string' || !/^[a-f0-9]{64}$/.test(localToken)) {
    runtimePort = null;
    runtimeToken = '';
    return;
  }
  if (typeof port === 'number' && port % 1 === 0 && port > 0 && port < 65536) {
    runtimePort = port;
    runtimeToken = localToken;
  } else {
    runtimePort = null;
    runtimeToken = '';
  }
}

export function serviceHeaders(): Record<string, string> {
  return { 'X-IPTV-Local-Token': runtimeToken };
}

export function serviceBase(): string | null {
  if (runtimePort === null) return null;
  return `http://${CONFIG.SERVICE_HOST}:${runtimePort}`;
}
