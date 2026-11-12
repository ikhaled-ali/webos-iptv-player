#!/usr/bin/env node
// Stream the webOS app's DevTools console to the terminal over the Chrome
// DevTools Protocol — the same console `ares-inspect` shows in its GUI, but
// headless so it can be captured without copy-pasting out of a browser tab.
//
// Usage:
//   node scripts/tv-logs.mjs [--app <id>] [--port 9998] [--seconds N] [--history]
// IP comes from `ares-setup-device` (default device, or TV_DEVICE=<name>).
import { pathToFileURL } from 'node:url';
import { formatOptions, parseArgs } from './cli-args.mjs';
import {
  connectCdpWithAresFallback,
  resolveConfiguredDeviceIp,
} from './cdp-client.mjs';
import {
  enableCdpLogs,
  normalizeCdpLogEvent,
  subscribeCdpLogs,
} from './cdp-logs.mjs';

const DEFAULT_APP_ID = 'com.ikhaled.iptv';
const DEFAULT_PORT = 9998;
const DEFAULT_SECONDS = 0;

const usage = 'Usage: tv-logs.mjs [--app <id>] [--port '
  + `${String(DEFAULT_PORT)}] [--seconds N] [--history]`;

export const LOGS_SPEC = {
  maxPositionals: 0,
  options: {
    app: {
      type: 'string',
      default: DEFAULT_APP_ID,
      valueName: '<id>',
      description: 'webOS app id',
    },
    port: {
      type: 'integer',
      min: 1,
      max: 65535,
      default: DEFAULT_PORT,
      valueName: '<port>',
      description: 'CDP discovery port',
    },
    seconds: {
      type: 'integer',
      min: 0,
      default: DEFAULT_SECONDS,
      valueName: '<n>',
      description: 'Stop after <n> seconds; 0 streams until interrupted',
    },
    history: {
      type: 'boolean',
      default: false,
      description: 'Also stream browser log entries, including earlier ones',
    },
    help: { type: 'boolean', short: 'h', default: false, description: 'Show this help' },
  },
};

export const LOGS_HELP = `${usage}

Stream the app's DevTools console to the terminal over CDP.

${formatOptions(LOGS_SPEC)}`;

function parseLogsArgs(argv) {
  const { values } = parseArgs(argv, LOGS_SPEC);
  return {
    appId: values.app,
    port: values.port,
    seconds: values.seconds,
    history: values.history,
    help: values.help,
  };
}

const toErrorMessage = (value) => {
  if (value instanceof Error && value.message) return value.message;
  if (typeof value?.message === 'string' && value.message) return value.message;
  return String(value);
};

async function main(argv) {
  let options;
  try {
    options = parseLogsArgs(argv);
  } catch (e) {
    console.error(`tv-logs: ${toErrorMessage(e)}`);
    process.exit(2);
  }
  if (options.help) {
    console.log(LOGS_HELP);
    process.exit(0);
  }
  const { appId, port, seconds, history } = options;

  // Resolve the device IP from ares-setup-device (no secrets needed for CDP).
  let ip;
  try {
    ip = resolveConfiguredDeviceIp();
  } catch (e) {
    console.error(`tv-logs: ${toErrorMessage(e)}`);
    process.exit(1);
  }

  let connection;
  try {
    connection = await connectCdpWithAresFallback({
      appId,
      device: process.env.TV_DEVICE,
      host: ip,
      port,
      target: appId,
      targetSelection: 'legacy-tv-app',
    });
  } catch (e) {
    console.error(`tv-logs: ${toErrorMessage(e)}`);
    process.exit(1);
  }

  const { client, target: page } = connection;
  console.error(`tv-logs: attached to "${page?.title || ''}" (${page?.description || page?.url || ''})`);

  subscribeCdpLogs(client, (method, params) => {
    const event = normalizeCdpLogEvent(method, params);
    const stamp = new Date(event.observedAt).toTimeString().slice(0, 8);
    if (event.source === 'console') {
      const tag = event.level === 'log' ? '' : `.${event.level}`;
      console.log(`${stamp} [console${tag}] ${event.text}`);
    } else if (event.source === 'exception') {
      console.log(`${stamp} [exception] ${event.text}`);
    } else {
      console.log(`${stamp} [${event.level}] ${event.text}`);
    }
  });
  client.socket.addEventListener('error', (event) => {
    console.error('tv-logs: ws error', event.message || event);
  });
  client.socket.addEventListener('close', () => {
    connection.close();
    process.exit(0);
  });

  void enableCdpLogs(client, { history }).catch((error) => {
    console.error(`tv-logs: ${toErrorMessage(error)}`);
    client.close();
  });

  if (seconds > DEFAULT_SECONDS) setTimeout(() => connection.close(), seconds * 1000);
  process.on('SIGINT', () => connection.close());
  process.on('SIGTERM', () => connection.close());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
