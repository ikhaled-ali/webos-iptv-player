import * as esbuild from 'esbuild';
import { createHash } from 'crypto';
import { cpSync, readFileSync, writeFileSync, readdirSync, rmSync, mkdirSync } from 'fs';
import {
  MIN_CHROME,
  scanBundle,
  formatViolations,
} from './scripts/compat-gate.mjs';
import { validateShakaBundle } from './scripts/shaka-compat-gate.mjs';
import { writeThirdPartyNotices } from './scripts/third-party-notices.mjs';
import {
  mirrorStylesheetForRtl,
  rebaseRelativeUrls,
  scaleFontSizes,
} from './scripts/css-transforms.mjs';

const isPreview = process.argv.includes('--preview');
// Read version from package.json (single source of truth)
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;

// Sync version to appinfo.json
const appinfo = JSON.parse(readFileSync('appinfo.json', 'utf8'));
if (appinfo.version !== version) {
  appinfo.version = version;
  writeFileSync('appinfo.json', JSON.stringify(appinfo, null, 2) + '\n');
}

function transformStylesheets(outDir) {
  for (const file of readdirSync(outDir)) {
    if (!file.endsWith('.css')) continue;
    const path = `${outDir}/${file}`;
    writeFileSync(path, scaleFontSizes(readFileSync(path, 'utf8')));
  }
  // Mirrored copies for right-to-left languages, built from the final CSS.
  mkdirSync(`${outDir}/rtl`, { recursive: true });
  for (const file of readdirSync(outDir)) {
    if (!file.endsWith('.css')) continue;
    const mirrored = mirrorStylesheetForRtl(readFileSync(`${outDir}/${file}`, 'utf8'));
    writeFileSync(`${outDir}/rtl/${file}`, rebaseRelativeUrls(mirrored, '../'));
  }
}

// Copy static assets to dist. The source HTML is the production/webOS version;
// preview builds swap only the platform library at build time.
mkdirSync('dist', { recursive: true });
const indexHtml = readFileSync('index.html', 'utf8');
const previewLibsMarker = '<!-- preview-libs -->';
const outputIndexHtml = indexHtml.replace(
  previewLibsMarker,
  isPreview ? '<script src="js/preview-libs.js"></script>' : '',
);
if (outputIndexHtml === indexHtml) {
  throw new Error('Build could not find the preview library marker in index.html.');
}
writeFileSync('dist/index.html', outputIndexHtml);
rmSync('dist/resources', { recursive: true, force: true });
cpSync('resources', 'dist/resources', { recursive: true });
cpSync('css', 'dist/css', { recursive: true });
transformStylesheets('dist/css');
// The TV launcher caches an app's icon by path, so a new icon only shows
// under a new file name: name each after its content.
const iconHash = createHash('sha1')
  .update(readFileSync('assets/icon80.png'))
  .update(readFileSync('assets/icon130.png'))
  .digest('hex').slice(0, 8);
const icon = `icon-${iconHash}.png`;
const largeIcon = `largeIcon-${iconHash}.png`;
// The launch splash, likewise: scripts/build-splash.mjs renders it from the
// boot screen, so the TV hands off to the app without the logo moving.
const splashHash = createHash('sha1').update(readFileSync('assets/splash.png')).digest('hex').slice(0, 8);
const splashBackground = `splash-${splashHash}.png`;
for (const file of readdirSync('dist')) {
  if (/^(icon|largeIcon|splash)(-[0-9a-f]+)?\.png$/.test(file)) rmSync(`dist/${file}`);
}
cpSync('assets/icon80.png', `dist/${icon}`);
cpSync('assets/icon130.png', `dist/${largeIcon}`);
cpSync('assets/splash.png', `dist/${splashBackground}`);
writeFileSync('dist/appinfo.json', JSON.stringify({ ...appinfo, icon, largeIcon, splashBackground }, null, 2) + '\n');
cpSync('assets/icons', 'dist/assets/icons', { recursive: true });
cpSync('assets/fonts', 'dist/assets/fonts', { recursive: true });

// Main app bundle — playback libraries remain separate. Shaka is shipped as a
// lazy TV bundle for Widevine and is also used by the desktop preview.
const serviceId = JSON.parse(readFileSync('bundled-service/src/services.json', 'utf8')).id;
const define = {
  '__APP_VERSION__': JSON.stringify(version),
  '__APP_ID__': JSON.stringify(appinfo.id),
  '__SERVICE_ID__': JSON.stringify(serviceId),
  '__ENABLE_PSEUDO_LOCALE__': JSON.stringify(isPreview),
};
// Target the oldest supported engine, Chromium 94 on webOS 23: newer syntax
// is down-leveled for it, everything it parses natively ships as written.
const TARGET = [`chrome${MIN_CHROME}`];

// Translations ship one script per language instead of inside app.js, so
// startup parses only the active catalog (src/i18n/index.ts loadLocale).
// Unit tests keep importing every catalog through src/i18n/catalogs.ts.
const lazyCatalogs = {
  name: 'lazy-locale-catalogs',
  setup(build) {
    build.onResolve({ filter: /^\.\/catalogs$/ }, (args) =>
      args.importer.endsWith('src/i18n/index.ts')
        ? { path: new URL('./src/i18n/catalogs-lazy.ts', import.meta.url).pathname }
        : undefined);
  },
};
const LOCALE_CATALOGS = readdirSync('src/i18n')
  .map((file) => /^(?!en\.)([a-z]{2}(?:-[A-Z]{2})?)\.ts$/.exec(file)?.[1])
  .filter(Boolean)
  .map((locale) => ({
    locale,
    exportName: /export const ([A-Z_]+_MESSAGES)\b/.exec(
      readFileSync(`src/i18n/${locale}.ts`, 'utf8'))?.[1],
  }))
  .filter(({ exportName }) => exportName);
rmSync('dist/js/locales', { recursive: true, force: true });

// Shared config for the main app bundle (src/app.ts). The shipped build and
// compat-gate scan use the same tree-shaken graph.
const appBuild = {
  entryPoints: ['src/app.ts'],
  bundle: true,
  outfile: 'dist/js/app.js',
  format: 'iife',
  target: TARGET,
  external: ['hls.js', 'mpegts.js', 'shaka-player'],
  define,
  plugins: [lazyCatalogs],
};
const workerBuild = {
  entryPoints: ['src/workers/app-worker.ts'],
  bundle: true,
  outfile: 'dist/js/app-worker.js',
  format: 'iife',
  target: TARGET,
  define,
};
const localeBuilds = LOCALE_CATALOGS.map(({ locale, exportName }) => ({
  name: `${locale} locale`,
  config: {
    stdin: {
      contents: `import { ${exportName} } from './${locale}';\n`
        + `((self.__IPTV_LOCALES__ = self.__IPTV_LOCALES__ || {}))[${JSON.stringify(locale)}] = ${exportName};\n`,
      resolveDir: 'src/i18n',
      loader: 'ts',
    },
    bundle: true,
    outfile: `dist/js/locales/${locale}.js`,
    format: 'iife',
    target: TARGET,
    define,
  },
}));
const shippedBuilds = [
  ...localeBuilds,
  { name: 'app', config: appBuild },
  { name: 'worker', config: workerBuild },
  { name: 'optional players', config: {
    entryPoints: ['src/preview-libs.ts'],
    bundle: true,
    outfile: isPreview ? 'dist/js/preview-libs.js' : 'dist/js/player-libs.js',
    format: 'iife',
    target: TARGET,
  } },
];

// Shipped bundles (minified, all go into the IPK).
const bundled = await Promise.all(shippedBuilds.map(({ config }) =>
  esbuild.build({ ...config, minify: true, metafile: true })));

const shakaBundle = readFileSync('node_modules/shaka-player/dist/shaka-player.dash.js', 'utf8');
validateShakaBundle(shakaBundle);
writeFileSync('dist/js/shaka-player.dash.js', shakaBundle);

// webOS 23 (Chromium 94) bundle compat gate. Down-leveling handles newer
// *syntax*, but not *APIs* — and dependencies get bundled in without passing
// through the eslint source gate. Scan a NON-minified build of the same entry
// (same tree-shaken graph, readable identifiers) for banned APIs.
for (const { name, config } of shippedBuilds) {
  const scan = await esbuild.build({ ...config, minify: false, write: false });
  const violations = scanBundle(scan.outputFiles[0].text);
  if (violations.length > 0) {
    throw new Error(`${name} bundle:\n${formatViolations(violations)}`);
  }
}
console.log(`Compat gate: app, worker, optional players and Shaka bundles are Chromium-${MIN_CHROME} clean.`);

// Preview loads its player libraries eagerly; production loads them on demand.
if (!isPreview) {
  rmSync('dist/js/preview-libs.js', { force: true });
} else {
  rmSync('dist/js/player-libs.js', { force: true });
}

writeThirdPartyNotices({
  outDir: 'dist',
  metafiles: bundled.map(({ metafile }) => metafile),
});

console.log('Build complete.');
