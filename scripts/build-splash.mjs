// Renders the native launch splash (appinfo.json `splashBackground`) from the
// app's own boot screen: the loading view's markup and stylesheets at rest,
// with the progress bar and status text held invisible so the mark sits
// exactly where the app's splash draws it. The TV then hands off to the app
// without the logo moving.
import { readFileSync, writeFileSync, rmSync } from 'fs';
import { chromium } from 'playwright';

const indexHtml = readFileSync('index.html', 'utf8');
const start = indexHtml.indexOf('<div id="view-loading"');
const end = indexHtml.indexOf('<div id="view-channels"');
if (start < 0 || end < 0) throw new Error('index.html: loading view not found');
const loadingView = indexHtml.slice(start, end);

const page = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<link rel="stylesheet" href="css/main.css">
<link rel="stylesheet" href="css/tab-bar.css">
<style>
  *, *::before, *::after { animation: none !important; transition: none !important; }
  .splash-progress, .loading-text { visibility: hidden; }
</style>
</head><body>${loadingView}</body></html>`;

const tmp = '.splash-render.html';
writeFileSync(tmp, page);
const browser = await chromium.launch();
try {
  const tab = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await tab.goto(`file://${process.cwd()}/${tmp}`);
  await tab.evaluate(() => document.fonts.ready);
  writeFileSync('assets/splash.png', await tab.screenshot({ type: 'png' }));
  console.log('assets/splash.png (1920x1080)');
} finally {
  await browser.close();
  rmSync(tmp);
}
