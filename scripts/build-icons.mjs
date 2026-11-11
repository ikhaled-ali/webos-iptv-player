// Renders assets/icon.svg to the launcher PNGs. The files keep their webOS
// slot names (80 and 130) but hold about twice the pixels the launcher
// draws (its home row shows the large icon at ~115px): the launcher scales
// with a cheap filter, so an exact-size file is soft and a much larger one
// comes out jagged.
import { readFileSync, writeFileSync } from 'fs';
import { chromium } from 'playwright';

const svg = readFileSync('assets/icon.svg', 'utf8');
const browser = await chromium.launch();
for (const [name, size] of [['icon80', 160], ['icon130', 230]]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<style>html,body{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  writeFileSync(`assets/${name}.png`, await page.screenshot({ type: 'png' }));
  await page.close();
  console.log(`assets/${name}.png (${size}x${size})`);
}
await browser.close();
