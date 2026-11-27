import { createLogger } from '../utils/logger';
import { isLunaAvailable, lunaRequest, type LunaResponse } from './luna';

// Root access on a rooted TV goes through Homebrew Channel's exec service,
// which runs a shell command as root and answers with its output. With it,
// `luna-send -a <app>` reaches services an app's own identity may not call.

const log = createLogger('RootExec');

const HBCHANNEL_URI = 'luna://org.webosbrew.hbchannel.service';
const EXEC_TIMEOUT_MS = 20000;
// exec buffers stdout in memory with a size cap; a scanned satellite list
// easily passes it, so large answers go through a file in the app folder.
const SPOOL_DIR = 'broadcast-cache';
// luna-send waits forever for a service that never answers (an empty
// channel map's list call did); this bounds every call.
const LUNA_WAIT_MS = 15000;

interface ExecResponse extends LunaResponse {
  stdoutString?: string;
  stderrString?: string;
}

export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  // Homebrew Channel is missing or refused us: root is out of reach.
  unavailable: boolean;
  error: string;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// luna-send prints its reply only to a terminal (measured on webOS 10.3: a
// pipe or file gets nothing), so it runs under `script`, which gives it one.
export function lunaSendCommand(uri: string, params: Record<string, unknown>, appId: string): string {
  const send = `luna-send -n 1 -w ${String(LUNA_WAIT_MS)} -a ${shellQuote(appId)} ${shellQuote(uri)} ${shellQuote(JSON.stringify(params))}`;
  return `script -q -c ${shellQuote(send)} /dev/null`;
}

function serviceMissing(text: string): boolean {
  return /unknown service|not (?:found|running|exist)|service does not exist|denied|no such service/i.test(text);
}

export function rootExec(command: string, timeoutMs = EXEC_TIMEOUT_MS): Promise<ExecResult> {
  return new Promise((resolve) => {
    if (!isLunaAvailable()) {
      resolve({ ok: false, stdout: '', stderr: '', unavailable: true, error: 'no-luna' });
      return;
    }
    let settled = false;
    // The bridge can fail synchronously, before the timer exists.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (result: ExecResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const request = lunaRequest<ExecResponse>(HBCHANNEL_URI, {
      method: 'exec',
      parameters: { command },
      onSuccess: (response) => finish({
        ok: true,
        stdout: response.stdoutString ?? '',
        stderr: response.stderrString ?? '',
        unavailable: false,
        error: '',
      }),
      onFailure: (response) => {
        const error = response.errorText ?? 'exec failed';
        // A command that ran and failed still answers with its output.
        const ran = typeof response.stdoutString === 'string' || typeof response.stderrString === 'string';
        finish({
          ok: false,
          stdout: response.stdoutString ?? '',
          stderr: response.stderrString ?? '',
          unavailable: !ran && serviceMissing(error),
          error,
        });
      },
    });
    if (settled) return;
    timer = setTimeout(() => {
      request.cancel();
      finish({ ok: false, stdout: '', stderr: '', unavailable: false, error: 'timeout' });
    }, timeoutMs);
  });
}

// luna-send prints the reply as one JSON object; anything before it (a
// warning from the shell) is skipped.
export function parseLunaSendOutput(stdout: string): Record<string, unknown> | null {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(stdout.slice(start, end + 1));
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

// The folder index.html was loaded from, when the app runs from disk.
export function appDirectory(): string | null {
  if (typeof location === 'undefined' || location.protocol !== 'file:') return null;
  const path = decodeURIComponent(location.pathname);
  const slash = path.lastIndexOf('/');
  return slash > 0 ? path.slice(0, slash) : null;
}

export function readAppFile(relative: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const xhr = new XMLHttpRequest();
      // The query defeats any cached copy of the previous spool.
      xhr.open('GET', `${relative}?t=${String(Date.now())}`, true);
      xhr.onload = () => resolve(xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300)
        ? xhr.responseText : null);
      xhr.onerror = () => resolve(null);
      xhr.send();
    } catch {
      resolve(null);
    }
  });
}

export interface RootLunaResult {
  response: Record<string, unknown> | null;
  unavailable: boolean;
  error: string;
}

// One Luna call as root on behalf of `appId`. `spool` names a file the
// answer is written to and read back from, for answers too large for exec.
export async function rootLunaCall(
  uri: string,
  params: Record<string, unknown>,
  appId: string,
  spool?: string,
): Promise<RootLunaResult> {
  const send = lunaSendCommand(uri, params, appId);
  const dir = spool ? appDirectory() : null;
  if (spool && dir) {
    const folder = `${dir}/${SPOOL_DIR}`;
    const file = `${folder}/${spool}.json`;
    const result = await rootExec(`mkdir -p ${shellQuote(folder)} && ${send} > ${shellQuote(file)} && echo spooled`);
    if (result.unavailable) return { response: null, unavailable: true, error: result.error };
    if (result.ok && result.stdout.indexOf('spooled') !== -1) {
      const text = await readAppFile(`${SPOOL_DIR}/${spool}.json`);
      const response = text ? parseLunaSendOutput(text) : null;
      if (response) return { response, unavailable: false, error: '' };
    }
    log.warn('Spooled Luna call fell back to stdout', 'event=satellite.root.spool_failed',
      `reason=${result.ok ? 'read' : 'exec'}`);
  }
  const result = await rootExec(send);
  if (result.unavailable) return { response: null, unavailable: true, error: result.error };
  const response = parseLunaSendOutput(result.stdout);
  return { response, unavailable: false, error: response ? '' : (result.error || result.stderr || 'no output') };
}

// Several Luna calls as root in one exec, one reply per call (null where a
// call printed nothing): a poll that needs root pays for one spawn.
export async function rootLunaBatch(
  uris: string[],
  params: Record<string, unknown>,
  appId: string,
): Promise<{ replies: Array<Record<string, unknown> | null>; unavailable: boolean }> {
  const sends = uris
    .map(uri => `luna-send -n 1 -w ${String(LUNA_WAIT_MS)} -a ${shellQuote(appId)} ${shellQuote(uri)} ${shellQuote(JSON.stringify(params))}`)
    .join('; ');
  const result = await rootExec(`script -q -c ${shellQuote(sends)} /dev/null`);
  if (result.unavailable) return { replies: uris.map(() => null), unavailable: true };
  const lines = result.stdout.split(/\r?\n/).filter(line => line.trim().charAt(0) === '{');
  return { replies: uris.map((_, index) => (lines[index] ? parseLunaSendOutput(lines[index]) : null)), unavailable: false };
}
