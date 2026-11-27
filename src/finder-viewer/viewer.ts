// The phone page for the signal finder's share, bundled on its own by
// scripts/build-finder-viewer.mjs. It subscribes to the share's topics on
// the relay and draws the TV's readings. Text from the relay is set only
// through textContent.
import { MqttClient } from '../services/mqtt-lite';
import {
  FINDER_BROKERS,
  parseReading,
  parseStatus,
  parseViewerHash,
  shareFilter,
  signalLevel,
  type ViewerLabelKey,
} from '../services/finder-share-protocol';
import {
  initialState,
  resetPeak,
  toneFrequency,
  viewerLabels,
  viewerPhase,
  withReading,
  withStatus,
  type ViewerState,
} from './viewer-state';

const RECONNECT_MS = 3000;
const KEEPALIVE_S = 10;
const TONE_MS = 90;
// No share id in the link, so no TV to take words from.
const BAD_LINK = 'Scan the QR code on the TV again.';

let state: ViewerState = initialState();
let audio: AudioContext | null = null;
interface ScreenLock extends EventTarget {
  release(): Promise<void>;
}

let wakeLock: ScreenLock | null = null;
let soundOn = false;

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function randomHex(bytes: number): string {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return Array.from(values, value => (value < 16 ? '0' : '') + value.toString(16)).join('');
}

function setMeter(id: string, value: number | null, peak: number | null = null): void {
  const meter = el(id);
  meter.dataset.level = signalLevel(value);
  (meter.querySelector('.meter-value') as HTMLElement).textContent = value === null ? '–' : `${String(value)}%`;
  (meter.querySelector('.bar-fill') as HTMLElement).style.width = `${String(value ?? 0)}%`;
  const mark = meter.querySelector<HTMLElement>('.peak-mark');
  if (mark) {
    mark.hidden = peak === null;
    mark.style.left = `${String(peak ?? 0)}%`;
  }
}

function render(): void {
  const labels = viewerLabels(state);
  const phase = viewerPhase(state, Date.now());
  document.title = labels.title;
  el('title').textContent = labels.title;
  document.querySelectorAll<HTMLElement>('[data-label]').forEach((node) => {
    node.textContent = labels[node.dataset.label as ViewerLabelKey];
  });
  const notice = phase === 'waiting' ? labels.waiting : phase === 'stopped' ? labels.stopped
    : phase === 'stale' ? labels.stale : '';
  el('notice').textContent = notice;
  el('notice').hidden = !notice;
  el('app').classList.toggle('stale', phase === 'stale');

  const reading = phase === 'stopped' ? null : state.reading;
  const lock = el('lock');
  lock.hidden = !reading;
  if (reading) {
    lock.dataset.state = reading.lock;
    lock.textContent = reading.lock === 'locked' ? labels.locked
      : reading.lock === 'nolock' ? labels.noLock : labels.searching;
  }
  setMeter('quality', reading ? reading.quality : null, state.peak);
  setMeter('strength', reading ? reading.strength : null);
  el('peak').textContent = state.peak === null ? '–' : `${String(state.peak)}%`;
  el('ber').textContent = reading && reading.ber !== null ? reading.ber.toExponential(1) : '–';
  el('transponder').textContent = reading
    ? [reading.satellite, reading.transponder].filter(Boolean).join(' · ') || '–' : '–';
}

function beep(frequency: number): void {
  if (!audio || audio.state !== 'running') return;
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  const start = audio.currentTime;
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.25, start + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + TONE_MS / 1000);
  oscillator.connect(gain).connect(audio.destination);
  oscillator.start(start);
  oscillator.stop(start + TONE_MS / 1000 + 0.02);
}

// A phone on a roof shouldn't lock its screen mid-alignment.
async function holdScreen(): Promise<void> {
  const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<ScreenLock> } };
  if (!nav.wakeLock || wakeLock || document.visibilityState !== 'visible') return;
  try {
    const lock = await nav.wakeLock.request('screen');
    wakeLock = lock;
    // The system may drop the lock on its own, such as for battery saver.
    lock.addEventListener('release', () => {
      if (wakeLock === lock) wakeLock = null;
    });
  } catch {
    wakeLock = null;
  }
}

function resumeSound(): void {
  if (soundOn && audio && audio.state !== 'running') void audio.resume();
}

function onMessage(topic: string, payload: string): void {
  if (/\/status$/.test(topic)) {
    const status = parseStatus(payload);
    if (status) state = withStatus(state, status, Date.now());
  } else if (/\/reading$/.test(topic)) {
    const reading = parseReading(payload);
    if (!reading) return;
    state = withReading(state, reading, Date.now());
    const frequency = toneFrequency(reading);
    if (frequency !== null) beep(frequency);
  }
  render();
}

function connect(broker: number, id: string): void {
  MqttClient.connect({
    url: FINDER_BROKERS[broker],
    clientId: `ipv${randomHex(8)}`,
    keepAliveSeconds: KEEPALIVE_S,
    connectTimeoutMs: 8000,
  }).then((client) => {
    client.onMessage = onMessage;
    client.onLost = () => setTimeout(() => connect(broker, id), RECONNECT_MS);
    client.subscribe(shareFilter(id));
  }, () => {
    setTimeout(() => connect(broker, id), RECONNECT_MS);
  });
}

function start(): void {
  // A scanner that reuses the open tab changes only the fragment.
  window.addEventListener('hashchange', () => location.reload());
  const share = parseViewerHash(location.hash);
  render();
  if (!share) {
    el('notice').textContent = BAD_LINK;
    el('notice').hidden = false;
    return;
  }
  el('sound').addEventListener('click', () => {
    soundOn = !soundOn;
    el('sound').setAttribute('aria-pressed', soundOn ? 'true' : 'false');
    if (soundOn) {
      const Context = window.AudioContext
        || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!audio && Context) audio = new Context();
      void audio?.resume();
    } else {
      void audio?.suspend();
    }
    void holdScreen();
  });
  el('reset').addEventListener('click', () => {
    state = resetPeak(state);
    render();
    void holdScreen();
  });
  // iOS suspends audio when the screen locks or another app comes up; a
  // tap is what it accepts to resume it.
  document.addEventListener('pointerdown', () => resumeSound());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    resumeSound();
    void holdScreen();
  });
  void holdScreen();
  // Notices that readings stopped coming.
  setInterval(render, 1000);
  connect(share.broker, share.id);
}

start();
