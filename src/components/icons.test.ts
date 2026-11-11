import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { APP_LOGO } from './icons';

const asset = readFileSync(join(process.cwd(), 'assets/icon.svg'), 'utf8');
const all = (svg: string, re: RegExp) => Array.from(svg.matchAll(re), (m) => m[1]);

describe('APP_LOGO', () => {
  it('draws the same shapes and colors as the app icon asset', () => {
    for (const re of [/ d="([^"]+)"/g, /cx="([^"]+)"/g, / r="([^"]+)"/g, / y="([^"]+)"/g]) {
      expect(all(APP_LOGO, re)).toEqual(all(asset, re));
    }
    // The in-app mark drops the launcher tile, so only the tile's fill differs.
    const fills = /fill="(#[^"]+)"/g;
    expect(all(APP_LOGO, fills)).toEqual(all(asset, fills).slice(1));
  });

  it('prefixes every id it defines and references only those ids', () => {
    const ids = all(APP_LOGO, /id="([^"]+)"/g);
    for (const id of ids) expect(id.startsWith('app-logo-')).toBe(true);
    for (const ref of all(APP_LOGO, /url\(#([^)]+)\)/g)) expect(ids).toContain(ref);
  });
});
