#!/usr/bin/env node
// Copies dist/ into the folder the webOS TV Simulator runs, then undoes the
// Simulator's own injected stylesheet in that copy only:
//   * { font-family: "LG Display-Regular"; font-weight: 400 !important; }
// A real TV injects nothing, so the shipped bundle must not carry this.
import { cpSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const target = process.argv[2] || join(homedir(), '.webos-sim-app');

rmSync(target, { recursive: true, force: true });
cpSync('dist', target, { recursive: true });

const cssDir = join(target, 'css');
for (const name of readdirSync(cssDir)) {
  if (!name.endsWith('.css')) continue;
  const file = join(cssDir, name);
  // Any selector outranks `*`, so an important weight wins the cascade back.
  // @font-face descriptors stay untouched: `!important` there voids the face.
  let css = readFileSync(file, 'utf8')
    .split(/(@font-face\s*\{[^}]*\})/)
    .map((part) => (part.startsWith('@font-face')
      ? part
      : part.replace(/(font-weight\s*:\s*[^;}!]+?)\s*(?=[;}])/g, '$1 !important')))
    .join('');
  if (name === 'main.css') css += '\nhtml * { font-family: inherit; }\n';
  writeFileSync(file, css);
}

console.log(`Simulator bundle synced to ${target}`);
