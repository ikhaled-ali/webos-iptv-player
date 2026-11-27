// A minimal MQTT 3.1.1 client over WebSocket: connect with a will,
// QoS 0 publish and subscribe, keepalive. The signal finder's phone share
// needs nothing more, and a full client library is far larger than the
// protocol subset it would use.

const PROTOCOL_LEVEL = 4;
const MAX_REMAINING_LENGTH = 268435455;

export type MqttPacket =
  | { type: 'connack'; returnCode: number }
  | { type: 'publish'; topic: string; payload: Uint8Array; retain: boolean }
  | { type: 'suback' }
  | { type: 'pingresp' }
  | { type: 'other'; code: number };

export interface MqttWill {
  topic: string;
  payload: string;
  retain: boolean;
}

export interface ConnectOptions {
  clientId: string;
  keepAliveSeconds: number;
  will?: MqttWill;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeRemainingLength(length: number): number[] {
  if (length < 0 || length > MAX_REMAINING_LENGTH) throw new RangeError('MQTT packet too large');
  const bytes: number[] = [];
  let rest = length;
  do {
    let byte = rest % 128;
    rest = Math.floor(rest / 128);
    if (rest > 0) byte |= 0x80;
    bytes.push(byte);
  } while (rest > 0);
  return bytes;
}

function utf8Field(text: string): number[] {
  const bytes = encoder.encode(text);
  if (bytes.length > 0xffff) throw new RangeError('MQTT string too long');
  return [bytes.length >> 8, bytes.length & 0xff, ...Array.from(bytes)];
}

function packet(first: number, body: number[]): Uint8Array {
  return Uint8Array.from([first, ...encodeRemainingLength(body.length), ...body]);
}

export function encodeConnect(options: ConnectOptions): Uint8Array {
  const will = options.will;
  // Clean session, plus the will at QoS 0 when there is one.
  const flags = 0x02 | (will ? 0x04 | (will.retain ? 0x20 : 0) : 0);
  const keepAlive = Math.max(0, Math.min(0xffff, Math.round(options.keepAliveSeconds)));
  const body = [
    ...utf8Field('MQTT'), PROTOCOL_LEVEL, flags, keepAlive >> 8, keepAlive & 0xff,
    ...utf8Field(options.clientId),
  ];
  if (will) body.push(...utf8Field(will.topic), ...utf8Field(will.payload));
  return packet(0x10, body);
}

export function encodePublish(topic: string, payload: string, retain: boolean): Uint8Array {
  return packet(0x30 | (retain ? 0x01 : 0), [...utf8Field(topic), ...Array.from(encoder.encode(payload))]);
}

export function encodeSubscribe(packetId: number, filter: string): Uint8Array {
  return packet(0x82, [(packetId >> 8) & 0xff, packetId & 0xff, ...utf8Field(filter), 0]);
}

export const PINGREQ = Uint8Array.of(0xc0, 0);
export const DISCONNECT = Uint8Array.of(0xe0, 0);

function decodePacket(first: number, body: Uint8Array): MqttPacket {
  const code = first >> 4;
  if (code === 2) return { type: 'connack', returnCode: body.length > 1 ? body[1] : 0xff };
  if (code === 9) return { type: 'suback' };
  if (code === 13) return { type: 'pingresp' };
  if (code === 3) {
    const topicLength = (body[0] << 8) | body[1];
    const qos = (first >> 1) & 0x03;
    const start = 2 + topicLength + (qos > 0 ? 2 : 0);
    return {
      type: 'publish',
      topic: decoder.decode(body.subarray(2, 2 + topicLength)),
      payload: body.subarray(Math.min(start, body.length)),
      retain: (first & 0x01) === 1,
    };
  }
  return { type: 'other', code };
}

// A WebSocket message may carry part of a packet or several packets.
export class PacketReader {
  private buffer = new Uint8Array(0);

  push(chunk: Uint8Array): MqttPacket[] {
    const joined = new Uint8Array(this.buffer.length + chunk.length);
    joined.set(this.buffer);
    joined.set(chunk, this.buffer.length);
    const packets: MqttPacket[] = [];
    let at = 0;
    for (;;) {
      if (joined.length - at < 2) break;
      let length = 0;
      let multiplier = 1;
      let index = at + 1;
      let complete = false;
      while (index < joined.length && index - at <= 4) {
        const byte = joined[index++];
        length += (byte & 0x7f) * multiplier;
        multiplier *= 128;
        if ((byte & 0x80) === 0) {
          complete = true;
          break;
        }
      }
      if (!complete) {
        if (index - at > 4) throw new RangeError('Malformed MQTT length');
        break;
      }
      if (joined.length - index < length) break;
      packets.push(decodePacket(joined[at], joined.subarray(index, index + length)));
      at = index + length;
    }
    this.buffer = joined.slice(at);
    return packets;
  }
}

export type MqttFailure = 'timeout' | 'refused' | 'closed' | 'error';

export interface MqttClientOptions extends ConnectOptions {
  url: string;
  connectTimeoutMs: number;
  // For tests; the browser's WebSocket otherwise.
  createSocket?: (url: string) => WebSocket;
}

export class MqttConnectError extends Error {
  constructor(readonly reason: MqttFailure) {
    super(`MQTT connect failed: ${reason}`);
  }
}

export class MqttClient {
  onMessage: ((topic: string, payload: string, retain: boolean) => void) | null = null;
  // An open connection ended without close() being called.
  onLost: (() => void) | null = null;
  private readonly reader = new PacketReader();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastInbound = Date.now();
  private closed = false;
  private packetId = 0;

  private constructor(private readonly socket: WebSocket, private readonly keepAliveSeconds: number) {}

  static connect(options: MqttClientOptions): Promise<MqttClient> {
    return new Promise((resolve, reject) => {
      let socket: WebSocket;
      try {
        socket = options.createSocket ? options.createSocket(options.url) : new WebSocket(options.url, 'mqtt');
      } catch {
        reject(new MqttConnectError('error'));
        return;
      }
      socket.binaryType = 'arraybuffer';
      const client = new MqttClient(socket, options.keepAliveSeconds);
      let settled = false;
      const fail = (reason: MqttFailure): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        client.shutdown();
        reject(new MqttConnectError(reason));
      };
      const timer = setTimeout(() => fail('timeout'), options.connectTimeoutMs);
      socket.onopen = () => client.send(encodeConnect(options));
      socket.onerror = () => fail('error');
      socket.onclose = () => {
        if (!settled) fail('closed');
        else client.lost();
      };
      socket.onmessage = (event: MessageEvent) => {
        let packets: MqttPacket[];
        try {
          packets = client.reader.push(new Uint8Array(event.data as ArrayBuffer));
        } catch {
          if (settled) client.lost();
          else fail('error');
          return;
        }
        client.lastInbound = Date.now();
        for (const item of packets) {
          if (item.type === 'connack' && !settled) {
            if (item.returnCode !== 0) {
              fail('refused');
              return;
            }
            settled = true;
            clearTimeout(timer);
            client.startKeepAlive();
            resolve(client);
          } else if (item.type === 'publish' && client.onMessage) {
            client.onMessage(item.topic, decoder.decode(item.payload), item.retain);
          }
        }
      };
    });
  }

  publish(topic: string, payload: string, retain = false): void {
    this.send(encodePublish(topic, payload, retain));
  }

  subscribe(filter: string): void {
    this.packetId = this.packetId % 0xffff + 1;
    this.send(encodeSubscribe(this.packetId, filter));
  }

  // A clean disconnect: the broker drops the will.
  close(): void {
    if (this.closed) return;
    this.send(DISCONNECT);
    this.shutdown();
  }

  private send(bytes: Uint8Array): void {
    if (this.closed || this.socket.readyState !== 1) return;
    this.socket.send(bytes);
  }

  // The broker answers every ping, so a silent socket is a dead one; a
  // client that only publishes would otherwise never notice.
  private startKeepAlive(): void {
    const period = Math.max(1000, this.keepAliveSeconds * 500);
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastInbound > this.keepAliveSeconds * 1500) {
        this.lost();
        return;
      }
      this.send(PINGREQ);
    }, period);
  }

  private lost(): void {
    if (this.closed) return;
    this.shutdown();
    if (this.onLost) this.onLost();
  }

  private shutdown(): void {
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.socket.onopen = null;
    this.socket.onmessage = null;
    this.socket.onerror = null;
    this.socket.onclose = null;
    try {
      this.socket.close();
    } catch {
      // Already closing.
    }
  }
}
