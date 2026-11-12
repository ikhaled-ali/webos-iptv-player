#!/usr/bin/env node
// Evaluate a JS expression inside the running webOS app's page over the Chrome
// DevTools Protocol — the headless counterpart of typing into the console
// `ares-inspect` opens. Use it to probe live app/DOM state from the terminal.
//
// Usage:
//   node scripts/tv-eval.mjs [--app <id>] [--port 9998] '<expression>'
//   node scripts/tv-eval.mjs [--app <id>] --file <path.js>   # read JS from a file
//   node scripts/tv-eval.mjs [--app <id>] -  <<'JS' … JS      # read JS from stdin
// Prefer --file / stdin for anything with backticks or `$` — the shell can't mangle it.
// Put `--` before an inline expression that starts with `-`.
// IP comes from `ares-setup-device` (default device, or TV_DEVICE=<name>).
// The expression must return a JSON-serializable value (strings, numbers, plain
// objects) — DOM nodes and the like can't cross the protocol, so JSON.stringify
// what you need:
//   scripts/tv.sh eval --app <id> 'JSON.stringify(<expression>)'
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { formatOptions, parseArgs } from './cli-args.mjs';
import {
  connectCdpWithAresFallback,
  resolveConfiguredDeviceIp,
} from './cdp-client.mjs';

const DEFAULT_APP_ID = 'com.ikhaled.iptv';
const DEFAULT_PORT = 9998;

const usage = 'Usage: tv-eval.mjs [--app <id>] [--port '
  + `${String(DEFAULT_PORT)}] ('<expression>' | --file <path.js> | -)`;

export const EVAL_SPEC = {
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
    file: {
      type: 'string',
      short: 'f',
      default: '',
      valueName: '<path.js>',
      description: 'Read the expression from a file, or from stdin with -',
    },
    help: { type: 'boolean', short: 'h', default: false, description: 'Show this help' },
  },
};

export const EVAL_HELP = `${usage}

Evaluate a JavaScript expression in the running app's page over CDP. Pass -
instead of an expression to read it from stdin, and put -- before an inline
expression that starts with -.

${formatOptions(EVAL_SPEC)}`;

// Everything that isn't a recognized flag (or a flag's value) is the expression.
function parseEvalArgs(argv) {
  const { values, positionals } = parseArgs(argv, EVAL_SPEC);
  return {
    appId: values.app,
    port: values.port,
    file: values.file,
    expression: positionals.join(' '),
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
    options = parseEvalArgs(argv);
  } catch (e) {
    console.error(`tv-eval: ${toErrorMessage(e)}`);
    return 2;
  }
  if (options.help) {
    console.log(EVAL_HELP);
    return 0;
  }
  const { appId, port, file } = options;
  // Source the JS from `--file <path>` / `-f <path>`, stdin (`-`, e.g. a heredoc), or the
  // positional arg. A file/stdin reads the bytes directly, so backticks / `$` / `${…}` in the
  // expression survive — the shell never sees them (unlike inlining `"$(cat foo.js)"`).
  let expression;
  try {
    if (file) expression = readFileSync(file === '-' ? 0 : file, 'utf-8');
    else if (options.expression === '-') expression = readFileSync(0, 'utf-8');
    else expression = options.expression;
  } catch (e) {
    console.error(`tv-eval: cannot read ${file || 'stdin'}: ${e.message}`);
    return 2;
  }
  if (!expression.trim()) {
    console.error(`tv-eval: no expression given.\n${usage}`);
    return 2;
  }

  // Resolve the device IP from ares-setup-device (no secrets needed for CDP).
  let ip;
  try {
    ip = resolveConfiguredDeviceIp();
  } catch (e) {
    console.error(`tv-eval: ${toErrorMessage(e)}`);
    return 1;
  }

  let connection;
  let exitCode = 0;
  try {
    connection = await connectCdpWithAresFallback({
      appId,
      device: process.env.TV_DEVICE,
      host: ip,
      port,
      target: appId,
      targetSelection: 'legacy-tv-app',
    });
    const { client } = connection;

    // awaitPromise resolves an async expression; returnByValue ships the result
    // back as JSON rather than a remote handle.
    const { result, exceptionDetails } = await client.call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) {
      console.error(`tv-eval: ${exceptionDetails.exception?.description || exceptionDetails.text}`);
      exitCode = 1;
    } else {
      if (result.type === 'undefined') console.log('undefined');
      else if (result.value !== undefined && typeof result.value === 'object') {
        console.log(JSON.stringify(result.value, null, 2));
      } else {
        console.log(String(result.value ?? result.description ?? ''));
      }
    }
  } catch (e) {
    console.error(`tv-eval: ${toErrorMessage(e)}`);
    exitCode = 1;
  } finally {
    connection?.close();
  }
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv.slice(2)));
}
