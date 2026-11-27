import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DISCONNECT,
  encodeConnect,
  encodePublish,
  encodeRemainingLength,
  encodeSubscribe,
  MqttClient,
  MqttConnectError,
  PacketReader,
} from './mqtt-lite';

class FakeSocket {
  readyState = 0;
  binaryType = '';
  sent: Uint8Array[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  send(bytes: Uint8Array): void {
    this.sent.push(bytes);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(...bytes: number[]): void {
    this.onmessage?.({ data: Uint8Array.from(bytes).buffer });
  }
}

function connectWith(socket: FakeSocket, timeout = 1000): Promise<MqttClient> {
  return MqttClient.connect({
    url: 'wss://host/a',
    clientId: 'c1',
    keepAliveSeconds: 30,
    connectTimeoutMs: timeout,
    createSocket: () => socket as unknown as WebSocket,
  });
}

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe('mqtt-lite encoding', () => {
  it('encodes the remaining length in 7-bit groups', () => {
    expect(encodeRemainingLength(0)).toEqual([0]);
    expect(encodeRemainingLength(127)).toEqual([0x7f]);
    expect(encodeRemainingLength(128)).toEqual([0x80, 0x01]);
    expect(encodeRemainingLength(16383)).toEqual([0xff, 0x7f]);
    expect(encodeRemainingLength(16384)).toEqual([0x80, 0x80, 0x01]);
    expect(() => encodeRemainingLength(268435456)).toThrow(RangeError);
  });

  it('encodes CONNECT with a retained will and a clean session', () => {
    const bytes = encodeConnect({ clientId: 'c1', keepAliveSeconds: 30, will: { topic: 't', payload: 'p', retain: true } });
    expect(Array.from(bytes)).toEqual([
      0x10, 20,
      0, 4, 0x4d, 0x51, 0x54, 0x54, 4, 0x26, 0, 30,
      0, 2, 0x63, 0x31,
      0, 1, 0x74,
      0, 1, 0x70,
    ]);
  });

  it('encodes a retained PUBLISH and a SUBSCRIBE', () => {
    expect(Array.from(encodePublish('a/b', 'hi', true))).toEqual([0x31, 7, 0, 3, 0x61, 0x2f, 0x62, 0x68, 0x69]);
    expect(Array.from(encodePublish('a', '', false))[0]).toBe(0x30);
    expect(Array.from(encodeSubscribe(1, 'a/+'))).toEqual([0x82, 8, 0, 1, 0, 3, 0x61, 0x2f, 0x2b, 0]);
  });

  it('reads packets split across messages and several in one', () => {
    const reader = new PacketReader();
    const publish = Array.from(encodePublish('a/b', 'hello', true));
    expect(reader.push(Uint8Array.from(publish.slice(0, 4)))).toEqual([]);
    const packets = reader.push(Uint8Array.from([...publish.slice(4), 0xd0, 0, 0x20, 2, 0, 0]));
    expect(packets.map(item => item.type)).toEqual(['publish', 'pingresp', 'connack']);
    const first = packets[0];
    expect(first.type === 'publish' && text(first.payload)).toBe('hello');
    expect(first.type === 'publish' && first.retain).toBe(true);
  });

  it('skips the packet id of a QoS 1 PUBLISH', () => {
    const reader = new PacketReader();
    const [packet] = reader.push(Uint8Array.from([0x32, 8, 0, 1, 0x61, 0, 9, 0x6f, 0x6b, 0x21]));
    expect(packet.type === 'publish' && text(packet.payload)).toBe('ok!');
  });
});

describe('MqttClient', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('connects on CONNACK 0 and delivers publishes', async () => {
    const socket = new FakeSocket();
    const connecting = connectWith(socket);
    socket.open();
    expect(text(socket.sent[0])).toContain('MQTT');
    socket.receive(0x20, 2, 0, 0);
    const client = await connecting;
    const messages: string[] = [];
    client.onMessage = (topic, payload, retain) => messages.push(`${topic}=${payload}:${String(retain)}`);
    socket.receive(...Array.from(encodePublish('a/b', 'x', true)));
    expect(messages).toEqual(['a/b=x:true']);
  });

  it('rejects a refused connection', async () => {
    const socket = new FakeSocket();
    const connecting = connectWith(socket);
    socket.open();
    socket.receive(0x20, 2, 0, 5);
    await expect(connecting).rejects.toEqual(new MqttConnectError('refused'));
    expect(socket.closed).toBe(true);
  });

  it('times out when the broker never answers', async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const connecting = connectWith(socket, 500);
    const failed = expect(connecting).rejects.toMatchObject({ reason: 'timeout' });
    vi.advanceTimersByTime(500);
    await failed;
  });

  it('reports a lost connection but not its own close', async () => {
    const lost = vi.fn();
    const first = new FakeSocket();
    const connecting = connectWith(first);
    first.open();
    first.receive(0x20, 2, 0, 0);
    const client = await connecting;
    client.onLost = lost;
    first.onclose?.();
    expect(lost).toHaveBeenCalledTimes(1);

    const second = new FakeSocket();
    const again = connectWith(second);
    second.open();
    second.receive(0x20, 2, 0, 0);
    const other = await again;
    other.onLost = lost;
    other.close();
    expect(Array.from(second.sent[second.sent.length - 1])).toEqual(Array.from(DISCONNECT));
    expect(lost).toHaveBeenCalledTimes(1);
  });

  it('treats a broker that stops answering pings as lost', async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const connecting = connectWith(socket);
    socket.open();
    socket.receive(0x20, 2, 0, 0);
    const client = await connecting;
    const lost = vi.fn();
    client.onLost = lost;
    vi.advanceTimersByTime(30000);
    expect(lost).not.toHaveBeenCalled();
    expect(socket.sent.some(bytes => bytes[0] === 0xc0)).toBe(true);
    vi.advanceTimersByTime(30000);
    expect(lost).toHaveBeenCalledTimes(1);
  });
});
