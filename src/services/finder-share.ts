import { createLogger } from '../utils/logger';
import { KeepAwake } from './keep-awake';
import { MqttClient, MqttConnectError, type MqttClientOptions } from './mqtt-lite';
import {
  FINDER_BROKERS,
  FINDER_SHARE_VERSION,
  FINDER_VIEWER_URL,
  readingTopic,
  statusTopic,
  viewerUrl,
  type ReadingMessage,
  type StatusMessage,
  type ViewerLabels,
} from './finder-share-protocol';

const log = createLogger('FinderShare');

const CONNECT_TIMEOUT_MS = 8000;
const RECONNECT_MS = 3000;
// A dead socket shows within 1.5 keepalives, at both ends.
export const KEEPALIVE_S = 10;
// The broker may publish an old connection's "stopped" will after a
// reconnect; republishing "on" puts the retained status right again.
export const STATUS_REFRESH_MS = 20000;
const KEEP_AWAKE = 'finder-share';

export type FinderShareState = 'off' | 'connecting' | 'live' | 'reconnecting' | 'failed';

export type FinderReading = Omit<ReadingMessage, 'v'>;

interface FinderShareDeps {
  connect: (options: MqttClientOptions) => Promise<MqttClient>;
  randomHex: (bytes: number) => string;
  keepAwake: { hold(key: string): void; release(key: string): void };
}

function randomHex(bytes: number): string {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return Array.from(values, value => (value < 16 ? '0' : '') + value.toString(16)).join('');
}

function failureReason(error: unknown): string {
  return error instanceof MqttConnectError ? error.reason : 'error';
}

const DEFAULT_DEPS: FinderShareDeps = { connect: options => MqttClient.connect(options), randomHex, keepAwake: KeepAwake };

/**
 * Streams the signal finder's readings to a phone through a public MQTT
 * relay. The share id is random and lives as long as the app, so a phone
 * that scanned the QR keeps working when sharing is turned off and on.
 * The broker drops a retained "stopped" status in place of a TV that
 * vanishes, and stop() publishes the same. While it shares, the TV stays
 * out of its screensaver: nobody presses a key while on the roof.
 */
export class FinderShareSession {
  private stateValue: FinderShareState = 'off';
  private readonly listeners = new Set<() => void>();
  private client: MqttClient | null = null;
  private broker = -1;
  private id: string | null = null;
  private labels: ViewerLabels | null = null;
  private token = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private statusTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: FinderShareDeps = DEFAULT_DEPS) {
    // Another app in front owns the tuner and the screen; sharing ends.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) this.stop();
      });
    }
  }

  get state(): FinderShareState {
    return this.stateValue;
  }

  get active(): boolean {
    return this.stateValue !== 'off';
  }

  // Known once a broker answered, and kept while reconnecting.
  get viewerUrl(): string | null {
    return this.id && this.broker >= 0 && (this.stateValue === 'live' || this.stateValue === 'reconnecting')
      ? viewerUrl(FINDER_VIEWER_URL, this.broker, this.id) : null;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async start(labels: ViewerLabels): Promise<void> {
    if (this.active && this.stateValue !== 'failed') return;
    const token = ++this.token;
    this.labels = labels;
    this.id = this.id ?? this.deps.randomHex(16);
    this.setState('connecting');
    for (let index = 0; index < FINDER_BROKERS.length; index++) {
      try {
        const client = await this.open(index);
        if (token !== this.token) {
          client.close();
          return;
        }
        this.broker = index;
        this.adopt(client, token);
        return;
      } catch (error) {
        if (token !== this.token) return;
        log.warn('Finder share broker failed', 'event=satellite.share.failed',
          `broker=${String(index)}`, `reason=${failureReason(error)}`);
      }
    }
    this.setState('failed');
  }

  stop(): void {
    if (!this.active) return;
    this.token++;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.stopStatusRefresh();
    const client = this.client;
    this.client = null;
    if (client && this.id && this.labels) {
      client.publish(statusTopic(this.id), this.status(false), true);
      client.close();
    }
    this.setState('off');
  }

  publish(reading: FinderReading): void {
    if (!this.client || !this.id || this.stateValue !== 'live') return;
    const message: ReadingMessage = { v: FINDER_SHARE_VERSION, ...reading };
    this.client.publish(readingTopic(this.id), JSON.stringify(message));
  }

  private open(index: number): Promise<MqttClient> {
    const id = this.id as string;
    return this.deps.connect({
      url: FINDER_BROKERS[index],
      clientId: `ipf${this.deps.randomHex(8)}`,
      keepAliveSeconds: KEEPALIVE_S,
      connectTimeoutMs: CONNECT_TIMEOUT_MS,
      will: { topic: statusTopic(id), payload: this.status(false), retain: true },
    });
  }

  private adopt(client: MqttClient, token: number): void {
    this.client = client;
    client.onLost = () => {
      if (token !== this.token || this.client !== client) return;
      this.client = null;
      this.stopStatusRefresh();
      log.warn('Finder share connection lost', 'event=satellite.share.dropped', `broker=${String(this.broker)}`);
      this.setState('reconnecting');
      this.scheduleReconnect(token);
    };
    const publishOn = () => client.publish(statusTopic(this.id as string), this.status(true), true);
    publishOn();
    this.stopStatusRefresh();
    this.statusTimer = setInterval(publishOn, STATUS_REFRESH_MS);
    this.setState('live');
  }

  private stopStatusRefresh(): void {
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = null;
  }

  // The QR names one broker, so a lost connection retries that one only.
  private scheduleReconnect(token: number): void {
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (token !== this.token) return;
      this.open(this.broker).then((client) => {
        if (token !== this.token) {
          client.close();
          return;
        }
        this.adopt(client, token);
      }, () => {
        if (token === this.token) this.scheduleReconnect(token);
      });
    }, RECONNECT_MS);
  }

  private status(on: boolean): string {
    const message: StatusMessage = { v: FINDER_SHARE_VERSION, on, labels: this.labels as ViewerLabels };
    return JSON.stringify(message);
  }

  private setState(state: FinderShareState): void {
    if (state === this.stateValue) return;
    this.stateValue = state;
    // A failed share has nothing left to wait on.
    if (state === 'off' || state === 'failed') this.deps.keepAwake.release(KEEP_AWAKE);
    else this.deps.keepAwake.hold(KEEP_AWAKE);
    this.listeners.forEach(listener => listener());
  }
}

export const FinderShare = new FinderShareSession();
