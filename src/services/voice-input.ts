import { CONFIG } from '../config';
import { createLogger } from '../utils/logger';
import { isLunaAvailable, lunaRequest, type LunaRequestHandle, type LunaResponse } from './luna';
import { normalizeLaunchQuery } from './launch-intent';

const log = createLogger('Voice');

// The engines a voice search tries, in order. LG publishes no voice API for
// apps: `speech` is the browser's Web Speech API, which some webOS builds back
// with the TV's own recognizer; `luna` asks that recognizer directly, which
// retail TVs may refuse to a non-system app. When both fail, the caller falls
// back to the focused search box, which the remote's mic button fills.
export type VoiceEngine = 'speech' | 'luna';

export type VoiceOutcome =
  | { kind: 'text'; text: string; engine: VoiceEngine }
  // Heard nothing, or the user canceled.
  | { kind: 'empty'; engine: VoiceEngine }
  | { kind: 'unavailable' };

export interface VoiceSession {
  cancel(): void;
}

interface EngineResult {
  kind: 'text' | 'empty' | 'failed';
  text?: string;
  reason?: string;
}

interface Engine {
  name: VoiceEngine;
  available(): boolean;
  start(done: (result: EngineResult) => void): () => void;
}

interface SpeechAlternative { transcript: string }
interface SpeechResultEvent { results: ArrayLike<ArrayLike<SpeechAlternative>> }
interface SpeechErrorEvent { error?: string }
interface SpeechRecognizer {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onresult: ((e: SpeechResultEvent) => void) | null;
  onerror: ((e: SpeechErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  abort(): void;
}
type SpeechRecognizerCtor = new () => SpeechRecognizer;

function speechCtor(): SpeechRecognizerCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognizerCtor;
    webkitSpeechRecognition?: SpeechRecognizerCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

// Errors that mean "nothing was said", not "this engine can't work here".
const SPEECH_EMPTY_ERRORS = ['no-speech', 'aborted'];

const speechEngine: Engine = {
  name: 'speech',
  available: () => speechCtor() !== null,
  start(done) {
    const Ctor = speechCtor()!;
    let text = '';
    let error = '';
    let finished = false;
    let rec: SpeechRecognizer | null = null;
    const finish = (result: EngineResult): void => {
      if (finished) return;
      finished = true;
      clearTimeout(startTimer);
      done(result);
    };
    // A recognizer with no service behind it (a simulator) may never start.
    const startTimer = setTimeout(() => {
      finish({ kind: 'failed', reason: 'no-start' });
      try { rec?.abort(); } catch { /* already stopped */ }
    }, CONFIG.VOICE.START_TIMEOUT_MS);
    try {
      rec = new Ctor();
      rec.onstart = () => clearTimeout(startTimer);
      rec.lang = document.documentElement.lang || navigator.language || '';
      rec.continuous = false;
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      rec.onresult = (e) => {
        clearTimeout(startTimer);
        const first = e.results[0]?.[0];
        if (first) text = first.transcript;
      };
      rec.onerror = (e) => { error = e.error || 'unknown'; };
      rec.onend = () => {
        if (text) finish({ kind: 'text', text });
        else if (!error || SPEECH_EMPTY_ERRORS.indexOf(error) >= 0) finish({ kind: 'empty' });
        else finish({ kind: 'failed', reason: error });
      };
      rec.start();
    } catch {
      finish({ kind: 'failed', reason: 'start' });
      return () => undefined;
    }
    return () => {
      finished = true;
      clearTimeout(startTimer);
      try { rec?.abort(); } catch { /* already stopped */ }
    };
  },
};

interface VoiceConductorResponse extends LunaResponse {
  text?: unknown;
  subscribed?: boolean;
}

// The recognizer's reply text, as a string or a list of alternatives.
export function voiceConductorText(response: VoiceConductorResponse): string | null {
  const text = Array.isArray(response.text) ? response.text[0] : response.text;
  return typeof text === 'string' && text.trim() ? text : null;
}

// Its replies are undocumented; a session ends once a reply names its end.
function voiceConductorEnded(response: VoiceConductorResponse): boolean {
  return /"(sttEnd|sessionEnd)"/.test(JSON.stringify(response));
}

const lunaEngine: Engine = {
  name: 'luna',
  available: () => isLunaAvailable(),
  start(done) {
    let finished = false;
    let request: LunaRequestHandle | null = null;
    const finish = (result: EngineResult): void => {
      if (finished) return;
      finished = true;
      clearTimeout(startTimer);
      clearTimeout(timer);
      request?.cancel();
      done(result);
    };
    // A bus that never answers (a simulator) fails fast; a session that
    // started but hears nothing ends as empty.
    const startTimer = setTimeout(() => finish({ kind: 'failed', reason: 'no-reply' }), CONFIG.VOICE.START_TIMEOUT_MS);
    const timer = setTimeout(() => finish({ kind: 'empty' }), CONFIG.VOICE.LISTEN_TIMEOUT_MS);
    request = lunaRequest<VoiceConductorResponse>('luna://com.webos.service.voiceconductor', {
      method: 'recognizeVoiceWithDetails',
      parameters: { autoEndDetection: true },
      subscribe: true,
      onSuccess: (response) => {
        clearTimeout(startTimer);
        const text = voiceConductorText(response);
        if (text) finish({ kind: 'text', text });
        else if (voiceConductorEnded(response)) finish({ kind: 'empty' });
      },
      onFailure: (response) => {
        finish({ kind: 'failed', reason: String(response.errorCode ?? 'unknown') });
      },
    });
    return () => {
      finished = true;
      clearTimeout(startTimer);
      clearTimeout(timer);
      request?.cancel();
    };
  },
};

const ENGINES: Engine[] = [speechEngine, lunaEngine];
// An engine that failed once fails again; skip it for the rest of the session.
const failedEngines: VoiceEngine[] = [];

export function startVoiceSearch(onOutcome: (outcome: VoiceOutcome) => void, engines: Engine[] = ENGINES): VoiceSession {
  let stopCurrent: (() => void) | null = null;
  let canceled = false;
  const tryFrom = (index: number): void => {
    const engine = engines.slice(index).find((e) => failedEngines.indexOf(e.name) < 0 && e.available());
    if (!engine) {
      log.info('No voice engine; using the search box', 'event=voice.unavailable');
      onOutcome({ kind: 'unavailable' });
      return;
    }
    const next = engines.indexOf(engine) + 1;
    stopCurrent = engine.start((result) => {
      stopCurrent = null;
      if (canceled) return;
      if (result.kind === 'failed') {
        failedEngines.push(engine.name);
        log.warn('Voice engine failed', 'event=voice.engine.failed', `engine=${engine.name}`,
          `reason=${result.reason ?? 'unknown'}`);
        tryFrom(next);
        return;
      }
      const text = result.kind === 'text' ? normalizeLaunchQuery(result.text) : null;
      onOutcome(text ? { kind: 'text', text, engine: engine.name } : { kind: 'empty', engine: engine.name });
    });
  };
  tryFrom(0);
  return {
    cancel() {
      if (canceled) return;
      canceled = true;
      stopCurrent?.();
      stopCurrent = null;
    },
  };
}

// For tests: forget which engines failed.
export function resetVoiceEngines(): void {
  failedEngines.length = 0;
}

export const voiceEngines = { speech: speechEngine, luna: lunaEngine };
export type { Engine as VoiceEngineImpl, EngineResult as VoiceEngineResult };
