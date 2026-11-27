// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FinderShareSession, KEEPALIVE_S, STATUS_REFRESH_MS, type FinderReading } from './finder-share';
import { MqttConnectError, type MqttClient, type MqttClientOptions } from './mqtt-lite';
import { FALLBACK_LABELS, FINDER_BROKERS, parseStatus, readingTopic, statusTopic } from './finder-share-protocol';

const ID = 'ab'.repeat(16);

interface FakeClient {
  publish: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  onLost: (() => void) | null;
  onMessage: null;
}

function fakeClient(): FakeClient {
  return { publish: vi.fn(), close: vi.fn(), onLost: null, onMessage: null };
}

function session(outcomes: Array<FakeClient | 'fail'>) {
  const calls: MqttClientOptions[] = [];
  const awake = new Set<string>();
  const keepAwake = { hold: (key: string) => { awake.add(key); }, release: (key: string) => { awake.delete(key); } };
  const connect = vi.fn((options: MqttClientOptions) => {
    calls.push(options);
    const next = outcomes.shift();
    return next && next !== 'fail'
      ? Promise.resolve(next as unknown as MqttClient)
      : Promise.reject(new MqttConnectError('timeout'));
  });
  const share = new FinderShareSession({
    connect, keepAwake, randomHex: bytes => (bytes === 16 ? ID : 'cd'.repeat(bytes)),
  });
  return { share, calls, awake };
}

const READING: FinderReading = {
  lock: 'locked', strength: 70, quality: 55, ber: null, satellite: 'Alpha', transponder: '11000 H 27500',
};

function events(spy: ReturnType<typeof vi.spyOn>, name: string): string[] {
  return spy.mock.calls.map(call => call.join(' ')).filter(line => line.includes(`event=${name} `));
}

function statusPublishes(client: FakeClient): boolean[] {
  return client.publish.mock.calls
    .filter(call => call[0] === statusTopic(ID))
    .map(call => parseStatus(call[1] as string)?.on ?? false);
}

describe('FinderShareSession', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('connects with a short keepalive so a dead socket shows within seconds', async () => {
    const { share, calls } = session([fakeClient()]);
    await share.start(FALLBACK_LABELS);
    expect(KEEPALIVE_S).toBeLessThanOrEqual(10);
    expect(calls[0].keepAliveSeconds).toBe(KEEPALIVE_S);
  });

  // An old connection's will can reach the broker after a reconnect and
  // leave a retained "stopped"; the live share overwrites it.
  it('republishes its retained status while live, and not after stop', async () => {
    vi.useFakeTimers();
    const client = fakeClient();
    const { share } = session([client]);
    await share.start(FALLBACK_LABELS);
    expect(statusPublishes(client)).toEqual([true]);
    vi.advanceTimersByTime(STATUS_REFRESH_MS * 2);
    expect(statusPublishes(client)).toEqual([true, true, true]);
    share.stop();
    vi.advanceTimersByTime(STATUS_REFRESH_MS * 2);
    expect(statusPublishes(client)).toEqual([true, true, true, false]);
  });

  it('stops sharing when the app goes to the background', async () => {
    const client = fakeClient();
    const { share, awake } = session([client]);
    await share.start(FALLBACK_LABELS);
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    hidden.mockRestore();
    expect(share.state).toBe('off');
    expect(statusPublishes(client)).toEqual([true, false]);
    expect(awake.size).toBe(0);
  });

  it('holds the screensaver off only while a share is under way', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { share, awake } = session(['fail', 'fail', fakeClient()]);
    const starting = share.start(FALLBACK_LABELS);
    expect(awake.size).toBe(1);
    await starting;
    expect(share.state).toBe('failed');
    expect(awake.size).toBe(0);
    await share.start(FALLBACK_LABELS);
    expect(awake.size).toBe(1);
    share.stop();
    expect(awake.size).toBe(0);
  });

  it('falls back to the next broker and names it in the viewer link', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = fakeClient();
    const { share, calls } = session(['fail', client]);
    await share.start(FALLBACK_LABELS);
    expect(calls.map(call => call.url)).toEqual([FINDER_BROKERS[0], FINDER_BROKERS[1]]);
    expect(calls[0].will?.retain).toBe(true);
    expect(parseStatus(calls[0].will?.payload ?? '')?.on).toBe(false);
    expect(share.state).toBe('live');
    expect(share.viewerUrl).toMatch(new RegExp(`#b=1&t=${ID}$`));
    expect(events(warn, 'satellite.share.failed')).toEqual([
      expect.stringContaining('event=satellite.share.failed broker=0 reason=timeout'),
    ]);
    const [topic, payload, retain] = client.publish.mock.calls[0];
    expect(topic).toBe(statusTopic(ID));
    expect(parseStatus(payload as string)?.on).toBe(true);
    expect(retain).toBe(true);
  });

  it('fails with no QR when no broker answers, and can retry', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = fakeClient();
    const { share } = session(['fail', 'fail', client]);
    await share.start(FALLBACK_LABELS);
    expect(share.state).toBe('failed');
    expect(share.viewerUrl).toBeNull();
    await share.start(FALLBACK_LABELS);
    expect(share.state).toBe('live');
  });

  it('publishes readings only while live, and a stopped status on stop', async () => {
    const client = fakeClient();
    const { share } = session([client]);
    share.publish(READING);
    expect(client.publish).not.toHaveBeenCalled();
    await share.start(FALLBACK_LABELS);
    share.publish(READING);
    expect(client.publish).toHaveBeenLastCalledWith(readingTopic(ID), JSON.stringify({ v: 1, ...READING }));
    share.stop();
    const [topic, payload, retain] = client.publish.mock.calls[client.publish.mock.calls.length - 1];
    expect([topic, parseStatus(payload as string)?.on, retain]).toEqual([statusTopic(ID), false, true]);
    expect(client.close).toHaveBeenCalled();
    expect(share.state).toBe('off');
    share.publish(READING);
    expect(client.publish).toHaveBeenCalledTimes(3);
  });

  it('keeps one share id for the app session', async () => {
    const { share } = session([fakeClient(), fakeClient()]);
    await share.start(FALLBACK_LABELS);
    const first = share.viewerUrl;
    share.stop();
    await share.start(FALLBACK_LABELS);
    expect(share.viewerUrl).toBe(first);
  });

  it('reconnects to the same broker after a drop and keeps the QR', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const first = fakeClient();
    const second = fakeClient();
    const { share, calls } = session(['fail', first, 'fail', second]);
    await share.start(FALLBACK_LABELS);
    const url = share.viewerUrl;
    first.onLost?.();
    expect(share.state).toBe('reconnecting');
    expect(share.viewerUrl).toBe(url);
    expect(events(warn, 'satellite.share.dropped')).toEqual([
      expect.stringContaining('event=satellite.share.dropped broker=1'),
    ]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(share.state).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(3000);
    expect(share.state).toBe('live');
    expect(calls.slice(2).map(call => call.url)).toEqual([FINDER_BROKERS[1], FINDER_BROKERS[1]]);
    // Retries after the drop leave no further events.
    expect(events(warn, 'satellite.share.dropped')).toHaveLength(1);
    expect(events(warn, 'satellite.share.failed')).toHaveLength(1);
  });

  it('closes a connection that answers after stop', async () => {
    let resolve: (client: MqttClient) => void = () => undefined;
    const client = fakeClient();
    const share = new FinderShareSession({
      connect: () => new Promise((done) => { resolve = done; }),
      randomHex: () => ID,
      keepAwake: { hold: () => undefined, release: () => undefined },
    });
    const starting = share.start(FALLBACK_LABELS);
    share.stop();
    resolve(client as unknown as MqttClient);
    await starting;
    expect(client.close).toHaveBeenCalled();
    expect(share.state).toBe('off');
  });
});
