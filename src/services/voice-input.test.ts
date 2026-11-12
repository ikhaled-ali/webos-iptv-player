// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const luna = vi.hoisted(() => ({
  available: false,
  options: null as null | {
    method?: string;
    onSuccess?: (r: Record<string, unknown>) => void;
    onFailure?: (r: Record<string, unknown>) => void;
  },
  cancel: vi.fn(),
}));
vi.mock('./luna', () => ({
  isLunaAvailable: () => luna.available,
  lunaRequest: (_uri: string, options: typeof luna.options) => {
    luna.options = options;
    return { cancel: luna.cancel };
  },
}));
import {
  resetVoiceEngines,
  startVoiceSearch,
  voiceConductorText,
  voiceEngines,
  type VoiceEngineImpl,
  type VoiceEngineResult,
  type VoiceOutcome,
} from './voice-input';

type Finish = (result: VoiceEngineResult) => void;

function fakeEngine(name: 'speech' | 'luna', available = true) {
  const engine = {
    name,
    finish: null as Finish | null,
    stop: vi.fn(),
    available: vi.fn(() => available),
    start: vi.fn((done: Finish) => { engine.finish = done; return engine.stop; }),
  };
  return engine;
}

const asEngines = (...engines: ReturnType<typeof fakeEngine>[]) => engines as unknown as VoiceEngineImpl[];

beforeEach(() => resetVoiceEngines());
afterEach(() => vi.restoreAllMocks());

describe('startVoiceSearch', () => {
  it('reports the first engine’s text, cleaned up', () => {
    const speech = fakeEngine('speech');
    const luna = fakeEngine('luna');
    const outcomes: VoiceOutcome[] = [];
    startVoiceSearch((o) => outcomes.push(o), asEngines(speech, luna));
    speech.finish!({ kind: 'text', text: '  Alpha\n News ' });
    expect(outcomes).toEqual([{ kind: 'text', text: 'Alpha News', engine: 'speech' }]);
    expect(luna.start).not.toHaveBeenCalled();
  });

  it('reports empty when nothing was heard, without trying the next engine', () => {
    const speech = fakeEngine('speech');
    const luna = fakeEngine('luna');
    const onOutcome = vi.fn();
    startVoiceSearch(onOutcome, asEngines(speech, luna));
    speech.finish!({ kind: 'text', text: '   ' });
    expect(onOutcome).toHaveBeenCalledWith({ kind: 'empty', engine: 'speech' });
    expect(luna.start).not.toHaveBeenCalled();
  });

  it('falls through a failing engine, logs why, and skips it next time', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const speech = fakeEngine('speech');
    const luna = fakeEngine('luna');
    const onOutcome = vi.fn();
    startVoiceSearch(onOutcome, asEngines(speech, luna));
    speech.finish!({ kind: 'failed', reason: 'not-allowed' });
    expect(warn).toHaveBeenCalledWith('[Voice]', 'Voice engine failed', 'event=voice.engine.failed',
      'engine=speech', 'reason=not-allowed');
    expect(luna.start).toHaveBeenCalledTimes(1);
    luna.finish!({ kind: 'text', text: 'Bravo' });
    expect(onOutcome).toHaveBeenCalledWith({ kind: 'text', text: 'Bravo', engine: 'luna' });

    startVoiceSearch(vi.fn(), asEngines(speech, luna));
    expect(speech.start).toHaveBeenCalledTimes(1);
    expect(luna.start).toHaveBeenCalledTimes(2);
  });

  it('reports unavailable when no engine can listen', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const onOutcome = vi.fn();
    startVoiceSearch(onOutcome, asEngines(fakeEngine('speech', false), fakeEngine('luna', false)));
    expect(onOutcome).toHaveBeenCalledWith({ kind: 'unavailable' });
    expect(log).toHaveBeenCalledWith('[Voice]', 'No voice engine; using the search box', 'event=voice.unavailable');
  });

  it('reports unavailable once every engine failed', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const speech = fakeEngine('speech');
    const luna = fakeEngine('luna');
    const onOutcome = vi.fn();
    startVoiceSearch(onOutcome, asEngines(speech, luna));
    speech.finish!({ kind: 'failed', reason: 'network' });
    luna.finish!({ kind: 'failed', reason: '-1' });
    expect(onOutcome).toHaveBeenCalledWith({ kind: 'unavailable' });
  });

  it('cancel stops the engine and drops its late result', () => {
    const speech = fakeEngine('speech');
    const onOutcome = vi.fn();
    const session = startVoiceSearch(onOutcome, asEngines(speech));
    session.cancel();
    expect(speech.stop).toHaveBeenCalledTimes(1);
    speech.finish!({ kind: 'text', text: 'Charlie' });
    expect(onOutcome).not.toHaveBeenCalled();
  });
});

describe('speech engine', () => {
  class FakeRecognizer {
    static last: FakeRecognizer | null = null;
    lang = '';
    continuous = true;
    interimResults = true;
    maxAlternatives = 5;
    onstart: (() => void) | null = null;
    onresult: ((e: unknown) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    onend: (() => void) | null = null;
    start = vi.fn();
    abort = vi.fn();
    constructor() { FakeRecognizer.last = this; }
  }

  beforeEach(() => {
    (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = FakeRecognizer;
    document.documentElement.lang = 'en';
  });
  afterEach(() => {
    delete (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
    FakeRecognizer.last = null;
  });

  it('is available only where the browser has speech recognition', () => {
    expect(voiceEngines.speech.available()).toBe(true);
    delete (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
    expect(voiceEngines.speech.available()).toBe(false);
  });

  it('listens once in the app language and returns the transcript', () => {
    const done = vi.fn();
    voiceEngines.speech.start(done);
    const rec = FakeRecognizer.last!;
    expect(rec.start).toHaveBeenCalled();
    expect(rec.lang).toBe('en');
    expect(rec.continuous).toBe(false);
    expect(rec.interimResults).toBe(false);
    rec.onresult!({ results: [[{ transcript: 'Delta' }]] });
    rec.onend!();
    expect(done).toHaveBeenCalledWith({ kind: 'text', text: 'Delta' });
  });

  it('treats no speech as empty and a blocked service as a failure', () => {
    const quiet = vi.fn();
    voiceEngines.speech.start(quiet);
    FakeRecognizer.last!.onerror!({ error: 'no-speech' });
    FakeRecognizer.last!.onend!();
    expect(quiet).toHaveBeenCalledWith({ kind: 'empty' });

    const blocked = vi.fn();
    voiceEngines.speech.start(blocked);
    FakeRecognizer.last!.onerror!({ error: 'service-not-allowed' });
    FakeRecognizer.last!.onend!();
    expect(blocked).toHaveBeenCalledWith({ kind: 'failed', reason: 'service-not-allowed' });
  });

  it('fails over when the recognizer never starts', () => {
    vi.useFakeTimers();
    try {
      const done = vi.fn();
      voiceEngines.speech.start(done);
      const rec = FakeRecognizer.last!;
      vi.advanceTimersByTime(3000);
      expect(done).toHaveBeenCalledWith({ kind: 'failed', reason: 'no-start' });
      expect(rec.abort).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps listening once the recognizer started', () => {
    vi.useFakeTimers();
    try {
      const done = vi.fn();
      voiceEngines.speech.start(done);
      FakeRecognizer.last!.onstart!();
      vi.advanceTimersByTime(10_000);
      expect(done).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts the recognizer on stop and reports nothing after', () => {
    const done = vi.fn();
    const stop = voiceEngines.speech.start(done);
    const rec = FakeRecognizer.last!;
    stop();
    expect(rec.abort).toHaveBeenCalled();
    rec.onend!();
    expect(done).not.toHaveBeenCalled();
  });
});

describe('voiceConductorText', () => {
  it('reads the first alternative or a plain string', () => {
    expect(voiceConductorText({ text: ['Echo', 'Echoes'] })).toBe('Echo');
    expect(voiceConductorText({ text: 'Echo' })).toBe('Echo');
  });

  it('ignores replies without text', () => {
    expect(voiceConductorText({})).toBeNull();
    expect(voiceConductorText({ text: [] })).toBeNull();
    expect(voiceConductorText({ text: ['  '] })).toBeNull();
    expect(voiceConductorText({ text: 3 })).toBeNull();
  });
});

describe('luna engine', () => {
  beforeEach(() => {
    luna.available = true;
    luna.options = null;
    luna.cancel.mockClear();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('asks the TV recognizer and returns its text', () => {
    const done = vi.fn();
    voiceEngines.luna.start(done);
    expect(luna.options?.method).toBe('recognizeVoiceWithDetails');
    luna.options!.onSuccess!({ returnValue: true, subscribed: true });
    luna.options!.onSuccess!({ text: ['Foxtrot'] });
    expect(done).toHaveBeenCalledWith({ kind: 'text', text: 'Foxtrot' });
    expect(luna.cancel).toHaveBeenCalled();
  });

  it('fails over when the bus never answers', () => {
    const done = vi.fn();
    voiceEngines.luna.start(done);
    vi.advanceTimersByTime(3000);
    expect(done).toHaveBeenCalledWith({ kind: 'failed', reason: 'no-reply' });
  });

  it('ends as empty when a started session hears nothing', () => {
    const done = vi.fn();
    voiceEngines.luna.start(done);
    luna.options!.onSuccess!({ returnValue: true, subscribed: true });
    vi.advanceTimersByTime(3000);
    expect(done).not.toHaveBeenCalled();
    luna.options!.onSuccess!({ state: 'sessionEnd' });
    expect(done).toHaveBeenCalledWith({ kind: 'empty' });
  });

  it('reports a refused call as a failure', () => {
    const done = vi.fn();
    voiceEngines.luna.start(done);
    luna.options!.onFailure!({ returnValue: false, errorCode: -1 });
    expect(done).toHaveBeenCalledWith({ kind: 'failed', reason: '-1' });
  });
});
