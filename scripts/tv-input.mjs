#!/usr/bin/env node
// Drive remote-control input on the LG webOS TV the way a real remote does.
//
// The default evdev backend writes Linux input events into the TV's own input
// devices over the developer-mode shell, so webOS's compositor, cursor
// show/hide logic, and native scrolling all run exactly as with a physical
// remote. The --cdp backend synthesizes DOM events through DevTools instead,
// for targets without a writable /dev/input (the webOS 4 emulator).
//
// wake powers the TV back on with a Wake-on-LAN magic packet. Its MAC comes
// from this computer's ARP cache or else from the TV over SSH, remembered in a
// per-user cache file outside the repository, so no address lives in a
// tracked file or in the output.
import { execFileSync, spawnSync } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir, networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  connectCdpWithAresFallback,
  resolveConfiguredDevice,
  resolveConfiguredDeviceIp,
} from './cdp-client.mjs';
import { formatOptions, parseArgs } from './cli-args.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const TV_SCRIPT = join(SCRIPT_DIR, 'tv.sh');
const DEFAULT_APP_ID = 'com.ikhaled.iptv';
const DEFAULT_PORT = 9998;
const SCREEN = { width: 1920, height: 1080 };
const MOVE_TOLERANCE = 1;
const MOVE_ROUNDS = 5;
const DEFAULT_SSH_PORT = 9922;
const SSH_GRACE_SECONDS = 5;
const WAKE_PORTS = [9, 7];
const LIMITED_BROADCAST = '255.255.255.255';

// name -> [Linux evdev code on the "LGE RCU" device, DOM keyCode it produces]
export const KEYS = new Map([
  ['up', [103, 38]],
  ['down', [108, 40]],
  ['left', [105, 37]],
  ['right', [106, 39]],
  ['ok', [28, 13]],
  ['back', [412, 461]],
  ['red', [398, 403]],
  ['green', [399, 404]],
  ['yellow', [400, 405]],
  ['blue', [401, 406]],
  ['ch-up', [402, 33]],
  ['ch-down', [403, 34]],
  ['play', [207, 415]],
  ['pause', [119, 19]],
  ['stop', [128, 413]],
  ['rewind', [168, 412]],
  ['forward', [208, 417]],
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [String(n), [n + 1, 48 + n]]),
  ['0', [11, 48]],
  // webOS keeps power for itself; no page sees a key event for it.
  ['power', [116, null]],
]);

// Relative ClickableMouse step -> CSS pixels moved, measured on webOS 25 with
// steps at least 30 ms apart. webOS accelerates by magnitude and caps a single
// step near 58 px; faster bursts accelerate further, so steps are spaced out.
export const POINTER_GAIN = [[16, 58], [12, 41], [8, 22], [6, 14], [4, 8], [3, 5], [2, 2], [1, 1]];

export const INPUT_SPEC = {
  commands: ['key', 'move', 'click', 'wheel', 'pos', 'wake'],
  options: {
    gap: {
      type: 'integer',
      min: 0,
      default: 150,
      commands: ['key', 'wheel'],
      valueName: '<ms>',
      description: 'Delay between repeated keys or wheel notches',
    },
    at: {
      type: 'integer',
      arity: 2,
      commands: ['wheel'],
      valueName: '<px>',
      description: 'Scroll at this x y point instead of at the pointer',
    },
    cdp: {
      type: 'boolean',
      description: 'Synthesize DOM events over DevTools instead of writing the '
        + 'TV\'s input devices (for the webOS 4 emulator)',
    },
    app: {
      type: 'string',
      default: DEFAULT_APP_ID,
      valueName: '<id>',
      description: 'App page to observe',
    },
    timeout: {
      type: 'number',
      positive: true,
      default: 90,
      commands: ['wake'],
      valueName: '<s>',
      description: 'Seconds to wait for the TV to wake',
    },
    'no-wait': {
      type: 'boolean',
      commands: ['wake'],
      description: 'Send the packet and return',
    },
    learn: {
      type: 'boolean',
      commands: ['wake'],
      description: 'Remember the MAC of the TV, which must be on',
    },
    help: { type: 'boolean', short: 'h', description: 'Show this help' },
  },
};

export const INPUT_HELP = `Drive remote-control input on the LG webOS TV.

Usage:
  scripts/tv.sh input key <name>... [--gap <ms>]
  scripts/tv.sh input move <x> <y>
  scripts/tv.sh input click [<x> <y>]
  scripts/tv.sh input wheel <notches> [--at <x> <y>] [--gap <ms>]
  scripts/tv.sh input pos
  scripts/tv.sh input wake [--timeout <s>] [--no-wait]
  scripts/tv.sh input wake --learn

${formatOptions(INPUT_SPEC)}

Keys: ${[...KEYS.keys()].join(' ')}
Coordinates are CSS pixels on the 1920x1080 app canvas. A positive wheel count
scrolls down, a negative one up, at --at or else where the pointer is. A
hidden webOS cursor reappears at the screen center on the next move; any key
press hides it. Keys go straight to the TV, so they work with the app closed.
power turns the TV off; wake turns it back on. --cdp cannot send power or wake.

wake sends a Wake-on-LAN packet, then waits until the TV answers over SSH and
reports it is active, not in standby. The TV's
MAC is learned while the TV is on, from this computer's ARP cache or else
from the TV over SSH, and remembered outside the repository
(${'$'}XDG_CACHE_HOME or ~/.cache); run wake --learn once with the TV on, or set
TV_MAC. The TV must have Wake-on-LAN enabled, and this computer must share its
subnet. A TV that is on with its SSH port closed fails within a few seconds.
`;

const integer = (value, name) => {
  const number = Number(value);
  if (!Number.isInteger(number)) throw new Error(`${name} must be an integer`);
  return number;
};

const coordinate = (value, name, max) => {
  const number = integer(value, name);
  if (number < 0 || number >= max) throw new Error(`${name} must be from 0 to ${max - 1}`);
  return number;
};

export function parseInputArgs(argv) {
  if (!argv.length || argv.includes('-h') || argv.includes('--help')) return { help: true };
  const { command, values, positionals: rest } = parseArgs(argv, INPUT_SPEC);
  const options = { help: false, cdp: values.cdp ?? false, app: values.app, gap: values.gap };
  const point = () => ({
    x: coordinate(rest[0], 'x', SCREEN.width),
    y: coordinate(rest[1], 'y', SCREEN.height),
  });
  switch (command) {
    case 'key': {
      if (!rest.length) throw new Error('key needs at least one key name');
      const unknown = rest.filter((name) => !KEYS.has(name));
      if (unknown.length) throw new Error(`unknown key ${unknown.join(', ')}`);
      const systemOnly = rest.filter((name) => KEYS.get(name)[1] === null);
      if (options.cdp && systemOnly.length) {
        throw new Error(`--cdp cannot send ${systemOnly.join(', ')}; it has no DOM key`);
      }
      return { ...options, command, keys: rest };
    }
    case 'move':
      if (rest.length !== 2) throw new Error('move needs <x> <y>');
      return { ...options, command, to: point() };
    case 'click':
      if (rest.length !== 0 && rest.length !== 2) throw new Error('click takes no point or <x> <y>');
      return { ...options, command, to: rest.length ? point() : undefined };
    case 'wheel': {
      if (rest.length !== 1) throw new Error('wheel needs <notches>');
      const notches = integer(rest[0], 'notches');
      if (notches === 0) throw new Error('notches must not be 0');
      const at = values.at && {
        x: coordinate(values.at[0], '--at x', SCREEN.width),
        y: coordinate(values.at[1], '--at y', SCREEN.height),
      };
      return { ...options, command, notches, at };
    }
    case 'pos':
      if (rest.length) throw new Error('pos takes no arguments');
      return { ...options, command };
    case 'wake':
      if (rest.length) throw new Error('wake takes no arguments');
      if (options.cdp) throw new Error('--cdp cannot wake the TV');
      return {
        ...options,
        command,
        timeout: values.timeout,
        wait: !values['no-wait'],
        learn: values.learn ?? false,
      };
    default:
      throw new Error(`unknown command ${command}`);
  }
}

// Split one axis distance into relative steps, largest first.
export function planAxis(distance) {
  const steps = [];
  let left = Math.abs(distance);
  const sign = Math.sign(distance);
  for (const [step, pixels] of POINTER_GAIN) {
    while (left >= pixels) {
      steps.push(step * sign);
      left -= pixels;
    }
  }
  return steps;
}

export function planMove(from, to) {
  return [
    ...planAxis(to.x - from.x).map((dx) => `m:${dx},0`),
    ...planAxis(to.y - from.y).map((dy) => `m:0,${dy}`),
  ];
}

const REMOTE_HELPER = join(SCRIPT_DIR, 'tv-input-remote.js');

const shellQuote = (value) => `'${value.replace(/'/g, "'\\''")}'`;

// The helper travels inline with `node -e`, so each command is a single ssh
// round trip with nothing left behind on the TV.
export function remoteCommand(steps, source = readFileSync(REMOTE_HELPER, 'utf8')) {
  return `node -e ${shellQuote(source)} ${steps.join(' ')}`;
}

export function withGaps(steps, gap) {
  return steps.flatMap((step, i) => (i && gap ? [`s:${gap}`, step] : [step]));
}

// Tracks the pointer from inside the page so moves can close the loop. The
// cursorStateChange event is webOS's own cursor show/hide notification.
const TRACKER = `(() => {
  const t = window.__tvInput || (window.__tvInput = { x: null, y: null, visible: null });
  if (!t.installed) {
    t.installed = true;
    document.addEventListener('mousemove', (e) => { t.x = e.clientX; t.y = e.clientY; t.visible = true; }, true);
    document.addEventListener('cursorStateChange', (e) => {
      t.visible = !!(e.detail && e.detail.visibility);
    }, true);
  }
  return { x: t.x, y: t.y, visible: t.visible };
})()`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function runOnTv(steps) {
  if (!steps.length) return;
  const result = spawnSync(TV_SCRIPT, ['run', remoteCommand(steps)], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (result.error) throw new Error(`tv.sh run failed: ${result.error.message}`);
  if (result.signal) throw new Error(`tv.sh run was killed by ${result.signal}`);
  if (result.status !== 0) throw new Error(`tv.sh run failed with exit code ${result.status}`);
}

export function evdevBackend(page, run = runOnTv) {
  const position = () => page.evaluate(TRACKER);
  // A hidden cursor jumps to the center before applying the first step, and a
  // tracker installed after the last move has no position yet: nudge to learn it.
  const locate = async () => {
    const pos = await position();
    if (pos.x !== null && pos.visible !== false) return pos;
    run(['m:1,0', 'm:-1,0']);
    await sleep(150);
    return position();
  };
  return {
    async key(names, gap) {
      run(withGaps(names.map((name) => `k:${KEYS.get(name)[0]}`), gap));
    },
    async move(to) {
      let pos = await locate();
      if (pos.x === null) throw new Error('pointer position unknown; move the Magic Remote once and retry');
      for (let round = 0; round < MOVE_ROUNDS; round++) {
        if (Math.abs(pos.x - to.x) <= MOVE_TOLERANCE && Math.abs(pos.y - to.y) <= MOVE_TOLERANCE) return pos;
        const steps = planMove(pos, to);
        run(steps.length ? steps : [`m:${Math.sign(to.x - pos.x)},${Math.sign(to.y - pos.y)}`]);
        await sleep(150);
        pos = await position();
      }
      throw new Error(`pointer stopped at ${pos.x},${pos.y}, not ${to.x},${to.y}`);
    },
    async click() {
      run(['c:']);
    },
    async wheel(notches, gap, at) {
      const pos = at || await locate();
      const where = pos.x === null ? '' : `@${pos.x},${pos.y}`;
      run(withGaps(
        Array.from({ length: Math.abs(notches) }, () => `w:${Math.sign(notches)}${where}`),
        gap,
      ));
    },
    position: locate,
  };
}

// Chromium 53 ignores keyCode in the KeyboardEvent constructor, so the codes
// are defined on the event instance the app reads.
const keyScript = (keyCode, type) => `(() => {
  const e = new KeyboardEvent('${type}', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'keyCode', { get: () => ${keyCode} });
  Object.defineProperty(e, 'which', { get: () => ${keyCode} });
  (document.activeElement || document.body).dispatchEvent(e);
})()`;

function cdpBackend(page, client) {
  let last = { x: SCREEN.width / 2, y: SCREEN.height / 2 };
  const mouse = (type, extra = {}) => client.call('Input.dispatchMouseEvent', {
    type, x: last.x, y: last.y, ...extra,
  });
  return {
    async key(names, gap) {
      for (const [i, name] of names.entries()) {
        if (i && gap) await sleep(gap);
        const code = KEYS.get(name)[1];
        await page.evaluate(keyScript(code, 'keydown'));
        await page.evaluate(keyScript(code, 'keyup'));
      }
    },
    async move(to) {
      last = to;
      await mouse('mouseMoved');
      return to;
    },
    async click() {
      await mouse('mousePressed', { button: 'left', clickCount: 1 });
      await mouse('mouseReleased', { button: 'left', clickCount: 1 });
    },
    async wheel(notches, gap, at) {
      if (at) last = at;
      for (let i = 0; i < Math.abs(notches); i++) {
        if (i && gap) await sleep(gap);
        await mouse('mouseWheel', { deltaX: 0, deltaY: 120 * Math.sign(notches) });
      }
    },
    async position() {
      const pos = await page.evaluate(TRACKER);
      return pos.x === null ? last : pos;
    },
  };
}

// Wake-on-LAN

export function normalizeMac(text) {
  const parts = String(text).trim().toLowerCase().split(/[:-]/);
  if (parts.length !== 6 || parts.some((part) => !/^[0-9a-f]{1,2}$/.test(part))) return null;
  const mac = parts.map((part) => part.padStart(2, '0')).join(':');
  return mac === '00:00:00:00:00:00' || mac === 'ff:ff:ff:ff:ff:ff' ? null : mac;
}

// Accepts `arp -n <ip>` (macOS and Linux) and `ip neigh show <ip>` output.
export function parseArpMac(output, ip) {
  for (const line of String(output).split('\n')) {
    if (!line.split(/[\s()]+/).includes(ip)) continue;
    const match = line.match(/(?:^|\s)((?:[0-9a-f]{1,2}[:-]){5}[0-9a-f]{1,2})(?=\s|$)/i);
    const mac = match && normalizeMac(match[1]);
    if (mac) return mac;
  }
  return null;
}

export function magicPacket(mac) {
  const bytes = normalizeMac(mac)?.split(':').map((part) => parseInt(part, 16));
  if (!bytes) throw new Error('invalid MAC address');
  const packet = Buffer.alloc(102, 0xff);
  for (let i = 0; i < 16; i++) Buffer.from(bytes).copy(packet, 6 + i * 6);
  return packet;
}

function ipToInt(ip) {
  return ip.split('.').reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0);
}

function intToIp(value) {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.');
}

// The directed broadcast of the local subnet holding ip, then the limited one.
export function broadcastAddresses(ip, interfaces = networkInterfaces()) {
  const target = ipToInt(ip);
  const addresses = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' && entry.family !== 4) continue;
      if (entry.internal) continue;
      const mask = ipToInt(entry.netmask);
      if ((ipToInt(entry.address) & mask) !== (target & mask)) continue;
      const broadcast = intToIp((target & mask) | (~mask >>> 0));
      if (!addresses.includes(broadcast)) addresses.push(broadcast);
    }
  }
  addresses.push(LIMITED_BROADCAST);
  return addresses;
}

export function cacheFile(env = process.env) {
  const base = env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(base, 'webos-iptv-player', 'wake.json');
}

export function readCachedMac(ip, file = cacheFile()) {
  try {
    return normalizeMac(JSON.parse(readFileSync(file, 'utf8'))[ip] ?? '');
  } catch {
    return null;
  }
}

export function writeCachedMac(ip, mac, file = cacheFile()) {
  let cache = {};
  try {
    cache = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    cache = {};
  }
  cache[ip] = mac;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
}

function lookupArp(ip) {
  for (const [command, args] of [['arp', ['-n', ip]], ['ip', ['neigh', 'show', ip]]]) {
    try {
      const mac = parseArpMac(execFileSync(command, args, {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }), ip);
      if (mac) return mac;
    } catch {
      // Try the next tool.
    }
  }
  return null;
}

export function probePort(ip, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = connect({ host: ip, port });
    const done = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function sendPacket(packet, addresses) {
  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4');
    socket.once('error', reject);
    socket.bind(() => {
      socket.setBroadcast(true);
      const sends = [];
      for (const address of addresses) {
        for (const port of WAKE_PORTS) {
          sends.push(new Promise((ok, fail) => {
            socket.send(packet, port, address, (error) => (error ? fail(error) : ok()));
          }));
        }
      }
      Promise.allSettled(sends).then((results) => {
        socket.close();
        if (results.every((result) => result.status === 'rejected')) reject(results[0].reason);
        else resolve();
      });
    });
  });
}

// One ssh round trip that works without ip or ifconfig, which webOS lacks:
// the kernel route table maps the IP to an interface, sysfs gives its MAC.
export const TV_MAC_COMMAND = [
  'echo @addr; (ip -o -4 addr || ifconfig) 2>/dev/null',
  'echo @route; cat /proc/net/route 2>/dev/null',
  'echo @mac; for f in /sys/class/net/*/address; do n=${f%/address}; echo "${n##*/} $(cat "$f" 2>/dev/null)"; done',
].join('; ');

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

// /proc/net/route prints addresses as native-endian hex, little-endian on TVs.
const routeHexToInt = (hex) => {
  const value = parseInt(hex, 16);
  return (((value & 255) << 24) | (((value >>> 8) & 255) << 16)
    | (((value >>> 16) & 255) << 8) | (value >>> 24)) >>> 0;
};

const baseInterface = (name) => name.replace(/:$/, '').replace(/[:@].*$/, '');

function addressInterface(lines, ip, macs) {
  let block = null;
  let found = null;
  for (const line of lines) {
    const short = line.match(/^\d+:\s+(\S+)\s+inet\s+([\d.]+)\//);
    if (short) {
      if (short[2] === ip) return baseInterface(short[1]);
      continue;
    }
    if (/^\S/.test(line)) {
      if (found) break;
      block = baseInterface(line.split(/\s+/)[0]);
    }
    if (!block) continue;
    const hardware = line.match(/(?:HWaddr|ether)\s+(\S+)/);
    const mac = hardware && normalizeMac(hardware[1]);
    if (mac && !macs.has(block)) macs.set(block, mac);
    const inet = line.match(/\binet\s+(?:addr:)?([\d.]+)/);
    if (inet && inet[1] === ip) found = block;
  }
  return found;
}

function routeInterface(lines, ip) {
  const target = ipToInt(ip);
  let best = null;
  for (const line of lines) {
    const [name, destination, gateway, flags, , , , mask] = line.trim().split(/\s+/);
    if (!/^[0-9a-f]{8}$/i.test(destination ?? '') || !/^[0-9a-f]{8}$/i.test(mask ?? '')) continue;
    if (!(parseInt(flags, 16) & 1) || parseInt(gateway, 16) !== 0) continue;
    const bits = routeHexToInt(mask);
    if ((target & bits) >>> 0 !== routeHexToInt(destination)) continue;
    if (!best || bits > best.bits) best = { name: baseInterface(name), bits };
  }
  return best && best.name;
}

// Finds, in TV_MAC_COMMAND output, the MAC of the TV interface holding ip.
export function parseTvMac(output, ip) {
  if (!IPV4.test(ip)) return null;
  const sections = { addr: [], route: [], mac: [] };
  let current = null;
  for (const raw of String(output).split('\n')) {
    const line = raw.replace(/\r$/, '');
    const marker = line.match(/^@(addr|route|mac)$/);
    if (marker) current = sections[marker[1]];
    else if (current) current.push(line);
  }
  const macs = new Map();
  for (const line of sections.mac) {
    const [name, address] = line.trim().split(/\s+/);
    const mac = address && normalizeMac(address);
    if (name && mac) macs.set(name, mac);
  }
  const name = addressInterface(sections.addr, ip, macs) || routeInterface(sections.route, ip);
  return (name && macs.get(name)) || null;
}

function lookupTvMac(ip) {
  const result = spawnSync(TV_SCRIPT, ['run', TV_MAC_COMMAND], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000,
  });
  return result.status === 0 ? parseTvMac(result.stdout, ip) : null;
}

// LG's LAN control ports answer whenever the TV is on, even with the
// Developer Mode SSH server down, and close in standby.
const CONTROL_PORTS = [3000, 3001];
const SSH_CLOSED = 'the TV is on but its SSH port is closed; check Developer Mode';

const POWER_COMMAND = "luna-send -n 1 -f luna://com.webos.service.tvpower/power/getPowerState '{}'";

export function parsePowerState(output) {
  const text = String(output);
  try {
    const state = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)).state;
    return typeof state === 'string' ? state : null;
  } catch {
    return null;
  }
}

// Right after power-off the TV may idle in standby with SSH still up.
function lookupPowerState() {
  const result = spawnSync(TV_SCRIPT, ['run', POWER_COMMAND], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000,
  });
  return result.status === 0 ? parsePowerState(result.stdout) : null;
}

export async function tvPowerState(ip, port = DEFAULT_SSH_PORT, probe = probePort) {
  if (await probe(ip, port)) return 'ssh';
  const control = await Promise.all(CONTROL_PORTS.map((port) => probe(ip, port, 1000)));
  return control.some(Boolean) ? 'on' : 'off';
}

// macOS can hide the ARP cache from a process without Local Network access,
// so an awake TV is also asked for its own MAC over SSH.
export async function learnMac(ip, {
  port = DEFAULT_SSH_PORT, probe = probePort, arp = lookupArp, tv = lookupTvMac, write = writeCachedMac,
} = {}) {
  // A TCP attempt refreshes the ARP entry even when the port is closed.
  const state = await tvPowerState(ip, port, probe);
  const mac = arp(ip) || (state === 'ssh' ? tv(ip) : null);
  if (mac) write(ip, mac);
  if (mac) return 'learned';
  return { ssh: 'unknown', on: 'no-ssh', off: 'asleep' }[state];
}

export async function wakeTv(options, {
  ip,
  port,
  env = process.env,
  probe = probePort,
  learn = learnMac,
  cached = readCachedMac,
  arp = lookupArp,
  send = sendPacket,
  power = lookupPowerState,
  wait = sleep,
  now = Date.now,
  log = console.log,
} = {}) {
  if (!ip) ({ ip, port } = resolveConfiguredDevice());
  port = port || DEFAULT_SSH_PORT;
  const remember = async () => {
    if (!cached(ip)) await learn(ip, { port });
  };
  // An unreadable power state leaves an answering SSH port as the only signal.
  const active = async () => {
    const state = await power();
    return state === null || state === 'Active';
  };
  if (options.learn) {
    const status = await learn(ip, { port });
    if (status === 'asleep') throw new Error('the TV is off; turn it on and retry');
    if (status === 'no-ssh') throw new Error(SSH_CLOSED);
    if (status === 'unknown') {
      throw new Error('could not read the TV\'s MAC address from the ARP cache or over SSH; check `scripts/tv.sh run true`, or set TV_MAC');
    }
    log('remembered the TV\'s MAC address');
    return;
  }
  const envMac = env.TV_MAC ? normalizeMac(env.TV_MAC) : null;
  if (env.TV_MAC && !envMac) throw new Error('TV_MAC is not a valid MAC address');
  const initial = await tvPowerState(ip, port, probe);
  const mac = envMac || cached(ip) || arp(ip);
  // A TV in standby can still answer; an active one ignores the packet.
  if (mac) await send(magicPacket(mac), broadcastAddresses(ip));
  if (initial === 'ssh' && await active()) {
    await remember();
    log('TV is already awake');
    return;
  }
  if (!mac && initial !== 'on') {
    throw new Error('no MAC address known for the TV; turn it on once and run `scripts/tv.sh input wake --learn`, or set TV_MAC');
  }
  if (mac) log('sent the Wake-on-LAN packet');
  if (!options.wait && initial !== 'on') return;
  const seconds = initial === 'on' ? SSH_GRACE_SECONDS : options.timeout;
  const deadline = now() + seconds * 1000;
  let last = 'off';
  while (now() < deadline) {
    const current = await tvPowerState(ip, port, probe);
    if (current === 'ssh' && await active()) {
      await remember();
      log('TV is awake');
      return;
    }
    if (current !== 'off') last = current;
    await wait(initial === 'on' ? 1000 : 2000);
  }
  if (last === 'on') throw new Error(SSH_CLOSED);
  if (last === 'ssh') throw new Error(`the TV stayed in standby for ${String(seconds)} s`);
  throw new Error(`the TV did not answer within ${String(seconds)} s; check that Wake-on-LAN is enabled on the TV`);
}

async function main() {
  let options;
  try {
    options = parseInputArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`tv-input: ${e.message}`);
    process.exit(2);
  }
  if (options.help) {
    process.stdout.write(INPUT_HELP);
    return;
  }
  if (options.command === 'wake') {
    await wakeTv(options);
    return;
  }
  if (options.command === 'key' && !options.cdp) {
    await evdevBackend(null).key(options.keys, options.gap);
    return;
  }
  const connection = await connectCdpWithAresFallback({
    appId: options.app,
    device: process.env.TV_DEVICE,
    host: resolveConfiguredDeviceIp(),
    port: DEFAULT_PORT,
    target: options.app,
    targetSelection: 'legacy-tv-app',
  });
  const { client } = connection;
  const page = {
    async evaluate(expression) {
      const { result, exceptionDetails } = await client.call('Runtime.evaluate', {
        expression, returnByValue: true,
      });
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
      return result.value;
    },
  };
  try {
    await page.evaluate(TRACKER);
    const backend = options.cdp ? cdpBackend(page, client) : evdevBackend(page);
    switch (options.command) {
      case 'key':
        await backend.key(options.keys, options.gap);
        break;
      case 'move':
        await backend.move(options.to);
        break;
      case 'click':
        if (options.to) await backend.move(options.to);
        await backend.click();
        break;
      case 'wheel':
        await backend.wheel(options.notches, options.gap, options.at);
        break;
      default:
        break;
    }
    if (options.command !== 'key') {
      await sleep(150);
      const pos = await backend.position();
      console.log(`pointer ${pos.x},${pos.y}`);
    }
  } finally {
    connection.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(() => process.exit(0), (e) => {
    console.error(`tv-input: ${e?.message || e}`);
    process.exit(1);
  });
}
