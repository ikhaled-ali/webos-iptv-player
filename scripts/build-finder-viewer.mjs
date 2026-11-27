// Builds the signal finder's phone page into one self-contained HTML file:
// src/finder-viewer/index.html with viewer.ts bundled inline. The GitHub
// Pages workflow publishes it at <pages>/finder/.
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const [outputPath = '_site/finder/index.html'] = process.argv.slice(2);
const MARKER = '<!-- VIEWER_SCRIPT -->';

const result = await build({
  entryPoints: ['src/finder-viewer/viewer.ts'],
  bundle: true,
  minify: true,
  format: 'iife',
  // Phones, not the TV: any browser from the last few years.
  target: ['es2019', 'safari13', 'chrome80'],
  write: false,
  legalComments: 'none',
});

const template = await readFile('src/finder-viewer/index.html', 'utf8');
if (!template.includes(MARKER)) throw new Error(`${MARKER} missing from the viewer template`);
const script = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const page = template.replace(MARKER, () => `<script>${script}</script>`);

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, page);
console.log(`Finder viewer written to ${outputPath} (${String(Math.round(page.length / 1024))} KB)`);
